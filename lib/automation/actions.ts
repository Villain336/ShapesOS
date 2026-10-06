// ShapesOS — the automation action catalog (PURE: safe to import in the
// browser). lib/automation/policy.ts attaches each action's tier from the DoA
// evaluator; the chat uses the labels to say what a per-agent rule covers.
//
// Phase 14 (approvals): every Tier 0–2 action can be switched to Auto-run
// (owner decision 2026-10-05); money and irreversible actions (Tier 3) and
// destructive tools never can. `group` places a row in a section of
// Settings → Automation (missing = "agents").

/** Sections of Settings → Automation. */
export type ActionGroup = "agents" | "ops" | "connectors" | "slack";

export const ACTION_GROUP_LABELS: Readonly<Record<ActionGroup, string>> = {
  agents: "Agents and content",
  ops: "Operations",
  connectors: "Connectors",
  slack: "Slack",
};

export interface KnownActionDef {
  action: string;
  label: string;
  description: string;
  group?: ActionGroup;
  /** Phase 14: shown as an on/off switch (on = auto, off = never) instead of Ask first / Auto-run / Off. */
  control?: "switch";
}

export const KNOWN_ACTION_DEFS: ReadonlyArray<KnownActionDef> = [
  // Tier 1: low-blast-radius by nature (owned channels, internal notes).
  { action: "publish_owned", label: "Publish to owned channels", description: "Publish drafted content to channels you own (site, blog)." },
  { action: "post_owned_social", label: "Post to owned social", description: "Post to your own connected social accounts." },
  { action: "schedule_owned_content", label: "Schedule owned content", description: "Queue content for your owned channels." },
  { action: "update_listing", label: "Update listing", description: "Small edits to business listings (hours, photos)." },
  { action: "send_internal_note", label: "Send internal note", description: "Notes to your own team, never external." },
  { action: "refresh_owned_page", label: "Refresh owned page", description: "Re-crawl / refresh a page you own." },
  // Tier 2: significant — external audience or above the threshold. Asks
  // unless a rule says Auto-run (Phase 14).
  { action: "publish_external", label: "Publish externally", description: "Publish to audiences you don't own." },
  { action: "send_outreach_email", label: "Send outreach email", description: "Cold or campaign email to external recipients." },
  { action: "schedule_social_external", label: "Schedule external social", description: "Schedule posts to public social audiences." },
  // Tier 3: never — hard deny, un-overridable.
  { action: "update_campaign_budget", label: "Update campaign budget", description: "Change how much a campaign spends. Money: never automated." },
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
  { action: "draft_invoice", label: "Draft an invoice", description: "Create a draft invoice (sending always asks).", group: "ops" },
  { action: "draft_purchase_order", label: "Draft a purchase order", description: "Create a draft PO (sending always asks).", group: "ops" },
  // Phase 14 (approvals): the remaining chat tools' actions (lib/chat/tools.ts TOOL_ACTION).
  { action: "run_workflow", label: "Run a workflow", description: "Start one of the project's saved workflows." },
  { action: "trigger_automation_flow", label: "Trigger an automation flow", description: "Start a connected automation flow." },
  { action: "approve_autopilot_item", label: "Approve an autopilot item", description: "Approve a pending autopilot draft so it can publish to your own site." },
  // Phase 9 (orchestrator): what a mission's drafter asks to do with a draft
  // (lib/orchestrator/executors/drafter.ts).
  { action: "publish_content", label: "Publish a mission's content", description: "Publish a content draft a mission wrote." },
  { action: "outreach_send", label: "Send a mission's outreach", description: "Send an outreach draft a mission wrote." },
  { action: "publish_brief", label: "Publish a mission's brief", description: "Publish a campaign brief a mission wrote." },
  // Phase 8 (ship + browser): anything that leaves the sandbox.
  { action: "push_branch", label: "Push a branch", description: "Push the run's commits to its own shapes/<run> branch on GitHub." },
  { action: "open_pr", label: "Open a pull request", description: "Open or update the run's pull request on GitHub." },
  { action: "browser_act", label: "Act in a browser", description: "Click, fill and submit on any web page — it could buy or delete something there, so it always asks." },
  { action: "edit_sandbox_files", label: "Edit files in the code sandbox", description: "Write or change files inside the run's isolated sandbox (checkpointed; nothing leaves it)." },
  { action: "run_sandbox_command", label: "Run a command in the code sandbox", description: "Run a shell command or the tests inside the run's isolated sandbox." },
  // Phase 9 (apps): internal mini-apps (lib/apps/tools.ts).
  { action: "draft_app_spec", label: "Draft a mini-app", description: "Write or change a mini-app's draft spec (an admin publishes it)." },
  { action: "write_app_record", label: "Write a mini-app record", description: "Add or change a record in a published mini-app." },
  { action: "delete_app_record", label: "Delete a mini-app record", description: "Delete a record from a published mini-app. Never automated." },
  // Phase 10 (finance): ops finance tools (lib/chat/ops-finance-tools.ts).
  { action: "draft_quote", label: "Draft a quote", description: "Create a draft quote (sending always asks).", group: "ops" },
  { action: "draft_vendor_bill", label: "Draft a vendor bill", description: "Create a draft vendor bill (posting and paying are a person's job).", group: "ops" },
  { action: "convert_quote", label: "Convert a quote", description: "Turn a quote into a draft invoice or order.", group: "ops" },
  { action: "submit_expense_claim", label: "Submit an expense claim", description: "Create and submit an expense claim (approving and paying it are a person's job).", group: "ops" },
  { action: "send_invoice", label: "Send an invoice", description: "Propose sending an invoice to a customer. Money: never automated.", group: "ops" },
  { action: "mark_invoice_paid", label: "Mark an invoice paid", description: "Propose marking an invoice paid. Money: never automated.", group: "ops" },
  { action: "record_payment", label: "Record a payment", description: "Propose recording a customer payment on an invoice. Never automated.", group: "ops" },
  { action: "post_journal_entry", label: "Post a journal entry", description: "Propose a manual entry in the books. Never automated.", group: "ops" },
  // Phase 10 (ops-core): CRM, projects, helpdesk, inventory agent tools.
  { action: "write_crm_record", label: "Write CRM records", description: "Create contacts, companies and deals, move deal stages, convert leads.", group: "ops" },
  { action: "create_project", label: "Create a project", description: "Create a project with its milestones.", group: "ops" },
  { action: "write_project_record", label: "Write project records", description: "Create tasks and log time on projects.", group: "ops" },
  { action: "request_leave", label: "Draft a leave request", description: "Draft a leave request for a team member (approving it is a person's job).", group: "ops" },
  { action: "approve_leave", label: "Ask to approve leave", description: "Propose approving a leave request (a person decides in the approvals queue).", group: "ops" },
  { action: "launch_workflow", label: "Ask to run an operations workflow", description: "Propose running an operations workflow (a person decides in the approvals queue).", group: "ops" },
  { action: "write_ticket", label: "Open or close tickets", description: "Open helpdesk tickets or mark them solved/closed.", group: "ops" },
  { action: "send_ticket_reply", label: "Reply to a ticket", description: "Email a customer from a helpdesk ticket.", group: "ops" },
  { action: "move_stock", label: "Draft a stock move", description: "Create a draft move between stock locations (a person books it).", group: "ops" },
  { action: "set_reorder_rule", label: "Set a reorder rule", description: "Create or change a min/max reorder rule.", group: "ops" },
  // Phase 10 (store): storefront listings (lib/chat/ops-store-tools.ts).
  { action: "write_store_listing", label: "Change the online store", description: "Show, hide or edit a product in the public online store.", group: "ops" },
  // Phase 11 (seotools): SEO + document tools.
  { action: "draft_structured_data", label: "Draft structured data", description: "Add schema.org JSON-LD to a site as a draft revision (a person applies it)." },
  { action: "draft_document", label: "Create a Word document", description: "Write a .docx and save it to the workspace files." },
  { action: "draft_spreadsheet", label: "Create a spreadsheet", description: "Write an .xlsx and save it to the workspace files." },
  { action: "fetch_web_pages", label: "Read web pages", description: "Scrape or crawl web pages as markdown via Context.dev (metered, daily budget)." },
  // Phase 11 (bizsync): commerce + accounting connectors.
  { action: "import_commerce_data", label: "Import store data", description: "Pull products, stock, orders and customers from a connected store into Ops.", group: "connectors" },
  { action: "update_store_inventory", label: "Update store stock", description: "Set stock levels on a connected online store.", group: "connectors" },
  { action: "post_to_accounting", label: "Post to accounting software", description: "Export invoices, bills, payments and journals to QuickBooks or Xero. Never automated.", group: "connectors" },
  // Phase 12 (mfgpos): manufacturing + point of sale (lib/chat/ops-mfgpos-tools.ts).
  { action: "draft_manufacturing_order", label: "Draft a manufacturing order", description: "Create a draft manufacturing order (completing always asks).", group: "ops" },
  { action: "confirm_manufacturing_order", label: "Confirm a manufacturing order", description: "Confirm a manufacturing order: components and work orders (no stock or money moves).", group: "ops" },
  { action: "log_work_order_time", label: "Log time on a work order", description: "Add minutes worked to a manufacturing work order.", group: "ops" },
  { action: "complete_manufacturing_order", label: "Complete a manufacturing order", description: "Propose completing a manufacturing order: stock moves and costing in the books. Never automated.", group: "ops" },
  { action: "close_pos_session", label: "Close a till session", description: "Propose posting a till session's takings to the books. Never automated.", group: "ops" },
  // Phase 12 (people): payroll + events (lib/chat/ops-people-tools.ts).
  { action: "draft_pay_run", label: "Draft a pay run", description: "Create and compute a pay run (approving and posting it are a person's job).", group: "ops" },
  { action: "approve_pay_run", label: "Approve a pay run", description: "Propose approving payroll. Never automated.", group: "ops" },
  { action: "post_pay_run", label: "Post a pay run", description: "Propose posting payroll to the books. Never automated.", group: "ops" },
  // Phase 14 (connectors): the Gusto payroll connector. Sending a pay run is
  // money (Tier 3, TIER3_EXACT_KINDS); saving suggested employee matches is not.
  { action: "send_payroll_to_provider", label: "Send payroll to Gusto", description: "Write a pay run's hours into Gusto's open payroll (Gusto pays people from it). Never automated.", group: "ops" },
  { action: "write_gusto", label: "Change Gusto matches", description: "Save suggested Gusto employee matches for a person to confirm.", group: "connectors" },
  { action: "write_event", label: "Change events", description: "Create draft events and register people for events.", group: "ops" },
  // Phase 13 (twincore): the digital twin (lib/chat/ops-twin-tools.ts).
  { action: "book_dock", label: "Book a dock", description: "Book a truck onto a free dock door of a twin site (an internal site operation).", group: "ops" },
  { action: "assign_equipment", label: "Assign equipment", description: "Give a forklift or cart a task, or set it available / charging.", group: "ops" },
  { action: "draft_site_layout", label: "Draft a site layout", description: "Draft a digital twin site layout from a description or floor-plan image (a person publishes it).", group: "ops" },
  // Phase 14 (approvals): publishing a twin layout (the OPS_TWIN_SITE_PUBLISH
  // gate in lib/ops/gate.ts — no money moves, so a rule may approve it).
  { action: "publish_site_layout", label: "Publish a twin site layout", description: "Publish a digital twin site layout so everyone sees it live.", group: "ops" },
  // Phase 14 (approvals): connector writes, one switch per connector
  // (lib/agents/grants.ts connectorAction). Writes with their own mapping
  // (email sends, CRM pulls, owned-channel publishes …) use those actions.
  { action: "write_slack", label: "Post in Slack", description: "The agent's own Slack tools: post a message or reply in a thread.", group: "connectors" },
  { action: "write_airtable", label: "Write Airtable records", description: "Create or change records in an Airtable base.", group: "connectors" },
  { action: "write_google_calendar", label: "Change Google Calendar", description: "Create or change events and invite attendees.", group: "connectors" },
  { action: "write_outlook_calendar", label: "Change Outlook Calendar", description: "Create or change events and invite attendees.", group: "connectors" },
  { action: "write_google_business_profile", label: "Post on Google Business Profile", description: "Reply to reviews and publish local posts.", group: "connectors" },
  { action: "write_hubspot", label: "Push to HubSpot", description: "Send CRM records to HubSpot.", group: "connectors" },
  { action: "write_shopify", label: "Change Shopify settings", description: "Other Shopify writes, e.g. subscribing the store's webhooks.", group: "connectors" },
  // Phase 15.4 (zernio): ads through Zernio (lib/connectors/m21/native/zernio.ts).
  // Creating an ad is buy_media and a budget raise is update_campaign_budget
  // (both Tier 3, above); resuming restarts spend (Tier 3, TIER3_EXACT_KINDS).
  { action: "pause_ad_campaign", label: "Pause an ad campaign", description: "Pause a campaign on its ad network so it stops delivering (Zernio).", group: "connectors" },
  { action: "resume_ad_campaign", label: "Resume an ad campaign", description: "Turn a paused campaign back on (Zernio). It restarts ad spend: never automated.", group: "connectors" },
  { action: "lower_campaign_budget", label: "Lower a campaign budget", description: "Lower a campaign's budget when a live read confirms it is lower than today's (Zernio). Raising always asks.", group: "connectors" },
  { action: "write_ad_lead_form", label: "Create ad lead forms", description: "Create a lead form for ads on a Facebook Page or a LinkedIn ad account (Zernio).", group: "connectors" },
  { action: "write_ad_audience", label: "Create ad audiences", description: "Create a custom audience on an ad account (Zernio).", group: "connectors" },
  { action: "mcp_write", label: "Write through a custom MCP server", description: "A custom MCP server's write tools that have no action of their own.", group: "connectors" },
  { action: "money_connector_write", label: "Write to accounting or payroll apps", description: "Any other write to QuickBooks, Xero or payroll. Money: never automated.", group: "connectors" },
  // Phase 14 (approvals): Slack replies (lib/slack/mention.ts). slack_reply
  // defaults to Auto-run (today's behaviour); slack_placeholder defaults to
  // Off (lib/automation/policy.ts DEFAULT_BEHAVIORS).
  { action: "slack_reply", label: "Reply in Slack", description: "Post the agent's answer (and status messages) back into the Slack thread that asked. Ask first holds each reply for your OK in ShapesOS.", group: "slack" },
  { action: "slack_placeholder", label: "Say a reply is waiting", description: "While a Slack reply waits for your OK, post a one-line note in the thread. Off by default.", group: "slack", control: "switch" },
  // Phase 18.2 (WS=comms): the communication apps (lib/comms/tools.ts).
  // Reminders are the person's own to-dos — Tier 1 (TIER1_KINDS).
  { action: "create_reminder", label: "Add a reminder", description: "Add a to-do with a due time to the person's own Reminders list." },
  { action: "complete_reminder", label: "Complete a reminder", description: "Tick one of the person's own reminders done." },
  // Contacts: merging two people's cards (each record stays in its own app) — Tier 1.
  // Mail: drafting a reply is a draft (Tier 0); a social DM is external (Tier 2).
  { action: "draft_mail_reply", label: "Draft a mail reply", description: "Write a reply into the person's Mail drafts (nothing is sent)." },
  { action: "send_social_dm", label: "Send a social DM", description: "Reply to a customer in a social DM (Instagram, Messenger, WhatsApp …) through Zernio.", group: "connectors" },
  { action: "confirm_contact_merge", label: "Merge contacts", description: "Confirm a merge suggestion so two contact cards become one (the records stay in their own apps; a person can unlink).", group: "ops" },
];


