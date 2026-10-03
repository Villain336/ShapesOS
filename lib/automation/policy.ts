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

export interface AutomationRowLike {
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
  source: "row" | "default";
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
): ResolvedAutomation {
  const byAction = new Map(rows.map((r) => [r.action, r]));
  const row = byAction.get(action);
  const defaultRow = byAction.get(WORKSPACE_DEFAULT_ACTION);

  const thresholdCents =
    row?.thresholdCents ??
    defaultRow?.thresholdCents ??
    DEFAULT_SMALL_ACTION_THRESHOLD_CENTS;

  if (row) {
    return { action, behavior: row.behavior, thresholdCents, source: "row" };
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
      select: { action: true, behavior: true, thresholdCents: true },
    }),
  );
}

/** DB-backed: resolve the effective automation for one action. */
export async function resolveAutomation(
  workspaceId: string,
  action: string,
): Promise<ResolvedAutomation> {
  const rows = await listAutomationRows(workspaceId);
  return resolveAutomationFromRows(rows, action);
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

const KNOWN_ACTION_DEFS: Array<Omit<KnownAction, "tier">> = [
  // Tier 1: low-blast-radius by nature (owned channels, internal notes).
  { action: "publish_owned", label: "Publish to owned channels", description: "Publish drafted content to channels you own (site, blog)." },
  { action: "post_owned_social", label: "Post to owned social", description: "Post to your own connected social accounts." },
  { action: "schedule_owned_content", label: "Schedule owned content", description: "Queue content for your owned channels." },
  { action: "update_listing", label: "Update listing", description: "Small edits to business listings (hours, photos)." },
  { action: "send_internal_note", label: "Send internal note", description: "Notes to your own team, never external." },
  { action: "refresh_owned_page", label: "Refresh owned page", description: "Re-crawl / refresh a page you own." },
  // Tier 2: significant — external audience or above the threshold.
  { action: "publish_external", label: "Publish externally", description: "Publish to audiences you don't own. Always asks." },
  { action: "send_outreach_email", label: "Send outreach email", description: "Cold or campaign email to external recipients." },
  { action: "schedule_social_external", label: "Schedule external social", description: "Schedule posts to public social audiences." },
  { action: "update_campaign_budget", label: "Update campaign budget", description: "Change a campaign's budget (non-custodial pool)." },
  // Tier 3: never — hard deny, un-overridable.
  { action: "buy_media", label: "Buy media", description: "Spend money on ads. Never automated — autopilot never buys." },
  { action: "sign_contract", label: "Sign contract", description: "Sign or execute any contract or agreement." },
  { action: "delete_campaign_data", label: "Delete campaign data", description: "Delete or purge campaign data." },
  { action: "issue_refund", label: "Issue refund", description: "Move money back to a customer." },
];

export const KNOWN_ACTIONS: KnownAction[] = KNOWN_ACTION_DEFS.map((d) => ({
  ...d,
  tier: intrinsicTier(d.action),
}));

export { TIER1_KINDS, DEFAULT_SMALL_ACTION_THRESHOLD_CENTS };
