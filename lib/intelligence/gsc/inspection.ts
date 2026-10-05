// Marketr — Phase 10 M1: URL Inspection priority queue.
//
// Hard wall: 2,000 queries/day/site. There is no service-account escape and
// no batch endpoint, so the design is a priority queue — never a sweep:
// requests are enqueued with a priority + reason, and a cron drain processes
// them highest-priority-first with fair-share across projects. A bulk
// "inspect every URL" operation does not exist in this module on purpose.
//
// Real endpoint shape (stubbed until live inspection is enabled):
//   POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect
//   Body: { inspectionUrl, siteUrl, languageCode }
// Full live inspection requires the USER's OAuth token with the
// webmasters.readonly scope (same vault path as the GSC client); the stub
// refuses to call the network and documents this.
//
// Persistence: queue state + quota ledger live in the workspace's GSC
// data_source config JSON (no new tables). Store is injectable for tests.

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";

/** 2,000 queries per day per site — the documented hard wall. */
export const INSPECTION_QPD_CAP = 2_000;

/** Priority: 1 = lowest, 5 = urgent (e.g. revenue page dropped from index). */
export type InspectionPriority = 1 | 2 | 3 | 4 | 5;

export interface InspectionRequest {
  id: string;
  workspaceId: string;
  projectId: string;
  siteUrl: string;
  url: string;
  priority: InspectionPriority;
  reason: string;
  enqueuedAt: string;
  attempts: number;
}

export interface InspectionResult {
  url: string;
  /** "PASS" | "PARTIAL" | "FAIL" | "NEUTRAL" per the API's indexStatusResult.verdict. */
  verdict: string;
  coverageState: string;
  lastCrawlTime?: string;
  pageFetchState?: string;
  /** True when this result came from the stub (no live API call). */
  stub: boolean;
}

interface QueueState {
  queue: InspectionRequest[];
  /** siteUrl → { date: "YYYY-MM-DD" (UTC), used: n } */
  quota: Record<string, { date: string; used: number }>;
  /** config flag: live inspection enabled for this workspace. */
  liveEnabled?: boolean;
}

export interface QueueStore {
  load(workspaceId: string): Promise<QueueState>;
  save(workspaceId: string, state: QueueState): Promise<void>;
}

function emptyState(): QueueState {
  return { queue: [], quota: {} };
}

/** Default store: persists in the workspace's GSC data_source config JSON. */
export const dataSourceStore: QueueStore = {
  async load(workspaceId: string): Promise<QueueState> {
    const row = await withWorkspaceScope(workspaceId, (tx) =>
      tx.dataSource.findFirst({ where: { workspaceId, type: "gsc" }, select: { config: true } }),
    );
    const cfg = (row?.config ?? {}) as Record<string, unknown>;
    const q = cfg.inspectionQueue as QueueState | undefined;
    if (!q || !Array.isArray(q.queue)) return emptyState();
    return { queue: q.queue, quota: q.quota ?? {}, liveEnabled: q.liveEnabled };
  },
  async save(workspaceId: string, state: QueueState): Promise<void> {
    await withWorkspaceScope(workspaceId, async (tx) => {
      const existing = await tx.dataSource.findFirst({
        where: { workspaceId, type: "gsc" },
        select: { id: true, config: true },
      });
      const base = (existing?.config ?? {}) as Record<string, unknown>;
      const next = { ...base, inspectionQueue: state as unknown as Prisma.InputJsonValue };
      if (existing) {
        await tx.dataSource.update({ where: { id: existing.id, workspaceId }, data: { config: next } });
      } else {
        await tx.dataSource.create({
          data: { workspaceId, type: "gsc", config: next, status: "active" },
        });
      }
    });
  },
};

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function quotaUsed(state: QueueState, siteUrl: string, now: Date): number {
  const entry = state.quota[siteUrl];
  if (!entry || entry.date !== utcDay(now)) return 0;
  return entry.used;
}

