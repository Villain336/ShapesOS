// ShapesOS — Phase 11 (bizsync): the id-mapping table and run log shared by
// the Shopify, QuickBooks Online and Xero connectors.
//
// biz_sync_links holds ONE row per mapped object and provider (unique on both
// the remote and the local id), so a re-sync never duplicates. Each row keeps
// the remote updatedAt and a fingerprint of the local mapped fields as of the
// last sync; applyPulled() turns those into the shared conflict rule
// (lib/connectors/sync-conflict.ts):
//   remote changed = remote updatedAt is newer than the remembered one
//   local changed  = the local mapped fields' fingerprint differs from the
//                    remembered one (not updatedAt: a stock move bumps a
//                    product's updatedAt but is not a catalogue edit)
// and then: only remote → apply; only local → keep ("local_ahead"); both →
// newer timestamp wins and is reported; neither → unchanged. A first match
// (dedupe onto an existing local row, no link yet) counts as both changed.
//
// biz_sync_runs: recordRun() wraps every sync / export so the settings page
// can show status, last run and the last error.

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { decideSync, type SyncDecision } from "@/lib/connectors/sync-conflict";
import { scrubMessage } from "@/lib/connectors/m21/live/http";

// Phase 14 (connectors): + gusto (employee ↔ team member links, objectType
// "employee"; a person confirms each one — meta.confirmed).
export type BizProvider = "shopify" | "quickbooks" | "xero" | "gusto";
export const BIZ_PROVIDERS: readonly BizProvider[] = ["shopify", "quickbooks", "xero", "gusto"];

type Tx = Prisma.TransactionClient;

/** Stable JSON (sorted keys) for fingerprints. PURE. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

/** sha256 fingerprint of a record's mapped fields. PURE. */
export function fingerprint(fields: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(fields)).digest("hex").slice(0, 40);
}

export interface LinkRow {
  id: string;
  remoteId: string;
  localId: string;
  remoteUpdatedAt: Date | null;
  localHash: string | null;
  localUpdatedAt: Date | null;
  meta: unknown;
}

export async function findLink(
  tx: Tx,
  workspaceId: string,
  provider: BizProvider,
  objectType: string,
  by: { remoteId: string } | { localId: string },
): Promise<LinkRow | null> {
  return tx.bizSyncLink.findFirst({ where: { workspaceId, provider, objectType, ...by } });
}

export async function saveLink(
  tx: Tx,
  workspaceId: string,
  provider: BizProvider,
  objectType: string,
  remoteId: string,
  localId: string,
  state: { remoteUpdatedAt?: Date | null; localHash?: string | null; localUpdatedAt?: Date | null; meta?: Record<string, unknown> },
  direction: "pull" | "push",
): Promise<LinkRow> {
  const data = {
    localId,
    remoteUpdatedAt: state.remoteUpdatedAt ?? null,
    localHash: state.localHash ?? null,
    localUpdatedAt: state.localUpdatedAt ?? null,
    lastDirection: direction,
    ...(state.meta ? { meta: state.meta as Prisma.InputJsonValue } : {}),
  };
  return tx.bizSyncLink.upsert({
    where: { workspaceId_provider_objectType_remoteId: { workspaceId, provider, objectType, remoteId } },
    create: { workspaceId, provider, objectType, remoteId, ...data },
    update: data,
  });
}

/** Changed-since-last-sync flags for one linked record. PURE. */
export function changesSince(link: Pick<LinkRow, "remoteUpdatedAt" | "localHash"> | null, remoteAt: Date, localHash: string): { remoteChanged: boolean; localChanged: boolean } {
  if (!link) return { remoteChanged: true, localChanged: true };
  return {
    remoteChanged: !link.remoteUpdatedAt || remoteAt.getTime() > link.remoteUpdatedAt.getTime(),
    localChanged: link.localHash !== localHash,
  };
}

export interface SyncConflict {
  objectType: string;
  remoteId: string;
  localId: string | null;
  resolution: string;
}

export interface SyncReport {
  created: number;
  updated: number;
  linked: number;
  unchanged: number;
  localAhead: number;
  skipped: number;
  conflicts: SyncConflict[];
  notes: string[];
  pages: number;
  truncated: boolean;
}

export const emptyReport = (): SyncReport => ({ created: 0, updated: 0, linked: 0, unchanged: 0, localAhead: 0, skipped: 0, conflicts: [], notes: [], pages: 0, truncated: false });

export function mergeReports(a: SyncReport, b: SyncReport): SyncReport {
  return {
    created: a.created + b.created,
    updated: a.updated + b.updated,
    linked: a.linked + b.linked,
    unchanged: a.unchanged + b.unchanged,
    localAhead: a.localAhead + b.localAhead,
    skipped: a.skipped + b.skipped,
    conflicts: [...a.conflicts, ...b.conflicts],
    notes: [...a.notes, ...b.notes],
    pages: a.pages + b.pages,
    truncated: a.truncated || b.truncated,
  };
}

export type PullOutcome<L> = { local: L | null; decision: SyncDecision | "created" | "taken" };

/**
 * Apply one pulled remote record to its local row per the conflict rule.
 * Runs inside the caller's withWorkspaceScope transaction.
 */
