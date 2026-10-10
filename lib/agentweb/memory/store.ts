// ShapesOS — Phase 21A round 2 (WS=agentweb): browsing memory at rest (FORCE RLS tables
// agentweb_memory_settings and agentweb_memory), always for ONE member.
//
// Where it lives, and why not in the shared business graph: graph facts are append-only by
// contract (lib/substrate/graph/facts.ts: "application code NEVER updates or deletes graph_facts")
// and graph nodes are workspace-wide with no owner. Browsing memory is one person's reading history:
// it must be forgettable item by item, expire at retention, and never be visible to other members.
// So it is its own per-member table, searched through Spotlight (kind page_memory, own rows only)
// and therefore by the answer engine's workspace source as the caller. What reaches the business
// graph is a deliberate act: "Add to the business graph" on a page (lib/agentweb/research/clip.ts).

import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { clampRetention, decideMemory, excerptOf, isExcluded, MEMORY_PER_MEMBER_MAX, normalizeSites, retentionDate, RETENTION_DEFAULT_DAYS, type MemoryDecision } from "./policy";

type Tx = Prisma.TransactionClient;

export interface MemorySettings {
  enabled: boolean;
  retentionDays: number;
  excludedSites: string[];
}
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = { enabled: false, retentionDays: RETENTION_DEFAULT_DAYS, excludedSites: [] };

export interface MemoryItem {
  id: string;
  url: string;
  origin: string;
  title: string;
  excerpt: string;
  captureId: string | null;
  researchId: string | null;
  runId: string | null;
  seenCount: number;
  capturedAt: string;
  lastSeenAt: string;
  retentionUntil: string;
}

type Row = {
  id: string;
  url: string;
  origin: string;
  title: string;
  excerpt: string;
  captureId: string | null;
  researchId: string | null;
  runId: string | null;
  seenCount: number;
  capturedAt: Date;
  lastSeenAt: Date;
  retentionUntil: Date;
};
const itemOf = (r: Row): MemoryItem => ({ id: r.id, url: r.url, origin: r.origin, title: r.title, excerpt: r.excerpt, captureId: r.captureId, researchId: r.researchId, runId: r.runId, seenCount: r.seenCount, capturedAt: r.capturedAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString(), retentionUntil: r.retentionUntil.toISOString() });

export async function getMemorySettings(workspaceId: string, userId: string): Promise<MemorySettings> {
  const row = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebMemorySettings.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } }));
  return row ? { enabled: row.enabled, retentionDays: row.retentionDays, excludedSites: row.excludedSites } : { ...DEFAULT_MEMORY_SETTINGS };
}

/** Change a member's settings. New excluded sites also remove what was already remembered from them. */
export async function saveMemorySettings(workspaceId: string, userId: string, patch: Partial<MemorySettings>): Promise<{ settings: MemorySettings; forgotten: number }> {
  const cur = await getMemorySettings(workspaceId, userId);
  const next: MemorySettings = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    retentionDays: patch.retentionDays === undefined ? cur.retentionDays : clampRetention(patch.retentionDays),
    excludedSites: patch.excludedSites === undefined ? cur.excludedSites : normalizeSites(patch.excludedSites),
  };
  await withWorkspaceScope(workspaceId, (tx) =>
    (tx as Tx).agentwebMemorySettings.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, ...next },
      update: next,
    }),
  );
  let forgotten = 0;
  for (const site of next.excludedSites) if (!cur.excludedSites.includes(site)) forgotten += await forgetSite(workspaceId, userId, site);
  return { settings: next, forgotten };
}

export interface RememberInput {
  url: string;
  title: string;
  text: string;
  /** True only when the page was read because the person asked (their research, a linked session). */
  askedByPerson: boolean;
  captureId?: string | null;
  researchId?: string | null;
  runId?: string | null;
}

