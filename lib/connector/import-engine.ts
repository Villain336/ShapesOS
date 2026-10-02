// Marketr — Connector Agent slice 2: import engine.
//
// Consent-gated, exclusion-filtered, incremental provider imports.
//
// THE LAW (SPEC-CONNECTOR-AGENT.md §3, governed action import_network):
//   1. No import runs without a recorded per-source consent grant
//      (ConnectorSourceConsent). The money test proves this.
//   2. Exclusion lists are applied BEFORE any Person row is created —
//      an excluded contact never becomes a Person.
//   3. Incremental: re-imports fetch only changes since the last completed
//      batch's cursor; dedup on (source, externalId).
//   4. Provenance: every imported Person carries importBatchId +
//      consentedBy + consentedAt, copied from the consent grant at run
//      start (the batch is the receipt, the consent record is the gate).
//
// Provider access reuses the OS connector layer: the tenant's OAuth
// connection (ConnectorConnection + vault credential) is resolved to the
// native adapter (gmail / google-calendar), which returns aggregated
// network contacts. No parallel OAuth system.

import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PrismaConnectorStore } from "./prisma-store";
import {
  CONNECTOR_IMPORT_SOURCE_KEYS,
  CONNECTOR_PROVIDER_SOURCES,
  ConnectorError,
  buildExternalId,
  exclusionMatches,
  type ConnectorImportBatchView,
  type ConnectorImportSource,
  type ConnectorImportStats,
  type ConnectorSourceConsentView,
} from "./types";
import { getAdapterForConnection } from "@/lib/connectors/m21";
import { getDecryptedCredential } from "@/lib/vault/refresh";

export interface RawImportContact {
  email: string;
  name: string | null;
  interactionCount: number;
  inboundCount: number;
  outboundCount: number;
  lastInteractionAt: Date | null;
}

export interface FetchContactsInput {
  source: ConnectorImportSource;
  connectorKey: string;
  /** The last completed batch's cursor (ISO date), or null for full import. */
  since: string | null;
  workspaceId: string;
  userId: string;
}

export interface FetchContactsResult {
  contacts: RawImportContact[];
  /** Provider-side cursor; falls back to max lastInteractionAt. */
  cursor: string | null;
}

export type ContactsFetcher = (
  input: FetchContactsInput,
) => Promise<FetchContactsResult>;

const EMAIL_LIKE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Default fetcher: live provider via the tenant's active OAuth connection.
 * Fails closed (not_connected / provider_fetch_failed) — never returns
 * mock data as real contacts.
 */
export async function liveContactsFetcher(
  input: FetchContactsInput,
): Promise<FetchContactsResult> {
  const connection = await prisma.connectorConnection.findFirst({
    where: {
      workspaceId: input.workspaceId,
      connectorKey: input.connectorKey,
      status: "active",
    },
    select: { id: true },
  });
  if (!connection) {
    throw new ConnectorError(
      "not_connected",
      `No active ${input.connectorKey} connection in this workspace. Connect the source before importing.`,
    );
  }
  const credential = await getDecryptedCredential(connection.id);
  if (!credential) {
    throw new ConnectorError(
      "not_connected",
      `The ${input.connectorKey} connection has no usable credential. Reconnect the source.`,
    );
  }
  const adapter = await getAdapterForConnection({
    connectorKey: input.connectorKey,
  });
  const res = await adapter.invoke(
    "list_network_contacts",
    input.since ? { since: input.since } : {},
    credential,
    { workspaceId: input.workspaceId, userId: input.userId },
  );
  if (!res.ok || res.mock) {
    throw new ConnectorError(
      "provider_fetch_failed",
      res.error ?? "The provider did not return contact data.",
    );
  }
  const data = res.data as {
    contacts?: Array<{
      email?: string;
      name?: string | null;
      interactionCount?: number;
      inboundCount?: number;
      outboundCount?: number;
      lastInteractionAt?: string | null;
    }>;
    cursor?: string | null;
  };
  const contacts: RawImportContact[] = (data.contacts ?? []).map((c) => {
    const at =
      typeof c.lastInteractionAt === "string" ? new Date(c.lastInteractionAt) : null;
    return {
      email: (c.email ?? "").trim().toLowerCase(),
      name: typeof c.name === "string" && c.name.trim() ? c.name.trim() : null,
      interactionCount: Math.max(0, Math.floor(Number(c.interactionCount) || 0)),
      inboundCount: Math.max(0, Math.floor(Number(c.inboundCount) || 0)),
      outboundCount: Math.max(0, Math.floor(Number(c.outboundCount) || 0)),
      lastInteractionAt: at && !Number.isNaN(at.getTime()) ? at : null,
    };
  });
  return { contacts, cursor: data.cursor ?? null };
}

