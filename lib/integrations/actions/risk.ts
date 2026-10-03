// Marketr — Phase 14: action risk classification (spec §3).
//
// Composio ships no native human-in-the-loop approval, so the trust ladder
// is OURS. Every tool gets a risk tier derived from its action name, with
// manual per-workspace overrides winning over the derivation.
//
// Tiers (locked: conservative gating):
//   low    — read-only (list/get/search): executes, always logged.
//   medium — writes (create/update/send/upload): REQUIRES approval…
//            …EXCEPT draft-creators (create-as-draft): auto, reviewable,
//            the artifact exists only as a draft until a human sends it.
//   high   — destructive (delete/revoke/cancel/archive): requires approval
//            + explicit confirmation; bulk needs per-item review.
//
// classifyAction() is pure and fixture-testable. Overrides come from
// WorkspaceSettings.toolTierOverrides (tool slug → tier).

export type RiskTier = "low" | "medium" | "high";

export interface ClassifiedAction {
  toolName: string;
  tier: RiskTier;
  /** Create-as-draft tools: medium tier but auto-executable + reviewable. */
  draftCreator: boolean;
  /** May execute without a human approval (still always logged). */
  autoExecutable: boolean;
  /** Whether a manual override decided the tier. */
  overridden: boolean;
  /**
   * Whether an override tried to go below the derived tier and the
   * conservative floor clamped it. Locked invariant: overrides may
   * ESCALATE risk, never downgrade — every external write and all
   * destructive actions go through the approve/deny queue.
   */
  clamped: boolean;
  /**
   * Phase 15: whether the derivation confidently classified the tool.
   * False EXACTLY when the universal conservative floor caught it —
   * tier is then high AND autoExecutable is false, so the gate's
   * high-tier second-confirmation path is required (unclassified =
   * HIGH-GATED, locked).
   */
  classified: boolean;
}

// Phase 15: verb stems + derivation live in derive.ts (pattern lists,
// description fallback, per-app override table, conservative floor).
// Re-exported here for any consumer importing them from risk.ts.
export {
  DESTRUCTIVE_PATTERNS,
  WRITE_PATTERNS,
  READ_PATTERNS,
  PER_APP_TIER_OVERRIDES,
  deriveTier,
  isValidTier,
  type DerivedTier,
} from "./derive";

import { deriveTier, isValidTier, isToolkitAutoReadLive } from "./derive";

const TIER_RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };

/** The riskier of two tiers. */
function riskier(a: RiskTier, b: RiskTier): RiskTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/** Derive the base tier from the tool slug's verb stems (Phase 15: now
 *  delegates to derive.ts, which adds read patterns, description fallback,
 *  a per-app override table, and the conservative floor). */
export function deriveTierFromName(toolName: string): RiskTier {
  return deriveTier(toolName).tier;
}

// Tools whose ONLY effect is a draft artifact the human must send/approve
// in the native app. Medium tier, auto-executable, reviewable.
//
// EXACT allow-list (Phase 1): substring patterns ("DRAFT" anywhere) made
// GMAIL_SEND_DRAFT — which SENDS — auto-executable. A slug is a
// draft-creator only when it is listed here verbatim; anything else that
// merely mentions a draft goes through the normal approval queue.
export const DRAFT_CREATOR_SLUGS: ReadonlySet<string> = new Set([
  "GMAIL_CREATE_DRAFT",
  "GMAIL_CREATE_EMAIL_DRAFT", // Composio's Gmail slug for the same action
  "NOTION_CREATE_PAGE", // pages start as private drafts in the workspace
]);

export function isDraftCreator(toolName: string): boolean {
  return DRAFT_CREATOR_SLUGS.has(toolName.trim().toUpperCase());
}

export interface ClassifyOptions {
  /** Marketr app key (e.g. "stripe") — activates the per-app override table. */
  appKey?: string;
  /** Tool description — enables the description-text fallback when the
   *  slug is ambiguous. */
  description?: string;
  /**
   * Phase 15 slice 6 — the toolkit the tool resolved to (null when it
   * resolves to no known toolkit). The auto-read accuracy gate
   * (derive.ts isToolkitAutoReadLive, spec §6) escalates a derived LOW /
   * auto-executable tier to MEDIUM when the toolkit is not auto-read-live:
   * reads stay usable (approval-gated) but never run silent until the
   * sampled tier-accuracy eval passes for the toolkit (agreement ≥ target,
   * committed result, fresh vs the gold set).
   *
   * undefined = the caller did not resolve a toolkit (direct unit-test
   * calls) → the gate is skipped. The gate/agent paths always resolve, so
   * only they enforce it. This keeps classifyAction's pure-unit contract
   * unchanged while the load-bearing paths stay fail-closed.
   */
  toolkitSlug?: string | null;
}

