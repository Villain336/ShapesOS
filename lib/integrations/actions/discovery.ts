// Marketr — Phase 15 slice 1: tool-router discovery (spec §1).
//
// Phase 14 pins a static V1_ACTION_CATALOG. Phase 15 replaces pinning with
// discovery: Composio's tool router (GET /tools?toolkit_slug=) returns the
// full tool list per connected app; the result lands in ComposioToolCatalog
// (workspace+app scoped, version-stamped) via refreshCatalogForConnection().
//
// NO LIVE COMPOSIO KEY EXISTS. The live HTTP path is stubbed behind
// COMPOSIO_API_KEY and is clearly marked PENDING-KEY; the fixture backend
// carries realistic Composio-style tool lists for ~8 toolkits. Never ask
// for keys in chat — the key comes from the environment (BYO for
// self-hosted, bundled for hosted), same as lib/integrations/composio.ts.
//
// Composio tools remain Composio's IP — we store slugs + metadata, never
// copy their implementations (spec §10).

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { V1_ACTION_CATALOG } from "@/lib/integrations/actions/risk";
import { BadRequestError } from "@/lib/api/errors";

export interface ComposioToolkitTool {
  /** e.g. "SALESFORCE_CREATE_LEAD" */
  slug: string;
  label: string;
  /** One-line description of what the tool does. */
  description: string;
}

export interface ComposioToolkit {
  /** e.g. "google_sheets" — the Composio toolkit slug. */
  toolkitSlug: string;
  /** Marketr app key, e.g. "google-sheets". */
  appKey: string;
  label: string;
  description: string;
}

export interface ComposioToolRouter {
  listToolkits(): Promise<ComposioToolkit[]>;
  getToolkitTools(toolkitSlug: string): Promise<ComposioToolkitTool[]>;
}

// ---------------------------------------------------------------------------
// Live path — PENDING-KEY.
// When COMPOSIO_API_KEY is set, this is the router; every method throws
// PENDING-KEY until the GET /tools?toolkit_slug= mapping is wired (a later
// Phase 15 slice, once a real key exists to develop against).
// ---------------------------------------------------------------------------

class LiveComposioToolRouter implements ComposioToolRouter {
  private pending(): never {
    throw new Error(
      "PENDING-KEY: live Composio tool-router path not wired yet — " +
        "needs the GET /tools?toolkit_slug= response mapping before a real " +
        "COMPOSIO_API_KEY can drive discovery.",
    );
  }
  async listToolkits(): Promise<ComposioToolkit[]> {
    this.pending();
  }
  async getToolkitTools(_toolkitSlug: string): Promise<ComposioToolkitTool[]> {
    this.pending();
  }
}

// ---------------------------------------------------------------------------
// Fixture backend — realistic Composio-style tool lists for ~8 toolkits.
// The 5 v1 toolkits reuse the V1_ACTION_CATALOG slugs verbatim so a refresh
// of a v1 connection seeds exactly the pinned baseline (which stays the
// verified baseline — never modify or delete V1_ACTION_CATALOG).
// ---------------------------------------------------------------------------

type FixtureToolkitDef = ComposioToolkit & { tools: ComposioToolkitTool[] };

