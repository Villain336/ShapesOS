// Marketr — Phase 9 M6: data-driven automation policy (docs/specs/SPEC-PHASE9.md §P9E).
//
// Closes M1 gap #4: the Tier-1 allowlist / automation toggles are no longer
// code-only. `resolveAutomation(workspaceId, action)` reads the
// `automation_settings` table (workspace × action → auto|ask|never +
// optional per-action threshold override) and returns the effective
// behavior; when no row exists it falls back to code defaults
// (TIER1_KINDS from lib/orchestrator/authority.ts).
//
// Safety posture:
//  - Tier 3 is evaluated FIRST inside evaluateTier — the "auto" behavior
//    from a settings row can never widen the hard deny list. The action's
//    NATURE decides, not the row. PUT rejects behavior=auto for Tier 3
//    kinds (400), and evaluateTier's hard deny still wins even if a row
//    somehow says auto (asserted in lib/automation/__tests__/policy.test.ts).
//  - Phase 14 (owner decision 2026-10-05): a rule set to "auto" lets ANY
//    Tier 0, 1 or 2 action run without asking. Money and irreversible
//    actions (Tier 3), destructive tools and NEVER_AUTO_ACTIONS never do;
//    an action carrying an amount over the threshold (or in an unknown
//    currency) still asks.
//  - Nothing fires without an explicit opt-in: the default behavior for
//    every action is "ask", except the explicit DEFAULT_BEHAVIORS below
//    (slack_reply = auto keeps the Slack app's existing behaviour).
//  - Unknown action shape → Tier 2 (fail closed, per authority.ts).

import { withWorkspaceScope } from "../substrate/graph/rls";
import { KNOWN_ACTION_DEFS, actionGroup, type ActionGroup } from "./actions";
import {
  DEFAULT_SMALL_ACTION_THRESHOLD_CENTS,
  TIER1_KINDS,
  amountInDefaultCents,
  evaluateTier,
  normalizeForTier,
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

/**
 * Phase 14: code defaults that are not "ask" (a missing row = this). Every
 * other action asks by default; Tier 3 defaults to "never".
 *   slack_reply       — auto: the Slack app has always answered in the
 *                       thread that asked; Ask first holds each reply.
 *   slack_placeholder — never (off): no "waiting for approval" note.
 */
export const DEFAULT_BEHAVIORS: Readonly<Record<string, AutomationBehaviorName>> = {
  slack_reply: "auto",
  slack_placeholder: "never",
};

/**
 * Phase 14: Tier 0–2 actions that still can never run automatically, with
 * the reason. browser_act clicks and submits on ANY web page — a checkout
 * or a delete button there is money / irreversible, and the page (not the
 * action name) decides that.
 */
export const NEVER_AUTO_ACTIONS: ReadonlyMap<string, string> = new Map([
  ["browser_act", "acting in a browser can buy or delete things on any site, so it always asks"],
  // Phase 21B (WS=drive): changing a file that already exists. The old bytes are
  // kept as a version, but a person decides each time.
  ["replace_agent_file", "replacing a file that already exists always asks"],
  ["move_agent_file", "moving or renaming an existing file always asks"],
  ["trash_agent_file", "moving an existing file to the Trash always asks"],
]);

/**
 * Phase 14: money words beyond the DoA Tier-3 verbs, for tools ShapesOS did
 * not write (custom MCP servers, Composio toolkits): a third-party
 * "create_charge" or "send_invoice" carries no purchase/refund/transfer
 * verb. When such a tool's name or description matches, its call is
 * treated as money (Tier 3) — never auto-approved.
 */
export const EXTERNAL_TOOL_MONEY_RE =
  /\b(charges?|payments?|pay|paid|invoices?|bills?|billing|subscriptions?|prices?|orders?|checkout|payroll|wire|bank|budgets?|bids?|coupons?|discounts?|credits?|debits?|balances?|funds?|money|cash|wallet|tax|taxes)\b/i;

/**
 * Phase 14: Composio toolkits that move money (payments, accounting,
 * payroll, banking, commerce, ads) — a "composio:<toolkit>" rule for one can
 * never be auto (fail closed: a match means always asks).
 */
export const COMPOSIO_MONEY_TOOLKIT_RE =
  /(stripe|paypal|square|braintree|adyen|wise|plaid|brex|ramp|mercury|coinbase|chargebee|recurly|paddle|lemon_?squeezy|quickbooks|xero|freshbooks|zoho_?books|sage|netsuite|bill(_?com)?|gusto|adp|rippling|deel|payroll|bank|invoice|billing|payment|shopify|woocommerce|bigcommerce|ads|adwords)/i;

/** Phase 14: actions that stand for tools ShapesOS did not write (custom MCP, Composio). */
export function isExternalToolAction(action: string): boolean {
  return action === "mcp_write" || action === "connector_write" || action.startsWith("composio:");
}

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

  return { action, behavior: defaultBehavior(action), thresholdCents, source: "default" };
}

