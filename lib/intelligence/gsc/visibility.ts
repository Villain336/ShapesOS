// Marketr — Phase 10 M1: visibility score + winners/losers from GSC deltas.
//
// REFACTOR, not a fork: the score math is the existing unified visibility
// score in lib/rankings.ts (volume-weighted 1/log2(p+1) click-share curve).
// What changes is the DATA SOURCE — paid rank-check positions become GSC
// Search Analytics positions, with impressions as the volume weight. Same
// formula, same 0–100 scale, comparable across sources.
//
// Winners/losers come from computeDeltas: a "winner" is a page×query pair
// whose average position improved (deltaPosition < 0); losers are the mirror.
// Pairs need a minimum magnitude to count as movers (position noise on tiny
// impression counts is not signal).

import { computeDeltas } from "./deltas";
import { aggregateWindowQueries } from "./window-score";
import { scoreFromQueryAggregates } from "./scoring";
import type { PageQueryDelta, WinnersLosers } from "./types";

/** Minimum delta magnitude for a pair to count as a mover. */
export const MIN_MOVER_MAGNITUDE = 1;

export interface GscVisibility {
  scorePre: number;
  scorePost: number;
  scoreDelta: number;
  winnersLosers: WinnersLosers;
  deltas: PageQueryDelta[];
}

/**
 * Recompute winners/losers + the visibility score from GSC deltas for two
 * windows. Scores are fed through the shared visibilityScore() formula
 * (lib/rankings) with GSC positions — no second implementation.
 */
export async function recomputeGscVisibility(
  workspaceId: string,
  projectId: string,
  pre: { start: Date; end: Date },
  post: { start: Date; end: Date },
): Promise<GscVisibility> {
  const [deltas, preAggs, postAggs] = await Promise.all([
    computeDeltas(workspaceId, projectId, pre, post),
    aggregateWindowQueries(workspaceId, projectId, pre),
    aggregateWindowQueries(workspaceId, projectId, post),
  ]);

  const scorePre = scoreFromQueryAggregates(preAggs);
  const scorePost = scoreFromQueryAggregates(postAggs);

  const movers = deltas.filter(
    (d) => d.magnitude >= MIN_MOVER_MAGNITUDE && d.deltaPosition !== 0,
  );
  const winners = movers
    .filter((d) => d.deltaPosition < 0)
    .sort((a, b) => a.deltaPosition - b.deltaPosition)
    .slice(0, 25);
  const losers = movers
    .filter((d) => d.deltaPosition > 0)
    .sort((a, b) => b.deltaPosition - a.deltaPosition)
    .slice(0, 25);

  return {
    scorePre,
    scorePost,
    scoreDelta: scorePost - scorePre,
    winnersLosers: {
      winners,
      losers,
      improvedCount: deltas.filter((d) => d.deltaPosition < 0).length,
      declinedCount: deltas.filter((d) => d.deltaPosition > 0).length,
    },
    deltas,
  };
}
