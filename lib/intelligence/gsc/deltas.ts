// Marketr — Phase 10 M1: before/after delta engine.
//
// The measurement primitive M2's radar consumes. Given two windows, attribute
// per-page, per-query movement with magnitudes.
//
// Sign convention: deltaPosition = post.avgPosition − pre.avgPosition, so a
// NEGATIVE deltaPosition means the page moved UP (improved). magnitude is a
// 0–100 blended change score, normalized against the largest move in the
// same computeDeltas call so sibling rows are comparable:
//
//   magnitude_i = round(100 × (0.5·|dC|/maxC + 0.3·|dI|/maxI + 0.2·|dP|/40))
//
// where maxC/maxI are the largest absolute click/impression moves in the
// call and 40 is the position-move scale (≈ 2 pages of movement).

import { withWorkspaceScope, type TxClient } from "@/lib/substrate/graph/rls";
import type { DateWindow, GscSnapshotRow, PageQueryDelta } from "./types";

interface Agg {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  /** Impression-weighted average position. */
  position: number;
}

function aggKey(query: string, page: string): string {
  return `${page}␟${query}`;
}

/**
 * Granularity rule shared by the delta engine and the window scorer:
 * hourly snapshots win when present for a window, daily otherwise —
 * never mixed in one window.
 */
export function chooseSnapshots<T extends { granularity: "hourly" | "daily" }>(
  snapshots: T[],
): T[] {
  const hourly = snapshots.filter((s) => s.granularity === "hourly");
  return hourly.length > 0 ? hourly : snapshots;
}

/** Aggregate snapshot rows to one row per page×query (pure, testable). */
export function aggregateRows(rows: GscSnapshotRow[]): Map<string, Agg> {
  const acc = new Map<string, { query: string; page: string; clicks: number; impressions: number; posW: number }>();
  for (const r of rows) {
    const key = aggKey(r.query, r.page);
    const e = acc.get(key) ?? { query: r.query, page: r.page, clicks: 0, impressions: 0, posW: 0 };
    e.clicks += r.clicks;
    e.impressions += r.impressions;
    e.posW += r.position * r.impressions;
    acc.set(key, e);
  }
  const out = new Map<string, Agg>();
  for (const [key, e] of acc) {
    out.set(key, {
      query: e.query,
      page: e.page,
      clicks: e.clicks,
      impressions: e.impressions,
      position: e.impressions > 0 ? e.posW / e.impressions : 0,
    });
  }
  return out;
}

/**
 * Pure before/after diff over two aggregate maps (pure, testable).
 * Only pairs present in at least one window are emitted; a pair missing
 * from one side is treated as zero on that side.
 */
export function diffAggregates(
  projectId: string,
  pre: Map<string, Agg>,
  post: Map<string, Agg>,
): PageQueryDelta[] {
  const keys = new Set([...pre.keys(), ...post.keys()]);
  const raw: Array<Omit<PageQueryDelta, "magnitude">> = [];
  let maxC = 0;
  let maxI = 0;
  for (const key of keys) {
    const a = pre.get(key);
    const b = post.get(key);
    const deltaClicks = (b?.clicks ?? 0) - (a?.clicks ?? 0);
    const deltaImpressions = (b?.impressions ?? 0) - (a?.impressions ?? 0);
    const deltaPosition = (b?.position ?? 0) - (a?.position ?? 0);
    maxC = Math.max(maxC, Math.abs(deltaClicks));
    maxI = Math.max(maxI, Math.abs(deltaImpressions));
    raw.push({
      projectId,
      page: (b ?? a)!.page,
      query: (b ?? a)!.query,
      deltaClicks,
      deltaImpressions,
      deltaPosition: Math.round(deltaPosition * 100) / 100,
    });
  }
  return raw.map((r) => ({
    ...r,
    magnitude:
      maxC === 0 && maxI === 0
        ? 0
        : Math.min(
            100,
            Math.round(
              100 *
                (0.5 * (Math.abs(r.deltaClicks) / Math.max(maxC, 1)) +
                  0.3 * (Math.abs(r.deltaImpressions) / Math.max(maxI, 1)) +
                  0.2 * (Math.abs(r.deltaPosition) / 40)),
            ),
          ),
  }));
}

/** Load and aggregate all snapshot rows overlapping a window. */
async function loadWindowAgg(
  tx: TxClient,
  projectId: string,
  window: DateWindow,
): Promise<Map<string, Agg>> {
  const snapshots = await tx.gscSnapshot.findMany({
    where: {
      projectId,
      windowStart: { lt: window.end },
      windowEnd: { gt: window.start },
    },
    select: { rows: true, granularity: true },
  });
  // Never mix granularities in one window: hourly wins when present, else daily.
  const chosen = chooseSnapshots(snapshots);
  const rows: GscSnapshotRow[] = [];
  for (const s of chosen) {
    const parsed = (s.rows ?? []) as unknown as GscSnapshotRow[];
    if (Array.isArray(parsed)) rows.push(...parsed);
  }
  return aggregateRows(rows);
}

/**
 * Compute before/after deltas per page × query for a project.
 *
 * This is the measurement primitive M2's platform-change radar consumes.
 * Reads gsc_snapshot rows (written by pullSnapshots); hourly granularity is
 * preferred when present for a window, daily otherwise — never mixed.
 */
export async function computeDeltas(
  workspaceId: string,
  projectId: string,
  pre: { start: Date; end: Date },
  post: { start: Date; end: Date },
): Promise<PageQueryDelta[]> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const preAgg = await loadWindowAgg(tx, projectId, pre as DateWindow);
    const postAgg = await loadWindowAgg(tx, projectId, post as DateWindow);
    return diffAggregates(projectId, preAgg, postAgg);
  });
}
