// Marketr — Phase 8 G1: freshness contract (docs/specs/SPEC-PHASE8.md §2 G1).
//
// "Sync honesty is a product feature." Every surfaced node carries as_of +
// source; the UI renders staleness honestly ("Competitor prices as of 3 days
// ago · Google Ads pull") and never presents a 3-day-old pull as current.

import type { Freshness, FreshnessBucket } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function stalenessBucket(asOf: Date, now = new Date()): FreshnessBucket {
  const age = now.getTime() - asOf.getTime();
  if (age < 0) return "fresh"; // clock skew — treat as fresh, not broken
  if (age < DAY) return "fresh";
  if (age < 7 * DAY) return "aging";
  return "stale";
}

export function relativeAge(asOf: Date, now = new Date()): string {
  const age = now.getTime() - asOf.getTime();
  if (age < 0) return "just now";
  if (age < HOUR) {
    const m = Math.max(1, Math.round(age / MIN));
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (age < DAY) {
    const h = Math.round(age / HOUR);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.round(age / DAY);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** The honest label every surfaced node/edge/fact/recall must carry. */
export function freshnessLabel(asOf: Date, source: string, now = new Date()): Freshness {
  const bucket = stalenessBucket(asOf, now);
  return {
    asOf,
    source,
    bucket,
    label: `as of ${relativeAge(asOf, now)} · ${source}`,
  };
}

/** Completeness view: entity-type coverage + freshness distribution. */
export async function completeness(workspaceId: string) {
  const { withWorkspaceScope } = await import("./rls");
  return withWorkspaceScope(workspaceId, async (tx) => {
    const byType = await tx.$queryRaw<
      Array<{ entity_type: string; nodes: bigint; oldest_as_of: Date | null; newest_as_of: Date | null }>
    >`
      SELECT entity_type::text, COUNT(*) AS nodes,
             MIN(as_of) AS oldest_as_of, MAX(as_of) AS newest_as_of
      FROM graph_nodes
      WHERE workspace_id = ${workspaceId} AND merged_into_id IS NULL
      GROUP BY entity_type
      ORDER BY entity_type`;
    const queueOpen = await tx.graphErQueue.count({
      where: { workspaceId, status: "pending" },
    });
    const connectors = await tx.graphConnector.findMany({
      where: { workspaceId },
      select: { platform: true, tier: true, status: true },
    });
    const jobs = await tx.graphSyncJob.findMany({
      where: { workspaceId },
      select: { status: true, lastSuccessAt: true, errorCount: true, backoffUntil: true },
    });
    return {
      entityTypes: byType.map((r) => ({
        entityType: r.entity_type,
        nodes: Number(r.nodes),
        oldestAsOf: r.oldest_as_of,
        newestAsOf: r.newest_as_of,
      })),
      openErItems: queueOpen,
      connectors,
      syncJobs: {
        total: jobs.length,
        failing: jobs.filter((j) => j.status === "failed" || j.status === "dead").length,
        backingOff: jobs.filter((j) => j.status === "backing_off").length,
        lastSuccess: jobs
          .map((j) => j.lastSuccessAt?.getTime() ?? 0)
          .reduce((a, b) => Math.max(a, b), 0),
      },
    };
  });
}