function v1Tools(appKey: string): ComposioToolkitTool[] {
  // Descriptions are fixture-local metadata only; the catalog pins
  // expected tiers, which live in risk.ts.
  const descriptions: Record<string, string> = {
    GMAIL_LIST_MESSAGES: "List the user's Gmail messages (paginated).",
    GMAIL_GET_MESSAGE: "Read a single Gmail message by id.",
    GMAIL_SEARCH_MESSAGES: "Search Gmail with a Gmail search query.",
    GMAIL_LIST_THREADS: "List Gmail conversation threads.",
    GMAIL_CREATE_DRAFT: "Create an email draft in Gmail (nothing sent).",
    GMAIL_SEND_EMAIL: "Send an email from the user's Gmail account.",
    GMAIL_REPLY_TO_THREAD: "Reply inside an existing Gmail thread.",
    GMAIL_DELETE_MESSAGE: "Permanently delete a Gmail message.",
    GMAIL_TRASH_MESSAGE: "Move a Gmail message to trash.",
    GOOGLE_SHEETS_GET_SPREADSHEET: "Read values and metadata from a spreadsheet.",
    GOOGLE_SHEETS_LIST_SPREADSHEETS: "List the user's spreadsheets.",
    GOOGLE_SHEETS_UPDATE_VALUES: "Update cell values in a spreadsheet range.",
    GOOGLE_SHEETS_APPEND_VALUES: "Append rows to a spreadsheet.",
    GOOGLE_SHEETS_CREATE_SPREADSHEET: "Create a new spreadsheet.",
    SLACK_LIST_CHANNELS: "List Slack channels in the workspace.",
    SLACK_GET_CONVERSATION_HISTORY: "Read recent messages from a Slack channel.",
    SLACK_SEARCH_MESSAGES: "Search Slack messages.",
    SLACK_SEND_MESSAGE: "Send a message to a Slack channel or user.",
    SLACK_POST_MESSAGE: "Post a message to a Slack channel.",
    SLACK_DELETE_MESSAGE: "Delete a Slack message.",
    HUBSPOT_LIST_CONTACTS: "List HubSpot contacts.",
    HUBSPOT_GET_CONTACT: "Read a HubSpot contact by id.",
    HUBSPOT_LIST_DEALS: "List HubSpot deals.",
    HUBSPOT_SEARCH_CRM: "Search HubSpot CRM records.",
    HUBSPOT_CREATE_CONTACT: "Create a HubSpot contact.",
    HUBSPOT_UPDATE_CONTACT: "Update a HubSpot contact.",
    HUBSPOT_CREATE_DEAL: "Create a HubSpot deal.",
    HUBSPOT_DELETE_CONTACT: "Delete a HubSpot contact.",
    HUBSPOT_ARCHIVE_CONTACT: "Archive a HubSpot contact.",
    NOTION_LIST_PAGES: "List Notion pages.",
    NOTION_GET_PAGE: "Read a Notion page by id.",
    NOTION_SEARCH: "Search the Notion workspace.",
    NOTION_CREATE_PAGE: "Create a Notion page (starts as a private draft).",
    NOTION_UPDATE_PAGE: "Update a Notion page.",
    NOTION_DELETE_PAGE: "Delete a Notion page.",
    NOTION_ARCHIVE_PAGE: "Archive a Notion page.",
  };
  return V1_ACTION_CATALOG.filter((t) => t.appKey === appKey).map((t) => ({
    slug: t.slug,
    label: t.label,
    description: descriptions[t.slug] ?? t.label,
  }));
}

