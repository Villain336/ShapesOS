// Marketr — backlink pull cost controls (milestone 15).
//
// DataForSEO Backlinks API is metered: every pull costs real money, so the
// pull path (lib/seo/backlink-pull.ts) must ALWAYS go through this module:
//   1. estimatePullCost(rows) — cost preview shown BEFORE the user confirms.
//   2. Hard row cap per pull — no silent 100k-row pulls.
//   3. Workspace monthly spend cap — enforced before any paid call.
//
// Pricing observed 2026-09-21 (research task marketr-research-seo):
//   backlinks/live : $0.024 per request + $0.000036 per returned row
//   (~$0.06 per 1,000 backlinks).
//   backlinks/summary/live : request-priced only (no per-row fee).
// Re-verify against https://dataforseo.com/apis/backlink-api if numbers age.

export const BACKLINKS_PRICING = {
  /** USD per API request (list + summary endpoints). */
  requestUsd: 0.024,
  /** USD per returned backlink row (list endpoint only). */
  perRowUsd: 0.000036,
} as const;

/** Absolute ceiling on rows per pull — enforced in the pull path, not just UI. */
export const MAX_BACKLINK_ROWS_PER_PULL = 10_000;

/**
 * Workspace monthly spend cap (USD) when the workspace hasn't set one.
 * Documented in the UI as the default guardrail; admins can raise/lower it.
 */
export const DEFAULT_MONTHLY_SPEND_CAP_USD = 25;

/** "2026-09" style billing period key. */
export function monthKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7);
}

/**
 * Estimated USD cost of a backlinks/live pull requesting `rows` rows.
 * Pure function — safe to call anywhere (previews, tests).
 */
export function estimateListPullCost(rows: number): number {
  // Day-1 (#3): NaN must not flow through — Math.floor(NaN) is NaN and
  // Math.max(0, NaN) is NaN, which would poison downstream spend math.
  const r = Number.isFinite(rows)
    ? Math.max(0, Math.min(Math.floor(rows), MAX_BACKLINK_ROWS_PER_PULL))
    : 0;
  return round4(BACKLINKS_PRICING.requestUsd + r * BACKLINKS_PRICING.perRowUsd);
}

/** Estimated USD cost of one backlinks/summary/live call. */
export function estimateSummaryPullCost(): number {
  return BACKLINKS_PRICING.requestUsd;
}

export interface PullBudgetCheck {
  ok: boolean;
  blockedReason: string | null;
  estimatedCostUsd: number;
}

/**
 * Pure cost-gate decision for a backlink pull. The pull service calls this
 * BEFORE any paid API call; tests cover it without a database.
 *
 * Day-1 fix (edge #3): fail CLOSED on non-numeric input. NaN/Infinity/negative
 * used-or-cap values used to make every comparison false → ok:true, letting a
 * malformed cap bypass the budget entirely.
 */
export function checkPullBudget(
  rows: number,
  spendUsedUsd: number,
  spendCapUsd: number,
): PullBudgetCheck {
  const sane = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  if (!sane(rows) || rows <= 0) {
    return { ok: false, blockedReason: "Invalid row count requested.", estimatedCostUsd: 0 };
  }
  if (!sane(spendUsedUsd) || spendUsedUsd < 0) {
    return { ok: false, blockedReason: "Invalid spend tracking state — pull blocked.", estimatedCostUsd: 0 };
  }
  if (!sane(spendCapUsd) || spendCapUsd < 0) {
    return { ok: false, blockedReason: "Invalid budget cap — pull blocked.", estimatedCostUsd: 0 };
  }
  if (rows > MAX_BACKLINK_ROWS_PER_PULL) {
    return {
      ok: false,
      blockedReason: `Requested ${rows.toLocaleString()} rows exceeds the per-pull limit of ${MAX_BACKLINK_ROWS_PER_PULL.toLocaleString()}. Lower the limit and try again.`,
      estimatedCostUsd: estimateListPullCost(MAX_BACKLINK_ROWS_PER_PULL) + estimateSummaryPullCost(),
    };
  }
  const estimatedCostUsd = estimateListPullCost(rows) + estimateSummaryPullCost();
  if (spendUsedUsd + estimatedCostUsd > spendCapUsd) {
    return {
      ok: false,
      blockedReason: `This pull ($${estimatedCostUsd.toFixed(4)}) would exceed the workspace monthly backlinks budget ($${spendCapUsd.toFixed(2)}; $${spendUsedUsd.toFixed(4)} used).`,
      estimatedCostUsd,
    };
  }
  return { ok: true, blockedReason: null, estimatedCostUsd };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
