// Marketr — Phase 15 slice 1: tool-router discovery (spec §1).
//
// Phase 14 pins a static V1_ACTION_CATALOG. Phase 15 replaces pinning with
// discovery: Composio's tool router (GET /tools?toolkit_slug=) returns the
// full tool list per connected app; the result lands in ComposioToolCatalog
// (workspace+app scoped, version-stamped) via refreshCatalogForConnection().
//
// Phase 6: with COMPOSIO_API_KEY set, LiveComposioToolRouter discovers the
// real directory (GET /toolkits) and each toolkit's tools (GET /tools?
// toolkit_slug=) through lib/integrations/composio.ts — the only module that
// talks to Composio. Without a key the fixture backend (realistic tool lists
// for 8 toolkits) stays the router, so nothing silently hits the network.
// Discovered tools carry only slug/label/description: risk tiers are still
// derived at gate time by classifyAction()/deriveTier() exactly as for
// fixtures — discovery never assigns or relaxes a tier. Never ask for keys
// in chat — the key comes from the environment (BYO for self-hosted,
// bundled for hosted). UNVERIFIED-LIVE: built against the documented
// response shapes with stubbed HTTP; no real key has exercised it yet.
//
// Composio tools remain Composio's IP — we store slugs + metadata, never
// copy their implementations (spec §10).

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { V1_ACTION_CATALOG, V1_COMPOSIO_APPS } from "@/lib/integrations/actions/risk";
import { BadRequestError } from "@/lib/api/errors";
import { createHash } from "node:crypto";
import { FakeProviderRefusedError, fakeProvidersAllowed } from "@/lib/env/secrets";
import {
  createComposioHttp,
  getComposioBaseUrl,
  listComposioToolkitsPage,
  listComposioToolsPage,
  type ComposioHttp,
  type ComposioToolkitSummary,
} from "@/lib/integrations/composio";

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
  /**
   * Live directory only: Composio's advertised tool count, so the
   * directory can show a count without fetching every toolkit's tools.
   */
  toolCount?: number;
  /** Live directory only: Composio category names (lower-case). */
  categories?: string[];
}

export interface ComposioToolRouter {
  listToolkits(): Promise<ComposioToolkit[]>;
  getToolkitTools(toolkitSlug: string): Promise<ComposioToolkitTool[]>;
}

// ---------------------------------------------------------------------------
// Live path (Phase 6) — COMPOSIO_API_KEY set.
//
// Slug mapping: Composio's live slugs drop separators ("googlesheets") where
// the v1 catalog uses "google_sheets". A live toolkit whose compacted slug
// matches a v1 app keeps the v1 toolkitSlug + appKey, so enablement
// defaults, the pinned catalog and existing connections line up; the
// Composio slug is kept internally for the /tools call. Every other toolkit
// uses Composio's slug and an appKey with "_" → "-".
//
// Bounds: toolkits are paged at 1000 (max 10 pages) and cached for 10
// minutes per router (the directory page lists them on every load); tools
// are paged at 1000 (max 10 pages) per toolkit and not cached — a catalog
// refresh / drift check must see the current list. Deprecated tools are
// skipped; slugs are upper-cased and de-duplicated; descriptions capped.
// ---------------------------------------------------------------------------

const LIVE_PAGE_LIMIT = 1000;
const LIVE_MAX_PAGES = 10;
const LIVE_TOOLKIT_TTL_MS = 10 * 60_000;
const MAX_DESCRIPTION = 500;

const compact = (slug: string) => slug.toLowerCase().replace(/[^a-z0-9]/g, "");

function categoryNames(meta: ComposioToolkitSummary["meta"]): string[] {
  return (meta?.categories ?? [])
    .map((c) => (typeof c === "string" ? c : c?.name ?? c?.slug ?? c?.id ?? ""))
    .map((c) => String(c).trim().toLowerCase())
    .filter(Boolean);
}

export class LiveComposioToolRouter implements ComposioToolRouter {
  private toolkitCache: { at: number; toolkits: ComposioToolkit[] } | null = null;
  /** internal toolkitSlug → Composio slug (differs only for v1 apps). */
  private readonly composioSlug = new Map<string, string>();