export interface RunImportOptions {
  workspaceId: string;
  userId: string;
  source: ConnectorImportSource;
  now?: Date;
  /** Test seam: inject a fake provider. Defaults to the live fetcher. */
  fetcher?: ContactsFetcher;
  prisma?: PrismaClient;
}

/**
 * Run one import for (workspace, source). Consent-gated: throws no_consent
 * when no ConnectorSourceConsent row exists — before any batch or Person
 * row is written.
 */
export async function runImport(
  opts: RunImportOptions,
): Promise<ConnectorImportBatchView> {
  const now = opts.now ?? new Date();
  const { workspaceId, userId, source } = opts;
  const store = new PrismaConnectorStore(opts.prisma ?? prisma);

  if (!CONNECTOR_PROVIDER_SOURCES.includes(source)) {
    throw new ConnectorError(
      "invalid_source",
      `Provider imports support: ${CONNECTOR_PROVIDER_SOURCES.join(", ")}.`,
    );
  }
  const connectorKey = CONNECTOR_IMPORT_SOURCE_KEYS[source];
  if (!connectorKey) {
    throw new ConnectorError(
      "invalid_source",
      `Source "${source}" has no provider import path.`,
    );
  }

  // THE GATE — before anything is written.
  const consent = await store.getSourceConsent(workspaceId, source);
  if (!consent) {
    throw new ConnectorError(
      "no_consent",
      `No consent recorded for ${source} in this workspace. Record consent before importing — no import runs without it.`,
    );
  }

  // The batch is the receipt: provenance copied from the consent grant.
  const batch = await store.createImportBatch(workspaceId, {
    source,
    consentedBy: consent.consentedBy,
    consentedAt: consent.consentedAt,
    note: `Provider import (${connectorKey})`,
  });
  await store.updateImportBatch(workspaceId, batch.id, { status: "running" });

  const stats: ConnectorImportStats = {
    fetched: 0,
    created: 0,
    merged: 0,
    dedupSkipped: 0,
    excludedSkipped: 0,
    staleSkipped: 0,
    errors: [],
  };

  try {
    const [exclusions, since] = await Promise.all([
      store.listExclusions(workspaceId),
      store.getImportCursor(workspaceId, source),
    ]);
    const sinceDate = since ? new Date(since) : null;
    const sinceValid = sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : null;

    const fetcher = opts.fetcher ?? liveContactsFetcher;
    const result = await fetcher({
      source,
      connectorKey,
      since: sinceValid ? sinceValid.toISOString() : null,
      workspaceId,
      userId,
    });
    stats.fetched = result.contacts.length;

    let invalidEmails = 0;
    let cursorDate: Date | null = sinceValid;
    const seenInBatch = new Set<string>();

    for (const raw of result.contacts) {
      const email = raw.email.trim().toLowerCase();
      if (!EMAIL_LIKE_RE.test(email)) {
        invalidEmails += 1;
        continue;
      }
      // Incremental staleness guard (providers filter day-granular).
      if (
        sinceValid &&
        (!raw.lastInteractionAt || raw.lastInteractionAt.getTime() <= sinceValid.getTime())
      ) {
        stats.staleSkipped += 1;
        continue;
      }
      // EXCLUSIONS — before any Person row is created. An excluded
      // contact never becomes a Person.
      const hit = exclusionMatches(exclusions, { email, name: raw.name });
      if (hit) {
        stats.excludedSkipped += 1;
        continue;
      }
      const externalId = buildExternalId(source, email);
      if (seenInBatch.has(externalId)) {
        stats.dedupSkipped += 1;
        continue;
      }
      seenInBatch.add(externalId);

      const signals = {
        touchCount: raw.interactionCount,
        inboundCount: raw.inboundCount,
        outboundCount: raw.outboundCount,
        lastTouchAt: raw.lastInteractionAt,
      };

      const existing = await store.findPersonByExternalId(workspaceId, externalId);
      if (existing) {
        // Dedup hit: merge ONLY genuinely newer signal. Anything at or
        // below the stored last touch is a duplicate, not a merge.
        const detail = await store.getPersonDetail(workspaceId, existing.id, now);
        const storedLast = detail?.relationship?.lastTouchAt ?? null;
        const isNewer =
          raw.lastInteractionAt != null &&
          (storedLast == null || raw.lastInteractionAt.getTime() > storedLast.getTime());
        if (isNewer) {
          await store.addRelationshipSignals(workspaceId, existing.id, signals, now);
          stats.merged += 1;
        } else {
          stats.dedupSkipped += 1;
        }
      } else {
        const person = await store.addPerson(workspaceId, {
          name: raw.name ?? email.split("@")[0],
          roles: [],
          handles: [email],
          importBatchId: batch.id,
          consentedBy: consent.consentedBy,
          consentedAt: consent.consentedAt,
          externalId,
        });
        await store.addRelationshipSignals(workspaceId, person.id, signals, now);
        stats.created += 1;
      }

      if (raw.lastInteractionAt && (!cursorDate || raw.lastInteractionAt > cursorDate)) {
        cursorDate = raw.lastInteractionAt;
      }
    }

    if (invalidEmails > 0) {
      stats.errors.push(
        `${invalidEmails} contact${invalidEmails === 1 ? "" : "s"} had no usable email address and were skipped.`,
      );
    }

    const cursor = result.cursor ?? (cursorDate ? cursorDate.toISOString() : since);
    return await store.updateImportBatch(workspaceId, batch.id, {
      status: "completed",
      cursor,
      stats,
      completedAt: now,
    });
  } catch (err) {
    const message =
      err instanceof ConnectorError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Import failed.";
    await store.updateImportBatch(workspaceId, batch.id, {
      status: "failed",
      error: message,
      stats,
      completedAt: now,
    });
    throw err instanceof ConnectorError
      ? err
      : new ConnectorError("import_failed", message);
  }
}