function recordQuotaUse(state: QueueState, siteUrl: string, now: Date): void {
  const day = utcDay(now);
  const entry = state.quota[siteUrl];
  if (!entry || entry.date !== day) state.quota[siteUrl] = { date: day, used: 1 };
  else entry.used += 1;
}

function newId(): string {
  return `insp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Enqueue one URL for inspection. Priority-ordered; there is deliberately no
 * enqueue-all / sweep API — bulk inspection is the abuse pattern the 2,000
 * QPD wall exists to prevent.
 */
export async function enqueueInspection(
  workspaceId: string,
  input: {
    projectId: string;
    siteUrl: string;
    url: string;
    priority: InspectionPriority;
    reason: string;
  },
  store: QueueStore = dataSourceStore,
): Promise<InspectionRequest> {
  const state = await store.load(workspaceId);
  const req: InspectionRequest = {
    id: newId(),
    workspaceId,
    projectId: input.projectId,
    siteUrl: input.siteUrl,
    url: input.url,
    priority: input.priority,
    reason: input.reason.slice(0, 280),
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
  };
  state.queue.push(req);
  await store.save(workspaceId, state);
  return req;
}

/**
 * Stub of the real URL Inspection call — same endpoint shape, quota
 * accounting, no network. Full live inspection requires the user's OAuth
 * token (webmasters scope) and an explicit opt-in; until then every result
 * is flagged stub: true.
 */
export async function inspectUrlStub(req: InspectionRequest): Promise<InspectionResult> {
  return {
    url: req.url,
    verdict: "NEUTRAL",
    coverageState: "STUB — live inspection not enabled (needs user OAuth scope)",
    stub: true,
  };
}

export interface DrainResult {
  processed: number;
  results: Array<{ request: InspectionRequest; result: InspectionResult }>;
  /** siteUrl → quota used after this drain. */
  quotaAfter: Record<string, number>;
  remaining: number;
}

/**
 * Drain the queue for one workspace: priority-ordered (priority desc, then
 * oldest first), fair-share across projects (round-robin: always serve the
 * project with the fewest served this drain), hard stop at 2,000/day/site.
 * Never sweeps: only explicitly enqueued requests are processed.
 */
export async function drainInspectionQueue(
  workspaceId: string,
  opts: { now?: Date; store?: QueueStore } = {},
): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const store = opts.store ?? dataSourceStore;
  const state = await store.load(workspaceId);

  const served = new Map<string, number>(); // projectId → served this drain
  const results: DrainResult["results"] = [];
  let processed = 0;

  for (;;) {
    // Candidates: pending requests whose site still has quota.
    const candidates = state.queue.filter(
      (r) => quotaUsed(state, r.siteUrl, now) < INSPECTION_QPD_CAP,
    );
    if (candidates.length === 0) break;

    // Pick: highest priority, then fair-share (fewest served this drain),
    // then oldest enqueued.
    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      const sa = served.get(a.projectId) ?? 0;
      const sb = served.get(b.projectId) ?? 0;
      if (sa !== sb) return sa - sb;
      return a.enqueuedAt < b.enqueuedAt ? -1 : 1;
    });
    const next = candidates[0];

    recordQuotaUse(state, next.siteUrl, now);
    next.attempts += 1;
    const result = await inspectUrlStub(next);
    results.push({ request: next, result });
    served.set(next.projectId, (served.get(next.projectId) ?? 0) + 1);
    state.queue = state.queue.filter((r) => r.id !== next.id);
    processed++;
  }

  await store.save(workspaceId, state);

  const quotaAfter: Record<string, number> = {};
  for (const site of Object.keys(state.quota)) {
    quotaAfter[site] = quotaUsed(state, site, now);
  }
  return { processed, results, quotaAfter, remaining: state.queue.length };
}

/** How many inspections a site may still run today (UTC). */
export async function inspectionQuotaRemaining(
  workspaceId: string,
  siteUrl: string,
  opts: { now?: Date; store?: QueueStore } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const state = await (opts.store ?? dataSourceStore).load(workspaceId);
  return Math.max(0, INSPECTION_QPD_CAP - quotaUsed(state, siteUrl, now));
}
