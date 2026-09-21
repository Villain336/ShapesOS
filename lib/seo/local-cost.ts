// Marketr — local SEO cost controls (milestone 16).
//
// DataForSEO Maps SERP + Business Data endpoints are metered: every geo-grid
// run, competitor refresh, and review ingest costs real money, so those paths
// (lib/local/service.ts) must ALWAYS go through this module:
//   1. estimateGridRunCost(cells) / estimateCompetitorRefreshCost(n) /
//      estimateReviewsIngestCost() — cost previews shown BEFORE the user confirms.
//   2. Hard grid-cell cap per run — no silent 81-cell blowups beyond the cap.
//   3. Workspace monthly spend cap — enforced before any paid call.
//
// Pricing (conservative estimates, observed/derived 2026-09-21; the research
// task marketr-research-seo verified Backlinks pricing, NOT these — re-verify
// against https://dataforseo.com/apis before relying on them for billing):
//   serp/google/maps/live                        : ~$0.002 per cell request
//   business_data/business_listings/search/live  : ~$0.002 per request
//   business_data/google/reviews (task_post+get)  : ~$0.010 per business
// A 5×5 grid = 25 cells ≈ $0.05/run. Review ingest is the expensive one per
// business because the task API bills the whole task, not per row.

export const LOCAL_PRICING = {
  /** USD per /serp/google/maps/live request (one per grid cell). */
  mapsSerpRequestUsd: 0.002,
  /** USD per /business_data/business_listings/search/live request. */
  businessListingsRequestUsd: 0.002,
  /** USD per google/reviews task (post + get). */
  reviewsTaskUsd: 0.01,
} as const;

/** Absolute ceiling on grid cells per run — enforced in the service, not just UI. */
export const MAX_GRID_CELLS_PER_RUN = 81; // 9×9
/** Smallest/largest grid dimension allowed in the UI. */
export const MIN_GRID_SIZE = 2;
export const MAX_GRID_SIZE = 9;

/**
 * Workspace monthly spend cap (USD) on DataForSEO local-SEO calls when the
 * workspace hasn't set one. Admins can raise/lower it.
 */
export const DEFAULT_LOCAL_SPEND_CAP_USD = 25;

/** "2026-09" style billing period key (re-exported for convenience). */
export { monthKey } from "./backlinks-cost";

/**
 * Estimated USD cost of one geo-grid run with `cells` cells.
 * Pure — safe to call anywhere (previews, tests).
 */
export function estimateGridRunCost(cells: number): number {
  const c = Math.max(0, Math.min(Math.floor(cells), MAX_GRID_CELLS_PER_RUN));
  return round4(c * LOCAL_PRICING.mapsSerpRequestUsd);
}

/** Estimated USD cost of refreshing `count` competitor snapshots. */
export function estimateCompetitorRefreshCost(count: number): number {
  const c = Math.max(0, Math.floor(count));
  return round4(c * LOCAL_PRICING.businessListingsRequestUsd);
}

/** Estimated USD cost of ingesting reviews for one business. */
export function estimateReviewsIngestCost(): number {
  return LOCAL_PRICING.reviewsTaskUsd;
}

export interface LocalBudgetCheck {
  ok: boolean;
  blockedReason: string | null;
  estimatedCostUsd: number;
}

/**
 * Pure cost-gate decision for a local-SEO operation. The service calls this
 * BEFORE any paid API call; tests cover it without a database.
 */
export function checkLocalBudget(
  estimatedCostUsd: number,
  spendUsedUsd: number,
  spendCapUsd: number,
): LocalBudgetCheck {
  const estimated = round4(estimatedCostUsd);
  if (spendUsedUsd + estimated > spendCapUsd) {
    return {
      ok: false,
      blockedReason: `This operation ($${estimated.toFixed(4)}) would exceed the workspace monthly local-SEO budget ($${spendCapUsd.toFixed(2)}; $${spendUsedUsd.toFixed(4)} used).`,
      estimatedCostUsd: estimated,
    };
  }
  return { ok: true, blockedReason: null, estimatedCostUsd: estimated };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
