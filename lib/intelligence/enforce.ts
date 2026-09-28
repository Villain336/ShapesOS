// Marketr — Phase 13B Worker 4: fail-closed style-rule enforcement hook.
//
// This is the single entry point the agent-output delivery paths call
// before anything reaches the user. Re-exports the checker so callers only
// ever import from here.

export {
  enforceStyleRules,
  checkOutput,
  checkOutputAgainstRules,
  loadActiveStyleRules,
  StyleRuleBlockedError,
  type EnforceResult,
  type StyleCheckResult,
  type StyleViolation,
} from "./company/style-check";