/**
 * The code default for an action with no row: Tier 3 → "never" (sticky);
 * an explicit DEFAULT_BEHAVIORS entry; else "ask" — nothing fires without
 * an explicit opt-in (M1 authority.ts contract).
 */
export function defaultBehavior(action: string): AutomationBehaviorName {
  if (intrinsicTier(action) === 3) return "never";
  const explicit = DEFAULT_BEHAVIORS[action];
  if (explicit === "auto" && !autoAllowedFor(action)) return "ask";
  return explicit ?? "ask";
}

/**
 * May this action EVER be switched to auto? False for Tier 3 kinds (money,
 * contracts, deletion) and NEVER_AUTO_ACTIONS. The settings UI locks the
 * Auto-run choice where this is false and PUT rejects it.
 */
export function autoAllowedFor(action: string): boolean {
  if (action === WORKSPACE_DEFAULT_ACTION) return false;
  if (action.startsWith("composio:") && COMPOSIO_MONEY_TOOLKIT_RE.test(action.slice("composio:".length))) return false;
  return intrinsicTier(action) !== 3 && !NEVER_AUTO_ACTIONS.has(action);
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
    const never = NEVER_AUTO_ACTIONS.get(action);
    if (never) return `behavior=auto is not allowed for ${action}: ${never}.`;
    if (!autoAllowedFor(action)) return `behavior=auto is not allowed for ${action}: it moves money, so it always asks.`;
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
  /** ISO currency of amountCents (default: the threshold currency, USD). */
  currency?: string;
}

export interface AutoApprovalDecision {
  auto: boolean;
  tier: 0 | 1 | 2 | 3;
  resolved: ResolvedAutomation;
  /** Plain reason (shown in the run timeline / audit log). */
  reason: string;
  /**
   * Phase 14: may the person be offered "do this without asking" for this
   * call? True for every Tier 0–2 call that is not destructive and not in
   * NEVER_AUTO_ACTIONS (judged on the action's intrinsic tier — with the
   * toggle on — and its description). Never for Tier 3.
   */
  offerAuto: boolean;
}

/**
 * decideAutoApproval — PURE. Runs without asking ONLY when all hold:
 *   - a rule explicitly says "auto" for this agent (or every agent) — or the
 *     action's explicit code default is auto (DEFAULT_BEHAVIORS),
 *   - the call is not destructive and the action is not NEVER_AUTO,
 *   - the DoA evaluator puts it at Tier 0, 1 or 2 (Phase 14) — Tier 3
 *     (money, contracts, deletion; kind OR description) never,
 *   - any amount it carries is at or under the threshold in a known currency.
 * Every auto decision's reason names the rule (audit + run timeline).
 */
