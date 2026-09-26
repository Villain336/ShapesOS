// Marketr — Phase 10 M1: per-window GSC aggregates for the visibility score.
//
// Loads gsc_snapshot rows for a window (same loader rules as the delta
// engine: hourly preferred when present, never mixed) and aggregates to one
// row per query: total impressions + impression-weighted average position.

import { withWorkspaceScope, type TxClient } from "@/lib/substrate/graph/rls";
import { chooseSnapshots } from "./deltas";
import type { DateWindow, GscSnapshotRow } from "./types";

export interface QueryAggregate {
  query: string;
  impressions: number;
  /** Impression-weighted average position across the query's pages. */
  position: number;
}

async function loadRows(tx: TxClient, projectId: string, window: DateWindow): Promise<GscSnapshotRow[]> {
  const snapshots = await tx.gscSnapshot.findMany({
    where: {
      projectId,
      windowStart: { lt: window.end },
      windowEnd: { gt: window.start },
    },
    select: { rows: true, granularity: true },
  });
  const chosen = chooseSnapshots(snapshots);
  const rows: GscSnapshotRow[] = [];
  for (const s of chosen) {
    const parsed = (s.rows ?? []) as unknown as GscSnapshotRow[];
    if (Array.isArray(parsed)) rows.push(...parsed);
  }
  return rows;
}

/** Aggregate a window's snapshot rows to per-query impression/position totals. */
export async function aggregateWindowQueries(
  workspaceId: string,
  projectId: string,
  window: { start: Date; end: Date },
): Promise<QueryAggregate[]> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const rows = await loadRows(tx, projectId, window as DateWindow);
    const acc = new Map<string, { impressions: number; posW: number }>();
    for (const r of rows) {
      const e = acc.get(r.query) ?? { impressions: 0, posW: 0 };
      e.impressions += r.impressions;
      e.posW += r.position * r.impressions;
      acc.set(r.query, e);
    }
    return [...acc.entries()].map(([query, e]) => ({
      query,
      impressions: e.impressions,
      position: e.impressions > 0 ? e.posW / e.impressions : 0,
    }));
  });
}
