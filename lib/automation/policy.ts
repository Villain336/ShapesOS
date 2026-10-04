// Marketr — Phase 9 M6: data-driven automation policy (docs/specs/SPEC-PHASE9.md §P9E).
//
// Closes M1 gap #4: the Tier-1 allowlist / automation toggles are no longer
// code-only. `resolveAutomation(workspaceId, action)` reads the
// `automation_settings` table (workspace × action → auto|ask|never +
// optional per-action threshold override) and returns the effective
// behavior; when no row exists it falls back to code defaults
// (TIER1_KINDS from lib/orchestrator/authority.ts).
//
// Safety posture (unchanged from M1):
//  - Tier 3 is evaluated FIRST inside evaluateTier — the "auto" behavior
//    from a settings row can never widen the hard deny list. The action's
//    NATURE decides, not the row. PUT rejects behavior=auto for Tier 3
//    kinds (400), and evaluateTier's hard deny still wins even if a row
//    somehow says auto (asserted in lib/automation/__tests__/policy.test.ts).
//  - Tier 1 never fires without an explicit opt-in: the default behavior
//    for every action is "ask" (Tier 1 kinds included); "auto" requires the
//    user to flip the toggle in automation settings.
//  - Unknown action shape → Tier 2 (fail closed, per authority.ts).

import { withWorkspaceScope } from "../substrate/graph/rls";
import { KNOWN_ACTION_DEFS } from "./actions";
import {
  DEFAULT_SMALL_ACTION_THRESHOLD_CENTS,
  TIER1_KINDS,
  evaluateTier,
  type TierSettings,
} from "../orchestrator/authority";

export type AutomationBehaviorName = "auto" | "ask" | "never";

/**
 * Sentinel action key in `automation_settings` holding the workspace-default
 * small-action threshold (its behavior column is ignored; only
 * threshold_cents is read). User-adjustable per workspace; code default is
 * $100 (DEFAULT_SMALL_ACTION_THRESHOLD_CENTS).
 */
export const WORKSPACE_DEFAULT_ACTION = "*";

/** Phase 5: the agent key of a rule that applies to every agent. */
export const ALL_AGENTS = "*";

export interface AutomationRowLike {
  /** Phase 5: "*" (every agent) or one agent's key. Missing = "*". */
  agentKey?: string;
  action: string;
  behavior: AutomationBehaviorName;
  thresholdCents: number | null;
}

export interface ResolvedAutomation {
  action: string;
  /** Effective behavior: row value, or the code default when no row exists. */
  behavior: AutomationBehaviorName;
  /** Effective threshold: per-action override → workspace default → $100. */
  thresholdCents: number;
  /** "row" = the every-agent rule; "agent" = a rule for this one agent. */
  source: "row" | "agent" | "default";
  /** The agent the deciding rule belongs to ("*" = every agent). */
  ruleAgentKey?: string;
}

/** Intrinsic tier of an action when the automation toggle is ON. Used to
 *  compute code defaults and to reject auto for Tier 3 kinds at the API. */
function intrinsicTier(action: string): 0 | 1 | 2 | 3 {
  return evaluateTier(
    { kind: action },
    {
      smallActionThresholdCents: DEFAULT_SMALL_ACTION_THRESHOLD_CENTS,
      automationAllows: true,
      defaultCurrency: "USD",
    },
  );
}

/**
 * resolveAutomationFromRows — PURE. The test seam for resolveAutomation:
 * given the workspace's automation_setting rows, resolve the effective
 * behavior for one action.
 */
export function resolveAutomationFromRows(
  rows: AutomationRowLike[],
  action: string,
  agentKey: string = ALL_AGENTS,
): ResolvedAutomation {
  // Phase 5: the most specific rule wins — this agent's rule for the
  // action, then the every-agent rule. The "*" action row (workspace
  // threshold) is only ever read for its threshold.
  const keyOf = (r: AutomationRowLike) => r.agentKey ?? ALL_AGENTS;
  const everyAgent = new Map(rows.filter((r) => keyOf(r) === ALL_AGENTS).map((r) => [r.action, r]));
  const agentRow =
    agentKey !== ALL_AGENTS
      ? rows.find((r) => keyOf(r) === agentKey && r.action === action)
      : undefined;
  const row = everyAgent.get(action);
  const defaultRow = everyAgent.get(WORKSPACE_DEFAULT_ACTION);

  const thresholdCents =
    agentRow?.thresholdCents ??
    row?.thresholdCents ??
    defaultRow?.thresholdCents ??
    DEFAULT_SMALL_ACTION_THRESHOLD_CENTS;

  if (agentRow) {
    return { action, behavior: agentRow.behavior, thresholdCents, source: "agent", ruleAgentKey: agentKey };
  }
  if (row) {
    return { action, behavior: row.behavior, thresholdCents, source: "row", ruleAgentKey: ALL_AGENTS };
  }

  // No row → code defaults. Tier 3 kinds default to "never" (sticky);
  // everything else defaults to "ask" — Tier 1 never fires without an
  // explicit opt-in (M1 authority.ts contract).
  const tier = intrinsicTier(action);
  const behavior: AutomationBehaviorName = tier === 3 ? "never" : "ask";
  return { action, behavior, thresholdCents, source: "default" };
}

/**
 * toTierSettings — bridge to the M1 evaluator. The executor calls
 * evaluateTier(action, toTierSettings(resolved)) at execution time; the
 * Tier 3 scan inside evaluateTier runs FIRST, so a behavior=auto row can
 * never widen the hard deny list.
 */
export function toTierSettings(resolved: ResolvedAutomation): TierSettings {
  return {
    smallActionThresholdCents: resolved.thresholdCents,
    automationAllows: resolved.behavior === "auto",
    defaultCurrency: "USD",
  };
}