export function decideAutoApproval(
  rows: AutomationRowLike[],
  input: AutoApprovalInput,
): AutoApprovalDecision {
  const resolved = resolveAutomationFromRows(rows, input.action, input.agentKey);
  const action = { kind: input.action, description: input.description, amountCents: input.amountCents, currency: input.currency };
  const tier = evaluateTier(action, toTierSettings(resolved));
  // The tier the action has by nature (toggle on): what the offer is judged on.
  const intrinsic = evaluateTier(action, { ...toTierSettings(resolved), automationAllows: true });
  const never = NEVER_AUTO_ACTIONS.get(input.action);
  // Third-party tools: money words in the name / description count as Tier 3.
  const externalMoney =
    (isExternalToolAction(input.action) && EXTERNAL_TOOL_MONEY_RE.test(normalizeForTier(input.description ?? ""))) ||
    (input.action.startsWith("composio:") && !autoAllowedFor(input.action));
  const offerAuto = !input.destructive && !never && !externalMoney && tier !== 3 && intrinsic !== 3;
  const who =
    resolved.source === "default"
      ? "the default"
      : resolved.ruleAgentKey === ALL_AGENTS
        ? "every agent"
        : `agent ${resolved.ruleAgentKey}`;
  const no = (reason: string): AutoApprovalDecision => ({ auto: false, tier, resolved, reason, offerAuto });
  if (input.destructive) return no("destructive actions always ask");
  if (tier === 3 || intrinsic === 3 || externalMoney) {
    return { auto: false, tier: 3, resolved, reason: "Tier 3 actions (money and irreversible) can never run automatically", offerAuto: false };
  }
  if (never) return no(`${input.action}: ${never}`);
  if (resolved.behavior !== "auto") return no(`no auto-approve rule for ${input.action}`);
  if (input.amountCents !== undefined && input.amountCents !== null) {
    const cents = amountInDefaultCents(input.amountCents, input.currency, toTierSettings(resolved));
    if (cents === null) return no("the amount's currency is unknown, so it asks");
    if (cents > resolved.thresholdCents) return no(`the amount is over the ${input.action} threshold, so it asks`);
  }
  const ruleName = resolved.source === "default" ? `the default for ${input.action}` : `the ${input.action} rule for ${who}`;
  return { auto: true, tier, resolved, reason: `auto-approved by ${ruleName}`, offerAuto };
}

/**
 * Phase 14: DB-backed tier settings for the mission executor
 * (lib/authority/executor.ts deps.resolveTierSettings), agent-aware.
 */
export function automationTierSettingsFor(
  workspaceId: string,
  agentKey: string = ALL_AGENTS,
): (action: { kind: string }) => Promise<TierSettings> {
  return async (action) => toTierSettings(await resolveAutomation(workspaceId, action.kind, agentKey));
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
  /** Phase 14: the settings section (Agents and content, Operations, Connectors, Slack). */
  group: ActionGroup;
  /** Phase 14: false = Auto-run is locked (Tier 3 or NEVER_AUTO_ACTIONS). */
  autoAllowed: boolean;
  /** Phase 14: why Auto-run is locked (shown on the row), when it is. */
  lockReason?: string;
  /** Phase 14: the behavior with no row (DEFAULT_BEHAVIORS, else ask / never). */
  defaultBehavior: AutomationBehaviorName;
  /** Phase 14: an on/off switch (on = auto, off = never). */
  control?: "switch";
}

export const KNOWN_ACTIONS: KnownAction[] = KNOWN_ACTION_DEFS.map((d) => ({
  action: d.action,
  label: d.label,
  description: d.description,
  tier: intrinsicTier(d.action),
  group: actionGroup(d.action),
  autoAllowed: autoAllowedFor(d.action),
  ...(autoAllowedFor(d.action) ? {} : { lockReason: lockReasonFor(d.action) }),
  defaultBehavior: defaultBehavior(d.action),
  ...(d.control ? { control: d.control } : {}),
}));

/** Phase 14: the plain reason Auto-run is locked for an action (UI copy). */
export function lockReasonFor(action: string): string {
  const never = NEVER_AUTO_ACTIONS.get(action);
  if (never) return `${never[0]!.toUpperCase()}${never.slice(1)}.`;
  return "Money and irreversible actions always ask.";
}

export { TIER1_KINDS, DEFAULT_SMALL_ACTION_THRESHOLD_CENTS };
