// Marketr — Phase 10 M1: GSC-sourced inputs for the shared visibility score.
//
// Thin adapter: maps per-query GSC aggregates onto ScoredKeyword[] and feeds
// them through visibilityScore() from lib/rankings — the SAME formula the
// paid rank-check path uses (computeComponents in
// lib/retention/visibility-score.ts). GSC impressions stand in for keyword
// volume as the weight; GSC average position is the position input. This is
// the refactor the spec asks for: one score implementation, two data sources.

import { visibilityScore } from "@/lib/rankings";
import type { QueryAggregate } from "./window-score";

/**
 * Feed per-query GSC aggregates through the shared visibilityScore math.
 * Exported for tests and for M2's radar (score-per-window primitive).
 */
export function scoreFromQueryAggregates(aggs: QueryAggregate[]): number {
  return visibilityScore(
    aggs.map((a) => ({
      volume: a.impressions,
      position: a.position > 0 ? a.position : null,
    })),
  );
}