/**
 * validateBehaviorForAction — API guard for PUT /api/automation/settings.
 * Returns an error message, or null when the (action, behavior) pair is
 * acceptable. behavior=auto is rejected for Tier 3 kinds (400); Tier 3 is
 * un-overridable (SPEC §P9E).
 */
export function validateBehaviorForAction(
  action: unknown,
  behavior: unknown,
  thresholdCents: unknown,
): string | null {
  if (typeof action !== "string" || !action.trim() || action.length > 120) {
    return "action must be a non-empty string (max 120 chars).";
  }
  if (behavior !== "auto" && behavior !== "ask" && behavior !== "never") {
    return "behavior must be one of: auto, ask, never.";
  }
  if (thresholdCents !== undefined && thresholdCents !== null) {
    if (
      typeof thresholdCents !== "number" ||
      !Number.isInteger(thresholdCents) ||
      thresholdCents < 0 ||
      thresholdCents > 10_000_000_00
    ) {
      return "thresholdCents must be a non-negative integer (cents).";
    }
  }
  if (behavior === "auto" && action !== WORKSPACE_DEFAULT_ACTION) {
    if (intrinsicTier(action) === 3) {
      return `behavior=auto is not allowed for Tier 3 actions (${action}). Tier 3 (money movement, contract signing, data deletion) is un-overridable — it can never run automatically.`;
    }
  }
  return null;
}

/** DB-backed: read every automation_setting row for the workspace. */
export async function listAutomationRows(
  workspaceId: string,
): Promise<AutomationRowLike[]> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.automationSetting.findMany({
      where: { workspaceId },
      select: { agentKey: true, action: true, behavior: true, thresholdCents: true },
    }),
  );
}

/** DB-backed: resolve the effective automation for one action. */
export async function resolveAutomation(
  workspaceId: string,
  action: string,
  agentKey: string = ALL_AGENTS,
): Promise<ResolvedAutomation> {
  const rows = await listAutomationRows(workspaceId);
  return resolveAutomationFromRows(rows, action, agentKey);
}

// ---------------------------------------------------------------------------
// Phase 5: auto-approve — may this agent run this action without asking?
// ---------------------------------------------------------------------------

export interface AutoApprovalInput {
  agentKey: string;
  /** The automation action the call stands for (ToolDef.action, connectorAction). */
  action: string;
  /** What the call does, scanned for Tier-3 wording (money, signing, deleting). */
  description?: string;
  /** Destructive tools never run without asking, whatever the rule says. */
  destructive?: boolean;
  amountCents?: number;
}

export interface AutoApprovalDecision {
  auto: boolean;
  tier: 0 | 1 | 2 | 3;
  resolved: ResolvedAutomation;
  /** Plain reason (shown in the run timeline / audit log). */
  reason: string;
}

/**
 * decideAutoApproval — PURE. Runs without asking ONLY when all hold:
 *   - a rule explicitly says "auto" for this agent (or every agent),
 *   - the call is not destructive,
 *   - the DoA evaluator puts it at Tier 0 or Tier 1 with that rule applied.
 * Tier 2 (external audiences, above the threshold) and Tier 3 (money,
 * contracts, deletion) always ask — the rule can never widen them.
 */
export function decideAutoApproval(
  rows: AutomationRowLike[],
  input: AutoApprovalInput,
): AutoApprovalDecision {
  const resolved = resolveAutomationFromRows(rows, input.action, input.agentKey);
  const tier = evaluateTier(
    { kind: input.action, description: input.description, amountCents: input.amountCents },
    toTierSettings(resolved),
  );
  const who = resolved.ruleAgentKey === ALL_AGENTS ? "every agent" : `agent ${resolved.ruleAgentKey}`;
  if (input.destructive) {
    return { auto: false, tier, resolved, reason: "destructive actions always ask" };
  }
  if (resolved.behavior !== "auto") {
    return { auto: false, tier, resolved, reason: `no auto-approve rule for ${input.action}` };
  }
  if (tier >= 2) {
    return {
      auto: false,
      tier,
      resolved,
      reason: tier === 3 ? "Tier 3 actions can never run automatically" : "Tier 2 actions always ask",
    };
  }
  return { auto: true, tier, resolved, reason: `auto-approved by the ${input.action} rule for ${who}` };
}

/** DB-backed decideAutoApproval. */
export async function autoApprovalFor(
  workspaceId: string,
  input: AutoApprovalInput,
): Promise<AutoApprovalDecision> {
  return decideAutoApproval(await listAutomationRows(workspaceId), input);
}

/** DB-backed: the workspace's effective small-action threshold in cents. */
export async function workspaceThresholdCents(
  workspaceId: string,
): Promise<number> {
  const rows = await listAutomationRows(workspaceId);
  return resolveAutomationFromRows(rows, WORKSPACE_DEFAULT_ACTION).thresholdCents;
}

// ---------------------------------------------------------------------------
// KNOWN_ACTIONS — curated action catalog for the automation settings UI.
// Tier badges are computed from the M1 evaluator (intrinsic tier with the
// toggle ON), so the UI can never drift from the enforcement semantics.
// ---------------------------------------------------------------------------

export interface KnownAction {
  action: string;
  label: string;
  description: string;
  tier: 0 | 1 | 2 | 3;
}

export const KNOWN_ACTIONS: KnownAction[] = KNOWN_ACTION_DEFS.map((d) => ({
  ...d,
  tier: intrinsicTier(d.action),
}));

export { TIER1_KINDS, DEFAULT_SMALL_ACTION_THRESHOLD_CENTS };
