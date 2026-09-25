// Marketr — Phase 6 O1 outreach engine: suppression lists.
//
// Global + per-campaign suppression with SHA-256-hashed emails.
// Enforcement is instant and same-cycle: every dispatch reads the current
// set at send time. Opt-outs, hard bounces, and replies suppress immediately —
// never the next batch.

import { prisma } from "@/lib/prisma";
import { createId } from "@/lib/media/ids";
import { sha256Hex } from "@/lib/authority/approvals";
import { isSuppressed } from "@/lib/authority/guards";
import type { SuppressionKind } from "@prisma/client";

/** Normalize + hash an email for suppression storage (never store raw emails). */
export function hashEmail(email: string): string {
  return sha256Hex(email.trim().toLowerCase());
}

export interface SuppressionStore {
  add(workspaceId: string, kind: SuppressionKind, campaignId: string | null, emailHash: string, source: string): Promise<void>;
  hashes(workspaceId: string, kind?: SuppressionKind, campaignId?: string | null): Promise<Set<string>>;
  count(workspaceId: string): Promise<number>;
}

/** Add a raw email to suppression (hashed at rest). */
export async function suppressEmail(
  store: SuppressionStore,
  opts: { workspaceId: string; email: string; kind?: SuppressionKind; campaignId?: string; source: string },
): Promise<void> {
  await store.add(
    opts.workspaceId,
    opts.kind ?? "global",
    opts.campaignId ?? null,
    hashEmail(opts.email),
    opts.source,
  );
}

/** Instant same-cycle check: global list + (optionally) the campaign list. */
export async function isEmailSuppressed(
  store: SuppressionStore,
  opts: { workspaceId: string; email: string; campaignId?: string },
): Promise<boolean> {
  const hash = hashEmail(opts.email);
  const global = await store.hashes(opts.workspaceId, "global");
  if (isSuppressed(hash, global)) return true;
  if (opts.campaignId) {
    const perCampaign = await store.hashes(opts.workspaceId, "campaign", opts.campaignId);
    if (isSuppressed(hash, perCampaign)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Prisma store
// ---------------------------------------------------------------------------

export function prismaSuppressionStore(): SuppressionStore {
  async function readEntries(workspaceId: string, kind: SuppressionKind, campaignId: string | null): Promise<string[]> {
    const row = await prisma.suppressionList.findFirst({ where: { workspaceId, kind, campaignId } });
    const raw = row?.entriesJson;
    return Array.isArray(raw) ? (raw as string[]) : [];
  }
  return {
    async add(workspaceId, kind, campaignId, emailHash, source) {
      // Explicit find + create/update (not upsert): campaignId is nullable in
      // the compound unique and Postgres NULL semantics make upsert unreliable.
      const entries = await readEntries(workspaceId, kind, campaignId);
      if (!entries.includes(emailHash)) entries.push(emailHash);
      const existing = await prisma.suppressionList.findFirst({ where: { workspaceId, kind, campaignId } });
      if (existing) {
        await prisma.suppressionList.update({ where: { id: existing.id }, data: { entriesJson: entries, source } });
      } else {
        await prisma.suppressionList.create({
          data: { id: createId(), workspaceId, kind, campaignId, entriesJson: entries, source },
        });
      }
    },
    async hashes(workspaceId, kind, campaignId) {
      if (kind && campaignId !== undefined) return new Set(await readEntries(workspaceId, kind, campaignId));
      // all lists in workspace
      const rows = await prisma.suppressionList.findMany({ where: { workspaceId } });
      const out = new Set<string>();
      for (const r of rows) {
        const raw = r.entriesJson;
        if (Array.isArray(raw)) for (const h of raw as string[]) out.add(h);
      }
      return out;
    },
    async count(workspaceId) {
      return (await this.hashes(workspaceId)).size;
    },
  };
}

// ---------------------------------------------------------------------------
// Memory store (battery twin)
// ---------------------------------------------------------------------------

export function createMemorySuppressionStore(): SuppressionStore {
  const lists = new Map<string, { kind: SuppressionKind; campaignId: string | null; hashes: Set<string> }>();
  const key = (workspaceId: string, kind: SuppressionKind, campaignId: string | null) =>
    `${workspaceId}::${kind}::${campaignId ?? ""}`;
  return {
    async add(workspaceId, kind, campaignId, emailHash, _source) {
      const k = key(workspaceId, kind, campaignId);
      let list = lists.get(k);
      if (!list) { list = { kind, campaignId, hashes: new Set() }; lists.set(k, list); }
      list.hashes.add(emailHash);
    },
    async hashes(workspaceId, kind, campaignId) {
      const out = new Set<string>();
      for (const [k, list] of lists) {
        if (!k.startsWith(`${workspaceId}::`)) continue;
        if (kind && list.kind !== kind) continue;
        if (campaignId !== undefined && list.campaignId !== campaignId) continue;
        for (const h of list.hashes) out.add(h);
      }
      return out;
    },
    async count(workspaceId) {
      return (await this.hashes(workspaceId)).size;
    },
  };
}
