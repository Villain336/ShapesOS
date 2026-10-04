// ShapesOS — the automation action catalog (PURE: safe to import in the
// browser). lib/automation/policy.ts attaches each action's tier from the DoA
// evaluator; the chat uses the labels to say what a per-agent rule covers.

export const KNOWN_ACTION_DEFS: ReadonlyArray<{ action: string; label: string; description: string }> = [
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
  // Phase 5: the agent tool actions per-agent rules can switch to auto.
  // Drafts, audits, reports and research are Tier 0; they still cost
  // compute, so they ask until a rule says otherwise.
  { action: "draft_content", label: "Draft content", description: "Write a content draft (stays a draft)." },
  { action: "audit_site", label: "Audit a site", description: "Run an SEO audit of a connected site." },
  { action: "report_generate", label: "Generate a report", description: "Build a branded PDF report." },
  { action: "search_keywords", label: "Research keywords", description: "Look up keyword ideas (metered data call)." },
  { action: "search_web", label: "Research a question", description: "Answer a question from web sources (metered)." },
  { action: "draft_qr_code", label: "Design a QR code", description: "Design a styled QR code." },
  { action: "draft_image", label: "Generate an image", description: "Generate an image with OpenAI's image model and save it to the project's files (metered)." },
  { action: "draft_invoice", label: "Draft an invoice", description: "Create a draft invoice (sending always asks)." },
  { action: "draft_purchase_order", label: "Draft a purchase order", description: "Create a draft PO (sending always asks)." },
  // Phase 8 (ship + browser): anything that leaves the sandbox. Tier 2 —
  // these always ask, whatever a rule says.
  { action: "push_branch", label: "Push a branch", description: "Push the run's commits to its own shapes/<run> branch on GitHub. Always asks." },
  { action: "open_pr", label: "Open a pull request", description: "Open or update the run's pull request on GitHub. Always asks." },
  { action: "browser_act", label: "Act in a browser", description: "Click, fill and submit on a web page in a recorded browser. Always asks." },
];


const LABELS = new Map(KNOWN_ACTION_DEFS.map((d) => [d.action, d.label]));

/** "Draft content", "Post to owned social" … (falls back to the raw kind). */
export function actionLabel(action: string): string {
  return LABELS.get(action) ?? action.replace(/_/g, " ");
}