/**
 * Classify a tool. Manual overrides (from
 * WorkspaceSettings.toolTierOverrides) may ESCALATE risk but never
 * downgrade below the derived tier (conservative floor, locked): a
 * derived high can never become medium/low, and a derived external
 * write can never become low.
 *
 * Auto-executability: reads (low) and draft-creators (medium) may run
 * automatically — but an explicit override escalation to high revokes
 * the draft-creator privilege.
 *
 * Phase 15: derivation comes from deriveTier() (slug patterns,
 * description fallback, per-app table, conservative floor). A tool the
 * classifier cannot confidently derive (classified=false) lands at tier
 * high with autoExecutable=false — HIGH-GATED: the gate's existing
 * high-tier second-confirmation path (executeApproved's
 * destructiveConfirm) is required. Nothing auto-runs unclassified.
 *
 * Phase 15 slice 6: the auto-read accuracy gate (spec §6). When the caller
 * passes opts.toolkitSlug, a derived LOW tier only stays low (silent
 * auto-execution) if isToolkitAutoReadLive(toolkitSlug) — otherwise it is
 * escalated to MEDIUM (gated, still executable with approval: reads stay
 * usable, just not silent). The gate escalates, never downgrades: manual
 * overrides are still clamped at the (possibly gate-raised) floor.
 */
export function classifyAction(
  toolName: string,
  overrides?: Record<string, string> | null,
  opts?: ClassifyOptions,
): ClassifiedAction {
  const slug = toolName.toUpperCase();
  const override = overrides?.[slug] ?? overrides?.[toolName];
  const draftCreator = isDraftCreator(toolName);
  const derived = deriveTier(toolName, opts?.description, opts?.appKey);
  // Slice 6 — auto-read gate (escalation only, never a downgrade):
  // a derived low/auto-executable tier goes live only for toolkits that
  // passed the sampled tier-accuracy eval. opts.toolkitSlug === undefined
  // means the caller never resolved a toolkit (direct unit calls) → the
  // gate is skipped; null or a slug is always consulted, fail-closed.
  const gateEscalated =
    opts?.toolkitSlug !== undefined &&
    derived.tier === "low" &&
    !isToolkitAutoReadLive(opts.toolkitSlug);
  const baseTier: RiskTier = gateEscalated ? "medium" : derived.tier;
  if (override !== undefined && isValidTier(override)) {
    const tier = riskier(baseTier, override);
    return {
      toolName,
      tier,
      draftCreator,
      autoExecutable:
        derived.classified &&
        (tier === "low" ||
          (draftCreator && tier === "medium" && !gateEscalated && override !== "high")),
      overridden: true,
      clamped: TIER_RANK[override] < TIER_RANK[baseTier],
      classified: derived.classified,
    };
  }
  return {
    toolName,
    tier: baseTier,
    draftCreator,
    autoExecutable:
      derived.classified &&
      (baseTier === "low" || (draftCreator && baseTier === "medium" && !gateEscalated)),
    overridden: false,
    clamped: false,
    classified: derived.classified,
  };
}

// ---------------------------------------------------------------------------
// v1 action catalog (spec §6): Gmail, Google Sheets, Slack, HubSpot, Notion.
// Each entry pins the EXPECTED tier — the eval asserts the classifier
// agrees, so catalog drift fails the build instead of silently gating wrong.
// ---------------------------------------------------------------------------

export interface CatalogTool {
  slug: string;
  appKey: string;
  label: string;
  expectedTier: RiskTier;
  draftCreator?: boolean;
}