/** Remember a page for a member, if their settings and the rules allow it. Returns the decision. */
export async function rememberPage(workspaceId: string, userId: string, input: RememberInput, now: Date = new Date()): Promise<MemoryDecision> {
  const settings = await getMemorySettings(workspaceId, userId);
  const d = decideMemory({ enabled: settings.enabled, excluded: settings.excludedSites, url: input.url, askedByPerson: input.askedByPerson });
  if (!d.store) return d;
  const id = `mem_${randomBytes(9).toString("hex")}`;
  const until = retentionDate(now, settings.retentionDays);
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 200) || new URL(input.url).hostname;
  const excerpt = excerptOf(input.text);
  await withWorkspaceScope(workspaceId, async (tx) => {
    await (tx as Tx).agentwebMemory.upsert({
      where: { workspaceId_userId_urlKey: { workspaceId, userId, urlKey: d.key } },
      create: { id, workspaceId, userId, url: d.key, urlKey: d.key, origin: d.origin, title, excerpt, captureId: input.captureId ?? null, researchId: input.researchId ?? null, runId: input.runId ?? null, capturedAt: now, lastSeenAt: now, retentionUntil: until },
      update: { title, excerpt, lastSeenAt: now, retentionUntil: until, seenCount: { increment: 1 }, ...(input.captureId ? { captureId: input.captureId } : {}), ...(input.researchId ? { researchId: input.researchId } : {}), ...(input.runId ? { runId: input.runId } : {}) },
    });
    // A member's memory has a ceiling: the least recently seen pages go first.
    const over = (await (tx as Tx).agentwebMemory.count({ where: { workspaceId, userId } })) - MEMORY_PER_MEMBER_MAX;
    if (over > 0) {
      const oldest = await (tx as Tx).agentwebMemory.findMany({ where: { workspaceId, userId }, orderBy: { lastSeenAt: "asc" }, take: over, select: { id: true } });
      await (tx as Tx).agentwebMemory.deleteMany({ where: { workspaceId, userId, id: { in: oldest.map((o) => o.id) } } });
    }
  });
  await purgeExpiredMemory(workspaceId, now).catch(() => undefined);
  return d;
}

export async function listMemory(workspaceId: string, userId: string, opts: { q?: string; limit?: number } = {}): Promise<MemoryItem[]> {
  const q = opts.q?.trim();
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    (tx as Tx).agentwebMemory.findMany({
      where: { workspaceId, userId, retentionUntil: { gt: new Date() }, ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { url: { contains: q, mode: "insensitive" } }, { excerpt: { contains: q, mode: "insensitive" } }] } : {}) },
      orderBy: { lastSeenAt: "desc" },
      take: Math.min(opts.limit ?? 100, 500),
    }),
  );
  return rows.map(itemOf);
}

/** Forget one item. Only the member's own; false when it is not theirs or not there. */
export async function forgetItem(workspaceId: string, userId: string, id: string): Promise<boolean> {
  const r = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebMemory.deleteMany({ where: { workspaceId, userId, id } }));
  return r.count > 0;
}

export async function forgetSite(workspaceId: string, userId: string, site: string): Promise<number> {
  const rows = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebMemory.findMany({ where: { workspaceId, userId }, select: { id: true, url: true } }));
  const ids = rows.filter((r) => isExcluded(r.url, [site])).map((r) => r.id);
  if (ids.length === 0) return 0;
  const r = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebMemory.deleteMany({ where: { workspaceId, userId, id: { in: ids } } }));
  return r.count;
}

export async function forgetAll(workspaceId: string, userId: string): Promise<number> {
  const r = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebMemory.deleteMany({ where: { workspaceId, userId } }));
  return r.count;
}

/** Retention: remove what has expired (every member's, in this workspace). */
export async function purgeExpiredMemory(workspaceId: string, now: Date = new Date()): Promise<number> {
  const r = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebMemory.deleteMany({ where: { workspaceId, retentionUntil: { lt: now } } }));
  return r.count;
}
