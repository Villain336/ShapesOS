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
}

// Verb stems that mark a tool destructive. Checked before write verbs so
// e.g. DELETE_LABEL (destructive) beats a generic match.
const DESTRUCTIVE_PATTERNS = [
  "DELETE",
  "REMOVE",
  "REVOKE",
  "ARCHIVE",
  "CANCEL",
  "DESTROY",
  "PURGE",
  "TRASH",
  "UNSUBSCRIBE",
  "BLOCK",
];

// Verb stems that mark a tool a write.
const WRITE_PATTERNS = [
  "SEND",
  "CREATE",
  "UPDATE",
  "POST",
  "PUBLISH",
  "UPLOAD",
  "ADD",
  "INSERT",
  "SET",
  "MODIFY",
  "EDIT",
  "PATCH",
  "SUBMIT",
  "SHARE",
  "INVITE",
  "SCHEDULE",
  "REPLY",
  "APPEND",
];

// Tools whose ONLY effect is a draft artifact the human must send/approve
// in the native app. Medium tier, auto-executable, reviewable.
const DRAFT_CREATOR_PATTERNS = ["DRAFT", "_PROPOSAL", "PROPOSE_"];

// Explicit draft-creator slugs that don't match the patterns above.
const DRAFT_CREATOR_SLUGS = new Set([
  "GMAIL_CREATE_DRAFT",
  "NOTION_CREATE_PAGE", // pages start as private drafts in the workspace
]);

/** Derive the base tier from the tool slug's verb stems. */
export function deriveTierFromName(toolName: string): RiskTier {
  const upper = toolName.toUpperCase();
  if (DESTRUCTIVE_PATTERNS.some((p) => upper.includes(p))) return "high";
  if (WRITE_PATTERNS.some((p) => upper.includes(p))) return "medium";
  return "low";
}

export function isDraftCreator(toolName: string): boolean {
  const upper = toolName.toUpperCase();
  return (
    DRAFT_CREATOR_SLUGS.has(upper) ||
    DRAFT_CREATOR_PATTERNS.some((p) => upper.includes(p))
  );
}

export function isValidTier(t: unknown): t is RiskTier {
  return t === "low" || t === "medium" || t === "high";
}

/**
 * Classify a tool. Manual overrides (from
 * WorkspaceSettings.toolTierOverrides) win over derivation.
 */
export function classifyAction(
  toolName: string,
  overrides?: Record<string, string> | null,
): ClassifiedAction {
  const slug = toolName.toUpperCase();
  const override = overrides?.[slug] ?? overrides?.[toolName];
  const draftCreator = isDraftCreator(toolName);
  if (override !== undefined && isValidTier(override)) {
    return {
      toolName,
      tier: override,
      draftCreator,
      autoExecutable: override === "low" || draftCreator,
      overridden: true,
    };
  }
  const tier = deriveTierFromName(toolName);
  return {
    toolName,
    tier,
    draftCreator,
    autoExecutable: tier === "low" || draftCreator,
    overridden: false,
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