  constructor(
    private readonly http: ComposioHttp = createComposioHttp(),
    private readonly now: () => number = Date.now,
  ) {}

  async listToolkits(): Promise<ComposioToolkit[]> {
    if (this.toolkitCache && this.now() - this.toolkitCache.at < LIVE_TOOLKIT_TTL_MS) {
      return this.toolkitCache.toolkits;
    }
    const v1ByCompact = new Map(V1_COMPOSIO_APPS.map((a) => [compact(a.toolkitSlug), a]));
    const seen = new Set<string>();
    const out: ComposioToolkit[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < LIVE_MAX_PAGES; page++) {
      const res = await listComposioToolkitsPage({ cursor, limit: LIVE_PAGE_LIMIT }, this.http);
      for (const item of res.items) {
        if (!item || typeof item.slug !== "string" || !item.slug.trim()) continue;
        const live = item.slug.trim().toLowerCase();
        const v1 = v1ByCompact.get(compact(live));
        const toolkitSlug = v1?.toolkitSlug ?? live;
        if (seen.has(toolkitSlug)) continue;
        seen.add(toolkitSlug);
        this.composioSlug.set(toolkitSlug, live);
        const count = Number(item.meta?.tools_count);
        out.push({
          toolkitSlug,
          appKey: v1?.appKey ?? live.replace(/_/g, "-"),
          label: (item.name ?? "").trim() || v1?.label || live,
          description: String(item.meta?.description ?? v1?.description ?? "").slice(0, MAX_DESCRIPTION),
          toolCount: Number.isFinite(count) && count >= 0 ? Math.floor(count) : undefined,
          categories: categoryNames(item.meta),
        });
      }
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    this.toolkitCache = { at: this.now(), toolkits: out };
    return out;
  }

  async getToolkitTools(toolkitSlug: string): Promise<ComposioToolkitTool[]> {
    if (!this.composioSlug.has(toolkitSlug)) await this.listToolkits();
    const live = this.composioSlug.get(toolkitSlug);
    if (!live) throw new BadRequestError(`Unknown toolkit "${toolkitSlug}"`);
    const seen = new Set<string>();
    const out: ComposioToolkitTool[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < LIVE_MAX_PAGES; page++) {
      const res = await listComposioToolsPage({ toolkitSlug: live, cursor, limit: LIVE_PAGE_LIMIT }, this.http);
      for (const t of res.items) {
        if (!t || typeof t.slug !== "string" || !t.slug.trim() || t.is_deprecated === true) continue;
        const slug = t.slug.trim().toUpperCase();
        if (seen.has(slug)) continue;
        seen.add(slug);
        out.push({
          slug,
          label: (t.name ?? "").trim() || slug,
          description: String(t.description ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION),
        });
      }
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return out;
  }
}

/** One live router per (base URL, key) so its toolkit cache survives across requests. */
let liveRouter: { id: string; router: LiveComposioToolRouter } | null = null;

function liveRouterFor(apiKey: string): LiveComposioToolRouter {
  const id = createHash("sha256").update(`${getComposioBaseUrl()}\n${apiKey}`).digest("hex");
  if (!liveRouter || liveRouter.id !== id) {
    liveRouter = { id, router: new LiveComposioToolRouter(createComposioHttp()) };
  }
  return liveRouter.router;
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
 * The active router: live Composio discovery when COMPOSIO_API_KEY is set,
 * the fixture backend otherwise (no key → no network).
 */
export function getToolRouter(): ComposioToolRouter {
  const key = process.env.COMPOSIO_API_KEY?.trim();
  if (key) return liveRouterFor(key);
  // Phase 11 (conncore): the fixture catalogue is never shown in production —
  // no key lists no toolkits and a tool lookup says "Composio is not connected".
  if (!fakeProvidersAllowed()) return notConnectedToolRouter;
  return fixtureToolRouter;
}

/** Phase 11 (conncore): production router when COMPOSIO_API_KEY is unset. */
export const notConnectedToolRouter: ComposioToolRouter = {
  async listToolkits(): Promise<ComposioToolkit[]> {
    return [];
  },
  async getToolkitTools(): Promise<ComposioToolkitTool[]> {
    throw new FakeProviderRefusedError("Composio");
  },
};

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