const FIXTURE_TOOLKITS: FixtureToolkitDef[] = [
  {
    toolkitSlug: "gmail",
    appKey: "gmail",
    label: "Gmail",
    description: "Read, draft, and (with approval) send email.",
    tools: v1Tools("gmail"),
  },
  {
    toolkitSlug: "google_sheets",
    appKey: "google-sheets",
    label: "Google Sheets",
    description: "Read and (with approval) write spreadsheets.",
    tools: v1Tools("google-sheets"),
  },
  {
    toolkitSlug: "slack",
    appKey: "slack",
    label: "Slack",
    description: "Read channels and (with approval) post messages.",
    tools: v1Tools("slack"),
  },
  {
    toolkitSlug: "hubspot",
    appKey: "hubspot",
    label: "HubSpot",
    description: "Read CRM records and (with approval) create or update them.",
    tools: v1Tools("hubspot"),
  },
  {
    toolkitSlug: "notion",
    appKey: "notion",
    label: "Notion",
    description: "Read pages, draft new ones, update with approval.",
    tools: v1Tools("notion"),
  },
  {
    toolkitSlug: "salesforce",
    appKey: "salesforce",
    label: "Salesforce",
    description: "Read and (with approval) write Salesforce CRM records.",
    tools: [
      { slug: "SALESFORCE_CREATE_LEAD", label: "Create lead", description: "Create a new lead record in Salesforce." },
      { slug: "SALESFORCE_UPDATE_LEAD", label: "Update lead", description: "Update an existing Salesforce lead." },
      { slug: "SALESFORCE_GET_LEAD", label: "Read lead", description: "Fetch a Salesforce lead by id." },
      { slug: "SALESFORCE_LIST_LEADS", label: "List leads", description: "List Salesforce leads (paginated)." },
      { slug: "SALESFORCE_DELETE_LEAD", label: "Delete lead", description: "Delete a Salesforce lead." },
      { slug: "SALESFORCE_CREATE_OPPORTUNITY", label: "Create opportunity", description: "Create a new sales opportunity." },
      { slug: "SALESFORCE_UPDATE_OPPORTUNITY", label: "Update opportunity", description: "Update a sales opportunity." },
      { slug: "SALESFORCE_GET_OPPORTUNITY", label: "Read opportunity", description: "Fetch an opportunity by id." },
      { slug: "SALESFORCE_SEARCH_RECORDS", label: "Search records", description: "Search Salesforce records across objects." },
      { slug: "SALESFORCE_CREATE_TASK", label: "Create task", description: "Create a task linked to a Salesforce record." },
    ],
  },
  {
    toolkitSlug: "zendesk",
    appKey: "zendesk",
    label: "Zendesk",
    description: "Read and (with approval) manage support tickets.",
    tools: [
      { slug: "ZENDESK_CREATE_TICKET", label: "Create ticket", description: "Open a new support ticket in Zendesk." },
      { slug: "ZENDESK_UPDATE_TICKET", label: "Update ticket", description: "Update a Zendesk ticket's fields or status." },
      { slug: "ZENDESK_GET_TICKET", label: "Read ticket", description: "Fetch a Zendesk ticket by id." },
      { slug: "ZENDESK_LIST_TICKETS", label: "List tickets", description: "List Zendesk tickets (paginated)." },
      { slug: "ZENDESK_SEARCH_TICKETS", label: "Search tickets", description: "Search Zendesk tickets." },
      { slug: "ZENDESK_ADD_TICKET_COMMENT", label: "Add ticket comment", description: "Add a public or internal comment to a ticket." },
      { slug: "ZENDESK_DELETE_TICKET", label: "Delete ticket", description: "Delete a Zendesk ticket." },
      { slug: "ZENDESK_LIST_USERS", label: "List users", description: "List Zendesk end users." },
    ],
  },
  {
    toolkitSlug: "stripe",
    appKey: "stripe",
    label: "Stripe",
    description: "Read and (with approval) manage payments, invoices, customers.",
    tools: [
      { slug: "STRIPE_CREATE_CUSTOMER", label: "Create customer", description: "Create a Stripe customer." },
      { slug: "STRIPE_GET_CUSTOMER", label: "Read customer", description: "Fetch a Stripe customer by id." },
      { slug: "STRIPE_LIST_CUSTOMERS", label: "List customers", description: "List Stripe customers (paginated)." },
      { slug: "STRIPE_CREATE_INVOICE", label: "Create invoice", description: "Draft a Stripe invoice." },
      { slug: "STRIPE_SEND_INVOICE", label: "Send invoice", description: "Finalize and send a Stripe invoice." },
      { slug: "STRIPE_CREATE_PAYMENT_INTENT", label: "Create payment intent", description: "Start a new Stripe payment." },
      { slug: "STRIPE_LIST_PAYMENT_INTENTS", label: "List payments", description: "List Stripe payment intents." },
      { slug: "STRIPE_REFUND_PAYMENT", label: "Refund payment", description: "Refund a Stripe payment." },
      { slug: "STRIPE_CREATE_SUBSCRIPTION", label: "Create subscription", description: "Create a Stripe subscription." },
      { slug: "STRIPE_CANCEL_SUBSCRIPTION", label: "Cancel subscription", description: "Cancel a Stripe subscription." },
    ],
  },
];

// ---------------------------------------------------------------------------
// Drift scenario — Phase 15 slice 5 (spec §1: drift detection).
//
// The drift battery (scripts/verify-phase15-drift.mts) flips the fixture
// router into "drift mode": the `stripe` toolkit then returns a changed
// tool list — gains 2 tools, loses 1 tool, renames 1 tool (same label +
// description, different slug). All other toolkits are byte-identical, so
// the diff isolates exactly the drift sets.
//
// Added-tool slugs are DELIBERATELY unclassifiable: no destructive/write/
// read verb stem appears in slug or description, so deriveTier() hits the
// universal conservative floor → classified=false → HIGH-GATED. The gate
// needs no special-casing: an added tool proposed without a cache row
// falls through resolveToolkitForTool() → null → the slice-2 floor.
//
// Drift mode is process-local fixture state only — never on in prod code
// paths (nothing in app/ calls setFixtureDriftMode).
// ---------------------------------------------------------------------------

let fixtureDriftMode = false;

/** Drive the fixture router in "drift mode" (batteries/simulation only). */
export function setFixtureDriftMode(enabled: boolean): void {
  fixtureDriftMode = enabled;
}

/** Whether the fixture router is currently serving the drift scenario. */
export function isFixtureDriftMode(): boolean {
  return fixtureDriftMode;
}

/**
 * The drift scenario: the stripe toolkit with exactly four changes —
 * added: STRIPE_ORCHESTRATE_LEDGER, STRIPE_RECONCILE_DISPUTES
 * removed: STRIPE_LIST_PAYMENT_INTENTS
 * renamed: STRIPE_CREATE_CUSTOMER → STRIPE_NEW_CUSTOMER (label + description
 *          carried over verbatim, so the rename heuristic can pair them).
 */
