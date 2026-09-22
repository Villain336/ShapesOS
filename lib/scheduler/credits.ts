// Marketr — scheduler credit accounting (Phase B, W2).
//
// Credit table v1 (spec Appendix A). The immutable UsageEvent ledger arrives
// in Phase C — these fields and the counting rules exist now so metering has
// a source of truth to read from.

/** 1 credit = $0.01. Integer credits only, never floats. */
export const CREDITS_PER_DOLLAR = 100;

/** Base fee for one scheduled skill run (spec Appendix A). */
export const SKILL_RUN_BASE_CREDITS = 5;

/** Orchestration fee per spawned subagent, before that subagent's own actions. */
export const SUBAGENT_SPAWN_CREDITS = 2;

/**
 * Deterministic mock action costs for the mocked executor (this track has no
 * live LLM/provider calls). Real per-action costs will come from the provider
 * adapters as they are wired.
 */
export const MOCK_ACTION_CREDITS = {
  subtask_analysis: 1,
  subtask_write: 1,
  report_assembly: 1,
} as const;

export interface CreditBreakdown {
  base: number;
  subagents: number;
  actions: number;
  total: number;
}

export function runCreditBreakdown(subagentCount: number, subtaskCount: number): CreditBreakdown {
  const base = SKILL_RUN_BASE_CREDITS;
  const subagents = subagentCount * SUBAGENT_SPAWN_CREDITS;
  const actions = subtaskCount * MOCK_ACTION_CREDITS.subtask_analysis + MOCK_ACTION_CREDITS.report_assembly;
  return { base, subagents, actions, total: base + subagents + actions };
}
