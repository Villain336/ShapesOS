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
  { action: "edit_sandbox_files", label: "Edit files in the code sandbox", description: "Write or change files inside the run's isolated sandbox (checkpointed; nothing leaves it)." },
  { action: "run_sandbox_command", label: "Run a command in the code sandbox", description: "Run a shell command or the tests inside the run's isolated sandbox (always asks)." },
  // Phase 9 (apps): internal mini-apps (lib/apps/tools.ts).
  { action: "draft_app_spec", label: "Draft a mini-app", description: "Write or change a mini-app's draft spec (an admin publishes it)." },
  { action: "write_app_record", label: "Write a mini-app record", description: "Add or change a record in a published mini-app. Always asks." },
  { action: "delete_app_record", label: "Delete a mini-app record", description: "Delete a record from a published mini-app. Never automated." },
  // Phase 10 (finance): ops finance tools (lib/chat/ops-finance-tools.ts).
  { action: "draft_quote", label: "Draft a quote", description: "Create a draft quote (sending always asks)." },
  { action: "draft_vendor_bill", label: "Draft a vendor bill", description: "Create a draft vendor bill (posting and paying are a person's job)." },
  { action: "convert_quote", label: "Convert a quote", description: "Turn a quote into a draft invoice or order. Always asks." },
  { action: "submit_expense_claim", label: "Submit an expense claim", description: "Create and submit an expense claim for approval. Always asks." },
  { action: "record_payment", label: "Record a payment", description: "Propose recording a customer payment on an invoice. Never automated." },
  { action: "post_journal_entry", label: "Post a journal entry", description: "Propose a manual entry in the books. Never automated." },
  // Phase 10 (ops-core): CRM, projects, helpdesk, inventory agent tools.
  { action: "write_crm_record", label: "Write CRM records", description: "Create contacts, companies and deals, move deal stages, convert leads. Always asks." },
  { action: "write_project_record", label: "Write project records", description: "Create tasks and log time on projects. Always asks." },
  { action: "write_ticket", label: "Open or close tickets", description: "Open helpdesk tickets or mark them solved/closed. Always asks." },
  { action: "send_ticket_reply", label: "Reply to a ticket", description: "Email a customer from a helpdesk ticket. Always asks." },
  { action: "move_stock", label: "Draft a stock move", description: "Create a draft move between stock locations (a person books it). Always asks." },
  { action: "set_reorder_rule", label: "Set a reorder rule", description: "Create or change a min/max reorder rule. Always asks." },
  // Phase 10 (store): storefront listings (lib/chat/ops-store-tools.ts).
  { action: "write_store_listing", label: "Change the online store", description: "Show, hide or edit a product in the public online store. Always asks." },
  // Phase 11 (seotools): SEO + document tools.
  { action: "draft_structured_data", label: "Draft structured data", description: "Add schema.org JSON-LD to a site as a draft revision (a person applies it)." },
  { action: "draft_document", label: "Create a Word document", description: "Write a .docx and save it to the workspace files." },
  { action: "draft_spreadsheet", label: "Create a spreadsheet", description: "Write an .xlsx and save it to the workspace files." },
  { action: "fetch_web_pages", label: "Read web pages", description: "Scrape or crawl web pages as markdown via Context.dev (metered, daily budget)." },
  // Phase 11 (bizsync): commerce + accounting connectors.
  { action: "import_commerce_data", label: "Import store data", description: "Pull products, stock, orders and customers from a connected store into Ops. Always asks." },
  { action: "update_store_inventory", label: "Update store stock", description: "Set stock levels on a connected online store. Always asks." },
  { action: "post_to_accounting", label: "Post to accounting software", description: "Export invoices, bills, payments and journals to QuickBooks or Xero. Never automated." },
  // Phase 12 (mfgpos): manufacturing + point of sale (lib/chat/ops-mfgpos-tools.ts).
  { action: "draft_manufacturing_order", label: "Draft a manufacturing order", description: "Create a draft manufacturing order (confirming and completing always ask)." },
  { action: "confirm_manufacturing_order", label: "Confirm a manufacturing order", description: "Propose confirming a manufacturing order: components and work orders. Always asks." },
  { action: "log_work_order_time", label: "Log time on a work order", description: "Add minutes worked to a manufacturing work order. Always asks." },
  { action: "complete_manufacturing_order", label: "Complete a manufacturing order", description: "Propose completing a manufacturing order: stock moves and costing in the books. Never automated." },
  { action: "close_pos_session", label: "Close a till session", description: "Propose posting a till session's takings to the books. Never automated." },
  // Phase 12 (people): payroll + events (lib/chat/ops-people-tools.ts).
  { action: "draft_pay_run", label: "Draft a pay run", description: "Create and compute a pay run (approving and posting it are a person's job)." },
  { action: "approve_pay_run", label: "Approve a pay run", description: "Propose approving payroll. Never automated." },
  { action: "post_pay_run", label: "Post a pay run", description: "Propose posting payroll to the books. Never automated." },
  { action: "write_event", label: "Change events", description: "Create draft events and register people for events. Always asks." },
  // Phase 13 (twincore): the digital twin (lib/chat/ops-twin-tools.ts).
  { action: "book_dock", label: "Book a dock", description: "Book a truck onto a free dock door of a twin site (an internal site operation)." },
  { action: "assign_equipment", label: "Assign equipment", description: "Give a forklift or cart a task, or set it available / charging." },
  { action: "draft_site_layout", label: "Draft a site layout", description: "Draft a digital twin site layout from a description or floor-plan image (a person publishes it)." },
];


const LABELS = new Map(KNOWN_ACTION_DEFS.map((d) => [d.action, d.label]));

/** "Draft content", "Post to owned social" … (falls back to the raw kind). */
export function actionLabel(action: string): string {
  return LABELS.get(action) ?? action.replace(/_/g, " ");
}