export const V1_ACTION_CATALOG: CatalogTool[] = [
  // Gmail — reads
  { slug: "GMAIL_LIST_MESSAGES", appKey: "gmail", label: "List messages", expectedTier: "low" },
  { slug: "GMAIL_GET_MESSAGE", appKey: "gmail", label: "Read a message", expectedTier: "low" },
  { slug: "GMAIL_SEARCH_MESSAGES", appKey: "gmail", label: "Search messages", expectedTier: "low" },
  { slug: "GMAIL_LIST_THREADS", appKey: "gmail", label: "List threads", expectedTier: "low" },
  // Gmail — draft creators (auto, reviewable)
  { slug: "GMAIL_CREATE_DRAFT", appKey: "gmail", label: "Create email draft", expectedTier: "medium", draftCreator: true },
  // Gmail — writes (gated)
  { slug: "GMAIL_SEND_EMAIL", appKey: "gmail", label: "Send email", expectedTier: "medium" },
  { slug: "GMAIL_REPLY_TO_THREAD", appKey: "gmail", label: "Reply in thread", expectedTier: "medium" },
  // Gmail — destructive (gated + confirm)
  { slug: "GMAIL_DELETE_MESSAGE", appKey: "gmail", label: "Delete message", expectedTier: "high" },
  { slug: "GMAIL_TRASH_MESSAGE", appKey: "gmail", label: "Trash message", expectedTier: "high" },
  // Google Sheets — reads
  { slug: "GOOGLE_SHEETS_GET_SPREADSHEET", appKey: "google-sheets", label: "Read spreadsheet", expectedTier: "low" },
  { slug: "GOOGLE_SHEETS_LIST_SPREADSHEETS", appKey: "google-sheets", label: "List spreadsheets", expectedTier: "low" },
  // Google Sheets — writes (gated)
  { slug: "GOOGLE_SHEETS_UPDATE_VALUES", appKey: "google-sheets", label: "Update cells", expectedTier: "medium" },
  { slug: "GOOGLE_SHEETS_APPEND_VALUES", appKey: "google-sheets", label: "Append rows", expectedTier: "medium" },
  { slug: "GOOGLE_SHEETS_CREATE_SPREADSHEET", appKey: "google-sheets", label: "Create spreadsheet", expectedTier: "medium" },
  // Slack — reads
  { slug: "SLACK_LIST_CHANNELS", appKey: "slack", label: "List channels", expectedTier: "low" },
  { slug: "SLACK_GET_CONVERSATION_HISTORY", appKey: "slack", label: "Read channel history", expectedTier: "low" },
  { slug: "SLACK_SEARCH_MESSAGES", appKey: "slack", label: "Search messages", expectedTier: "low" },
  // Slack — writes (gated)
  { slug: "SLACK_SEND_MESSAGE", appKey: "slack", label: "Send message", expectedTier: "medium" },
  { slug: "SLACK_POST_MESSAGE", appKey: "slack", label: "Post message", expectedTier: "medium" },
  // Slack — destructive (gated + confirm)
  { slug: "SLACK_DELETE_MESSAGE", appKey: "slack", label: "Delete message", expectedTier: "high" },
  // HubSpot — reads
  { slug: "HUBSPOT_LIST_CONTACTS", appKey: "hubspot", label: "List contacts", expectedTier: "low" },
  { slug: "HUBSPOT_GET_CONTACT", appKey: "hubspot", label: "Read contact", expectedTier: "low" },
  { slug: "HUBSPOT_LIST_DEALS", appKey: "hubspot", label: "List deals", expectedTier: "low" },
  { slug: "HUBSPOT_SEARCH_CRM", appKey: "hubspot", label: "Search CRM", expectedTier: "low" },
  // HubSpot — writes (gated)
  { slug: "HUBSPOT_CREATE_CONTACT", appKey: "hubspot", label: "Create contact", expectedTier: "medium" },
  { slug: "HUBSPOT_UPDATE_CONTACT", appKey: "hubspot", label: "Update contact", expectedTier: "medium" },
  { slug: "HUBSPOT_CREATE_DEAL", appKey: "hubspot", label: "Create deal", expectedTier: "medium" },
  // HubSpot — destructive (gated + confirm)
  { slug: "HUBSPOT_DELETE_CONTACT", appKey: "hubspot", label: "Delete contact", expectedTier: "high" },
  { slug: "HUBSPOT_ARCHIVE_CONTACT", appKey: "hubspot", label: "Archive contact", expectedTier: "high" },
  // Notion — reads
  { slug: "NOTION_LIST_PAGES", appKey: "notion", label: "List pages", expectedTier: "low" },
  { slug: "NOTION_GET_PAGE", appKey: "notion", label: "Read page", expectedTier: "low" },
  { slug: "NOTION_SEARCH", appKey: "notion", label: "Search workspace", expectedTier: "low" },
  // Notion — draft creators (auto, reviewable)
  { slug: "NOTION_CREATE_PAGE", appKey: "notion", label: "Create page draft", expectedTier: "medium", draftCreator: true },
  // Notion — writes (gated)
  { slug: "NOTION_UPDATE_PAGE", appKey: "notion", label: "Update page", expectedTier: "medium" },
  // Notion — destructive (gated + confirm)
  { slug: "NOTION_DELETE_PAGE", appKey: "notion", label: "Delete page", expectedTier: "high" },
  { slug: "NOTION_ARCHIVE_PAGE", appKey: "notion", label: "Archive page", expectedTier: "high" },
];

/** v1 app shortlist with connect metadata. */
export interface ComposioApp {
  appKey: string;
  label: string;
  toolkitSlug: string;
  description: string;
}

export const V1_COMPOSIO_APPS: ComposioApp[] = [
  { appKey: "gmail", label: "Gmail", toolkitSlug: "gmail", description: "Read, draft, and (with approval) send email." },
  { appKey: "google-sheets", label: "Google Sheets", toolkitSlug: "google_sheets", description: "Read and (with approval) write spreadsheets." },
  { appKey: "slack", label: "Slack", toolkitSlug: "slack", description: "Read channels and (with approval) post messages." },
  { appKey: "hubspot", label: "HubSpot", toolkitSlug: "hubspot", description: "Read CRM records and (with approval) create or update them." },
  { appKey: "notion", label: "Notion", toolkitSlug: "notion", description: "Read pages, draft new ones, update with approval." },
];

export function getV1App(appKey: string): ComposioApp | undefined {
  return V1_COMPOSIO_APPS.find((a) => a.appKey === appKey);
}