/**
 * Phase 14 (approvals): the automation action each autopilot item kind
 * stands for (lib/seo/autopilot-service.ts). A rule set to Auto-run for it
 * (Settings → Automation, or "Do this without asking" on the approval card)
 * approves new items of that kind as they are generated — audited, naming
 * the rule.
 *   decay_refresh     → refresh_owned_page (Tier 1: a page you own)
 *   keyword_brief     → draft_content      (Tier 0: a draft)
 *   programmatic_page → publish_owned      (Tier 1: a new page on your site)
 */
export const AUTOPILOT_KIND_ACTION = {
  decay_refresh: "refresh_owned_page",
  keyword_brief: "draft_content",
  programmatic_page: "publish_owned",
} as const satisfies Record<"decay_refresh" | "keyword_brief" | "programmatic_page", string>;

const LABELS = new Map(KNOWN_ACTION_DEFS.map((d) => [d.action, d.label]));

/** The settings section an action belongs to. */
export function actionGroup(action: string): ActionGroup {
  return KNOWN_ACTION_DEFS.find((d) => d.action === action)?.group ?? "agents";
}

/** "Draft content", "Post to owned social" … (falls back to the raw kind). */
export function actionLabel(action: string): string {
  return LABELS.get(action) ?? action.replace(/_/g, " ");
}
