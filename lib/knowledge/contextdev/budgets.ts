// Marketr — Wave 2 context.dev slice 1: workspace budget gate (pure).
//
// Every Context.dev call passes this gate BEFORE the API is hit. The rule
// from the spec: free-tier budgets per workspace per day; over-budget
// requests route to the approve/deny queue instead of failing silently or
// burning the tenant's money.
//
// Decisions:
//   - "allow"          — fits inside today's budget; spend it.
//   - "needs_approval" — would exceed the budget; the caller must surface an
//                        approval request, never charge silently.
//
// Fail-closed corners:
//   - cap <= 0 means "no budget configured" → needs_approval (never unlimited).
//   - negative / non-finite inputs → needs_approval (never allow on bad math).

export const DEFAULT_DAILY_CAP_CREDITS = 100;

export type BudgetDecision = "allow" | "needs_approval";

export interface BudgetState {
  /** Credits already consumed today (UTC). */
  usedToday: number;
  /** Daily cap in credits. <= 0 = no budget configured. */
  capCredits: number;
}

export interface BudgetVerdict {
  decision: BudgetDecision;
  /** Human-readable reason, safe to show in UI. */
  reason: string;
  /** Credits remaining after this call if allowed. */
  remainingAfter: number;
}

export function decideBudget(state: BudgetState, estimatedCost: number): BudgetVerdict {
  const used = state.usedToday;
  const cap = state.capCredits;
  const cost = estimatedCost;

  const bad = (reason: string): BudgetVerdict => ({
    decision: "needs_approval",
    reason,
    remainingAfter: Math.max(0, cap - used),
  });

  if (!Number.isFinite(used) || used < 0) return bad("Budget usage is not a valid number — approval required");
  if (!Number.isFinite(cap)) return bad("Budget cap is not a valid number — approval required");
  if (!Number.isFinite(cost) || cost < 0) return bad("Estimated cost is not a valid number — approval required");
  if (cap <= 0) {
    return bad("No daily Context.dev budget is configured for this workspace — approval required");
  }
  if (used + cost > cap) {
    return {
      decision: "needs_approval",
      reason: `This call (${cost} credits) would exceed today's ${cap}-credit budget (${used} used) — approval required`,
      remainingAfter: Math.max(0, cap - used),
    };
  }
  return {
    decision: "allow",
    reason: "Within today's budget",
    remainingAfter: cap - used - cost,
  };
}