export function getDriftScenario(): FixtureToolkitDef[] {
  return FIXTURE_TOOLKITS.map((t) => {
    if (t.toolkitSlug !== "stripe") return t;
    const tools = t.tools
      .filter(
        (tool) =>
          tool.slug !== "STRIPE_CREATE_CUSTOMER" &&
          tool.slug !== "STRIPE_LIST_PAYMENT_INTENTS",
      )
      .concat([
        {
          slug: "STRIPE_ORCHESTRATE_LEDGER",
          label: "Orchestrate ledger",
          description: "Reconcile the ledger across connected accounts.",
        },
        {
          slug: "STRIPE_RECONCILE_DISPUTES",
          label: "Reconcile disputes",
          description: "Reconcile dispute evidence bundles.",
        },
        {
          slug: "STRIPE_NEW_CUSTOMER",
          label: "Create customer",
          description: "Create a Stripe customer.",
        },
      ]);
    return { ...t, tools };
  });
}

export const fixtureToolRouter: ComposioToolRouter = {
  async listToolkits(): Promise<ComposioToolkit[]> {
    const defs = fixtureDriftMode ? getDriftScenario() : FIXTURE_TOOLKITS;
    return defs.map(({ tools: _tools, ...rest }) => rest);
  },
  async getToolkitTools(toolkitSlug: string): Promise<ComposioToolkitTool[]> {
    const defs = fixtureDriftMode ? getDriftScenario() : FIXTURE_TOOLKITS;
    const found = defs.find((t) => t.toolkitSlug === toolkitSlug);
    if (!found) throw new BadRequestError(`Unknown toolkit "${toolkitSlug}"`);
    return found.tools;
  },
};

/**
 * The active router. Fixture-backed until a real key exists: the live path
 * is stubbed (PENDING-KEY) so nothing silently hits the network.
 */
export function getToolRouter(): ComposioToolRouter {
  if (process.env.COMPOSIO_API_KEY?.trim()) return new LiveComposioToolRouter();
  return fixtureToolRouter;
}

// ---------------------------------------------------------------------------
// Catalog refresh — upserts the discovered tools into ComposioToolCatalog.
//
// Version stamping: a monotonic counter per (workspaceId, appKey); each
// refresh bumps it and stamps every row with the new version + discoveredAt.
// Re-refresh is idempotent: the (workspaceId, toolkitSlug, toolSlug) unique
// key means a repeat refresh never creates dupes — it only re-stamps.
//
// Tools removed upstream keep their last-known version (they are NOT
// deleted here); drift detection flags them in a later slice (spec §1).
// ---------------------------------------------------------------------------

export interface RefreshCatalogResult {
  toolCount: number;
  version: number;
}

export async function refreshCatalogForConnection(
  workspaceId: string,
  appKey: string,
): Promise<RefreshCatalogResult> {
  const router = getToolRouter();
  const toolkits = await router.listToolkits();
  const toolkit =
    toolkits.find((t) => t.appKey === appKey) ??
    toolkits.find((t) => t.toolkitSlug === appKey);
  if (!toolkit) {
    throw new BadRequestError(`No toolkit found for app "${appKey}"`);
  }
  const tools = await router.getToolkitTools(toolkit.toolkitSlug);

  const existing = await withWorkspaceScope(workspaceId, (tx) =>
    tx.composioToolCatalog.aggregate({
      where: { workspaceId, appKey },
      _max: { version: true },
    }),
  );
  const version = (existing._max.version ?? 0) + 1;
  const discoveredAt = new Date();

  await withWorkspaceScope(workspaceId, (tx) => {
    const upserts = tools.map((tool) =>
      tx.composioToolCatalog.upsert({
        where: {
          workspaceId_toolkitSlug_toolSlug: {
            workspaceId,
            toolkitSlug: toolkit.toolkitSlug,
            toolSlug: tool.slug,
          },
        },
        update: {
          appKey,
          toolLabel: tool.label,
          description: tool.description,
          version,
          discoveredAt,
        },
        create: {
          workspaceId,
          appKey,
          toolkitSlug: toolkit.toolkitSlug,
          toolSlug: tool.slug,
          toolLabel: tool.label,
          description: tool.description,
          version,
          discoveredAt,
        },
      }),
    );
    return Promise.all(upserts);
  });

  return { toolCount: tools.length, version };
}