export async function applyPulled<L extends { id: string; updatedAt: Date }>(input: {
  tx: Tx;
  workspaceId: string;
  provider: BizProvider;
  objectType: string;
  remoteId: string;
  remoteAt: Date;
  report: SyncReport;
  /** Fingerprint of the local row's mapped fields. */
  hashOf: (local: L) => string;
  /** The linked row, else a dedupe match (by email, SKU…), else null. */
  findLocal: (link: LinkRow | null) => Promise<L | null>;
  create: () => Promise<L>;
  update: (local: L) => Promise<L>;
  meta?: Record<string, unknown>;
}): Promise<PullOutcome<L>> {
  const { tx, workspaceId, provider, objectType, remoteId, remoteAt, report } = input;
  const link = await findLink(tx, workspaceId, provider, objectType, { remoteId });
  const local = await input.findLocal(link);
  const save = (row: L, remoteUpdatedAt: Date | null) =>
    saveLink(tx, workspaceId, provider, objectType, remoteId, row.id, { remoteUpdatedAt, localHash: input.hashOf(row), localUpdatedAt: row.updatedAt, meta: input.meta }, "pull");
  if (!local) {
    const created = await input.create();
    await save(created, remoteAt);
    report.created += 1;
    return { local: created, decision: "created" };
  }
  if (!link) {
    // A dedupe match must not already belong to another remote record.
    const taken = await findLink(tx, workspaceId, provider, objectType, { localId: local.id });
    if (taken) {
      report.conflicts.push({ objectType, remoteId, localId: local.id, resolution: `already linked to ${provider} ${taken.remoteId}; skipped` });
      return { local: null, decision: "taken" };
    }
    report.linked += 1;
  }
  const { remoteChanged, localChanged } = changesSince(link, remoteAt, input.hashOf(local));
  const decision = decideSync({ remoteChanged, localChanged, remoteAt, localAt: local.updatedAt });
  if (decision === "skip_unchanged") {
    report.unchanged += 1;
    if (input.meta) await saveLink(tx, workspaceId, provider, objectType, remoteId, local.id, { remoteUpdatedAt: link?.remoteUpdatedAt ?? remoteAt, localHash: link?.localHash ?? input.hashOf(local), localUpdatedAt: link?.localUpdatedAt ?? local.updatedAt, meta: input.meta }, "pull");
    return { local, decision };
  }
  if (decision === "local_ahead" || decision === "conflict_local_wins") {
    if (decision === "local_ahead") report.localAhead += 1;
    else report.conflicts.push({ objectType, remoteId, localId: local.id, resolution: `local is newer — kept local` });
    // Remember the remote side we saw; the local side stays "changed" (no hash) until it is pushed or re-pulled.
    if (!link) await saveLink(tx, workspaceId, provider, objectType, remoteId, local.id, { remoteUpdatedAt: remoteAt, localHash: null, localUpdatedAt: null, meta: input.meta }, "pull");
    return { local, decision };
  }
  if (decision === "conflict_remote_wins") {
    report.conflicts.push({ objectType, remoteId, localId: local.id, resolution: `${provider} is newer — applied ${provider}'s values` });
  }
  const updated = await input.update(local);
  await save(updated, remoteAt);
  report.updated += 1;
  return { local: updated, decision };
}

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

export type RunStatus = "running" | "succeeded" | "partial" | "failed";

/** Status of a finished run from its result. PURE. */
export function runStatusOf(result: unknown): RunStatus {
  const r = (result ?? {}) as { conflicts?: unknown[]; failed?: number; truncated?: boolean };
  if ((typeof r.failed === "number" && r.failed > 0) || (Array.isArray(r.conflicts) && r.conflicts.length > 0) || r.truncated) return "partial";
  return "succeeded";
}

/** Run `fn` with a biz_sync_runs row around it (status, summary, error). */
export async function recordRun<T>(
  workspaceId: string,
  provider: BizProvider,
  operation: string,
  actor: string,
  fn: () => Promise<T>,
): Promise<T> {
  const run = await withWorkspaceScope(workspaceId, (tx) =>
    tx.bizSyncRun.create({ data: { workspaceId, provider, operation: operation.slice(0, 60), actor: actor.slice(0, 200) } }),
  );
  try {
    const result = await fn();
    const summary = JSON.parse(JSON.stringify(result ?? {})) as Prisma.InputJsonValue;
    await withWorkspaceScope(workspaceId, (tx) =>
      tx.bizSyncRun.update({ where: { id: run.id, workspaceId }, data: { status: runStatusOf(result), summary, finishedAt: new Date() } }),
    );
    return result;
  } catch (err) {
    const msg = err instanceof Error ? scrubMessage(err.message) : "unexpected error";
    await withWorkspaceScope(workspaceId, (tx) =>
      tx.bizSyncRun.update({ where: { id: run.id, workspaceId }, data: { status: "failed", error: msg.slice(0, 500), finishedAt: new Date() } }),
    ).catch(() => undefined);
    throw err;
  }
}

/** Log a failure that happened outside recordRun (e.g. a webhook apply). */
export async function recordFailedRun(workspaceId: string, provider: BizProvider, operation: string, actor: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? scrubMessage(err.message) : "unexpected error";
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.bizSyncRun.create({ data: { workspaceId, provider, operation: operation.slice(0, 60), actor: actor.slice(0, 200), status: "failed", error: msg.slice(0, 500), finishedAt: new Date() } }),
  ).catch(() => undefined);
}

export interface RunView {
  id: string;
  provider: string;
  operation: string;
  status: string;
  actor: string;
  summary: unknown;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export async function recentRuns(workspaceId: string, provider?: BizProvider, limit = 20): Promise<RunView[]> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.bizSyncRun.findMany({
      where: { workspaceId, ...(provider ? { provider } : {}) },
      orderBy: { startedAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
    }),
  );
}