/** Import-source overview for the UI: consent + connection + last batch. */
export interface ImportSourceStatus {
  source: ConnectorImportSource;
  connectorKey: string;
  displayName: string;
  consent: ConnectorSourceConsentView | null;
  connectionStatus: "active" | "needs_reauth" | "revoked" | null;
  lastBatch: ConnectorImportBatchView | null;
}

const SOURCE_DISPLAY: Record<string, string> = {
  email: "Gmail",
  calendar: "Google Calendar",
};

export async function getImportSourcesStatus(
  workspaceId: string,
  prismaClient: PrismaClient = prisma,
): Promise<ImportSourceStatus[]> {
  const store = new PrismaConnectorStore(prismaClient);
  const out: ImportSourceStatus[] = [];
  for (const source of CONNECTOR_PROVIDER_SOURCES) {
    const connectorKey = CONNECTOR_IMPORT_SOURCE_KEYS[source] as string;
    const [consent, connection, batches] = await Promise.all([
      store.getSourceConsent(workspaceId, source),
      prismaClient.connectorConnection.findFirst({
        where: { workspaceId, connectorKey },
        orderBy: { connectedAt: "desc" },
        select: { status: true },
      }),
      store.listImportBatches(workspaceId),
    ]);
    out.push({
      source,
      connectorKey,
      displayName: SOURCE_DISPLAY[source] ?? source,
      consent,
      connectionStatus: connection?.status ?? null,
      lastBatch: batches.find((b) => b.source === source) ?? null,
    });
  }
  return out;
}
