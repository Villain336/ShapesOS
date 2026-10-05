// Marketr — M21 built-in connector registry (spec §7, §11).
//
// DESIGN DECISION (recorded in prisma/schema.prisma): the 28 built-in
// connectors are CODE-defined here, not DB rows. (The count is pinned by
// lib/connectors/m21/__tests__/registry.test.ts — update both together.) `Connector` rows exist
// ONLY for workspace-custom MCP servers (kind=mcp). Do not create DB rows
// for built-in keys — resolveAdapter() maps a built-in key directly to
// its native adapter class.

export type ConnectorAuthType = "oauth2" | "api_key" | "none";

import type { CredentialMode } from "./credential-fields";

export interface BuiltinConnectorMeta {
  key: string;
  displayName: string;
  authType: ConnectorAuthType;
  description: string;
  oauth?: {
    scopes: string[];
    /** Env var names for client id / secret (hosted app or BYO). */
    envVars: string[];
  };
  /** Human-readable note about auth expectations. */
  authNote: string;
  /**
   * Phase 14 (connectors): the typed-in credential fields this connector
   * accepts (lib/connectors/m21/credential-fields.ts). api_key connectors
   * that declare nothing take one API key; an oauth2 connector declares
   * modes only for a supported alternative to OAuth (Shopify single store).
   */
  credentialModes?: CredentialMode[];
  /**
   * Phase 15.4 (zernio): a PLATFORM key — ShapesOS's own key in env, LIVE /
   * pre-added for every workspace; the customer brings no credential (the
   * vault holds nothing; authType is "none"). The card shows the env var's
   * state instead of a credential form.
   */
  platformKey?: { envVar: string; label: string };
}

// Phase 11 (conncore): Microsoft Graph delegated scopes (offline_access for
// a refresh token, User.Read for the liveness check). Shared with lib/vault/oauth.ts.
export const MICROSOFT_MAIL_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.Send",
];
// Phase 11 (conncore): Slack bot scopes (mentions → agent tasks, read
// channels/threads, post). Shared with lib/vault/oauth.ts.
export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
];
// Phase 11 (conncore): HubSpot CRM scopes (read + write for the sync).
export const HUBSPOT_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.deals.read",
  "crm.objects.deals.write",
];
// Phase 11 (bizsync): Shopify (comma-separated on the authorize URL),
// QuickBooks Online and Xero. Shared with lib/vault/oauth.ts.
export const SHOPIFY_SCOPES = ["read_products", "read_inventory", "write_inventory", "read_locations", "read_orders", "read_customers"];
export const QUICKBOOKS_SCOPES = ["com.intuit.quickbooks.accounting"];
// Xero granular scopes (apps created after 2026-03-02 can no longer request
// the broad accounting.transactions): invoices (incl. bills + credit notes),
// payments, manual journals, contacts, read-only settings (chart of accounts).
export const XERO_SCOPES = [
  "offline_access",
  "accounting.invoices",
  "accounting.payments",
  "accounting.manualjournals",
  "accounting.contacts",
  "accounting.settings.read",
];
export const MICROSOFT_CALENDAR_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/Calendars.ReadWrite",
];
// Phase 11 (devtools): work-tool connector scopes. Shared with lib/vault/oauth.ts.
// Linear: read + write (issue create/update and comments need write).
export const LINEAR_SCOPES = ["read", "write"];
// Jira Cloud (Atlassian 3LO classic scopes; offline_access → refresh token).
export const JIRA_SCOPES = ["read:jira-work", "write:jira-work", "read:jira-user", "offline_access"];
// Airtable: record read/write + base schema (to list bases, tables, fields).
export const AIRTABLE_SCOPES = ["data.records:read", "data.records:write", "schema.bases:read"];
// Phase 14 (connectors): Gusto assigns an app's API scopes during its review
// (docs.gusto.com/app-integrations/docs/scopes) — nothing is requested on the
// authorize URL. This integration needs employees:read, payrolls:read and
// payrolls:write (ask Gusto for exactly those). Shared with lib/vault/oauth.ts.
export const GUSTO_SCOPES: string[] = [];

export const BUILT_IN_CONNECTORS: BuiltinConnectorMeta[] = [
  {
    key: "google-search-console",
    displayName: "Google Search Console",
    authType: "oauth2",
    description: "Search performance: queries, pages, clicks, impressions, CTR, position.",
    oauth: {
      scopes: ["https://www.googleapis.com/auth/webmasters"], // Phase 11: sitemap submit (lib/vault/oauth.ts)
      envVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Google OAuth2 (shared Google app credentials).",
  },
  {
    key: "ga4",
    displayName: "Google Analytics 4",
    authType: "oauth2",
    description: "Traffic and engagement: sessions, users, conversions, top pages.",
    oauth: {
      scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
      envVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Google OAuth2 (shared Google app credentials).",
  },
  {
    key: "wordpress",
    displayName: "WordPress",
    authType: "api_key",
    description: "Publish and edit pages/posts on a WordPress site via the REST API.",
    authNote: "WordPress Application Password (Users → Profile → Application Passwords).",
    // Phase 14: the adapter reads baseUrl + username + apiKey (the application password).
    credentialModes: [
      {
        id: "application_password",
        label: "Application password",
        help: "In WordPress: Users → Profile → Application Passwords → Add new.",
        fields: [
          { name: "baseUrl", label: "Site URL", kind: "url", required: true, placeholder: "https://example.com" },
          { name: "username", label: "Username", kind: "text", required: true, placeholder: "admin" },
          { name: "apiKey", label: "Application password", kind: "secret", required: true, placeholder: "abcd efgh ijkl mnop qrst uvwx" },
        ],
      },
    ],
  },
  {
    key: "webflow",
    displayName: "Webflow",
    authType: "oauth2",
    description: "Manage Webflow CMS collections and publish sites.",
    oauth: {
      scopes: ["cms:read", "cms:write", "sites:read", "sites:write"],
      envVars: ["WEBFLOW_OAUTH_CLIENT_ID", "WEBFLOW_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Webflow OAuth (site-scoped) or BYO API token.",
  },
  {
    key: "google-drive",
    displayName: "Google Drive",
    authType: "oauth2",
    description: "Browse and attach Drive files (briefs, brand assets) to chat sessions.",
    oauth: {
      // Phase 4b: read-only is the minimal grant — the adapter never writes.
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      envVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Google OAuth2 (shared Google app credentials).",
  },
  {
    key: "notion",
    displayName: "Notion",
    authType: "oauth2",
    description: "Read Notion pages and databases for briefs and brand context.",
    oauth: {
      scopes: [],
      envVars: ["NOTION_OAUTH_CLIENT_ID", "NOTION_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Notion public OAuth integration (no scopes — capabilities granted per page).",
  },
  {
    key: "buffer",
    displayName: "Buffer",
    authType: "oauth2",
    description: "Schedule and publish social posts across connected profiles.",
    oauth: {
      scopes: [],
      envVars: ["BUFFER_OAUTH_CLIENT_ID", "BUFFER_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Buffer OAuth (multi-user SaaS install); BYO access token also supported.",
  },
  {
    key: "resend",
    displayName: "Resend",
    authType: "api_key",
    description: "Send test emails and newsletters through the Resend API.",
    authNote: "Resend API key (re_…).",
    credentialModes: [{ id: "api_key", label: "API key", fields: [{ name: "apiKey", label: "API key", kind: "secret", required: true, placeholder: "re_…" }] }],
  },
  {
    key: "dataforseo",
    displayName: "DataForSEO",
    authType: "api_key",
    description: "Keyword ideas, SERP snapshots, competitor keywords, backlinks.",
    authNote: "DataForSEO login + password (basic auth pair stored as one credential).",
    // Phase 14: the adapter reads apiKey (the API login) + password.
    credentialModes: [
      {
        id: "login_password",
        label: "API login",
        help: "DataForSEO dashboard → API access: the API login and API password (not your account password).",
        fields: [
          { name: "apiKey", label: "API login", kind: "text", required: true, placeholder: "you@example.com" },
          { name: "password", label: "API password", kind: "secret", required: true },
        ],
      },
    ],
  },
  {
    key: "meta-ads",
    displayName: "Meta Ads",
    authType: "oauth2",
    description: "Read ad account performance and campaign insights from Meta.",
    oauth: {
      // Phase 4b: every tool is a read — ads_read is the minimal grant.
      scopes: ["ads_read"],
      envVars: ["META_OAUTH_CLIENT_ID", "META_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Facebook OAuth (Meta app).",
  },
  {
    key: "google-ads",
    displayName: "Google Ads",
    authType: "oauth2",
    description: "Read Google Ads campaigns, keywords, and spend reporting.",
    oauth: {
      scopes: ["https://www.googleapis.com/auth/adwords"],
      envVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Google OAuth2 + a developer token (GOOGLE_ADS_DEVELOPER_TOKEN or BYO).",
  },
  // Connector Agent slice 2: Gmail contact import (network bootstrapping).
  // Metadata only (From/To/Cc/Date) — message bodies are never fetched.
  {
    key: "gmail",
    displayName: "Gmail",
    authType: "oauth2",
    description:
      "Import your email network (message metadata only — bodies are never read), and send or reply in-thread after you confirm.",
    oauth: {
      // Phase 11 (conncore): gmail.send for the gated send / reply tools.
      scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
      envVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Google OAuth2 (shared Google app credentials).",
  },
  // Connector Agent slice 2: Google Calendar contact import (attendees).
  {
    key: "google-calendar",
    displayName: "Google Calendar",
    authType: "oauth2",
    description:
      "Import your meeting network (attendees and organizers become contact-graph nodes), list events, and create or update events after you confirm.",
    oauth: {
      // Phase 11 (conncore): + calendar.events for list/create/update events.
      scopes: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events"],
      envVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Google OAuth2 (shared Google app credentials).",
  },
  // Phase 4b: Google Business Profile (locations, reviews + replies, local
  // posts). business.manage is the only GBP scope. Mutating tools are
  // confirmation-gated; authority flows add their own approval receipts.
  {
    key: "google-business-profile",
    displayName: "Google Business Profile",
    authType: "oauth2",
    description: "Locations, reviews and owner replies, and local posts on Google Business Profile.",
    oauth: {
      scopes: ["https://www.googleapis.com/auth/business.manage"],
      envVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Google OAuth2 (shared Google app credentials). Needs Google's Business Profile API approval.",
  },
  // Phase 11 (conncore): Outlook mail via Microsoft Graph (read + gated send).
  {
    key: "outlook",
    displayName: "Outlook",
    authType: "oauth2",
    description: "Read Outlook mail, and send or reply in-thread after you confirm (Microsoft Graph).",
    oauth: {
      scopes: MICROSOFT_MAIL_SCOPES,
      envVars: ["MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Microsoft identity platform OAuth2 (work, school or personal Microsoft account).",
  },
  // Phase 11 (conncore): Outlook calendar via Microsoft Graph (gated writes).
  {
    key: "outlook-calendar",
    displayName: "Outlook Calendar",
    authType: "oauth2",
    description: "List Outlook calendar events, and create or update events after you confirm (Microsoft Graph).",
    oauth: {
      scopes: MICROSOFT_CALENDAR_SCOPES,
      envVars: ["MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Microsoft identity platform OAuth2 (work, school or personal Microsoft account).",
  },
  // Phase 11 (conncore): the full Slack app (bot install, Events API).
  {
    key: "slack",
    displayName: "Slack",
    authType: "oauth2",
    description: "Read channels and threads, post after you confirm, and start agent tasks by mentioning @ShapesOS in Slack.",
    oauth: {
      scopes: SLACK_BOT_SCOPES,
      envVars: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
    },
    authNote: "Slack OAuth v2 app install (bot token). Mentions need the app's Events API URL and SLACK_SIGNING_SECRET.",
  },
  // Phase 11 (conncore): HubSpot ↔ Ops CRM bidirectional sync.
  {
    key: "hubspot",
    displayName: "HubSpot",
    authType: "oauth2",
    description: "Sync HubSpot contacts, companies and deals into the CRM, and push CRM changes back after you confirm.",
    oauth: {
      scopes: HUBSPOT_SCOPES,
      envVars: ["HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET"],
    },
    authNote: "HubSpot public app OAuth (CRM objects read/write).",
  },
  // Phase 11 (devtools): Linear issues, projects and comments (gated writes).
  {
    key: "linear",
    displayName: "Linear",
    authType: "oauth2",
    description: "List and search Linear teams, projects and issues; create or update issues and comment after you confirm.",
    oauth: {
      scopes: LINEAR_SCOPES,
      envVars: ["LINEAR_OAUTH_CLIENT_ID", "LINEAR_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Linear OAuth2 application (Settings → API → OAuth applications).",
  },
  // Phase 11 (devtools): Jira Cloud projects, JQL search, gated issue writes.
  {
    key: "jira",
    displayName: "Jira",
    authType: "oauth2",
    description: "List Jira projects and search issues with JQL; create, transition or comment on issues after you confirm.",
    oauth: {
      scopes: JIRA_SCOPES,
      envVars: ["ATLASSIAN_OAUTH_CLIENT_ID", "ATLASSIAN_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Atlassian OAuth 2.0 (3LO) app with the Jira API (developer.atlassian.com → Developer console).",
  },
  // Phase 11 (devtools): Airtable bases, tables and records (gated writes).
  {
    key: "airtable",
    displayName: "Airtable",
    authType: "oauth2",
    description: "List Airtable bases, tables and records; create or update records after you confirm.",
    oauth: {
      scopes: AIRTABLE_SCOPES,
      envVars: ["AIRTABLE_OAUTH_CLIENT_ID", "AIRTABLE_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Airtable OAuth integration (airtable.com/create/oauth; PKCE). You choose which bases to grant on the consent screen.",
  },
  // Phase 11 (devtools): Supabase projects, storage buckets and read-only SQL (no writes in v1).
  {
    key: "supabase",
    displayName: "Supabase",
    authType: "api_key",
    description: "List Supabase projects and storage buckets, and run read-only SQL queries (anything that writes is refused).",
    authNote: "Supabase personal access token (sbp_…, Dashboard → Account → Access tokens). Read-only: no writes in v1.",
    credentialModes: [{ id: "api_key", label: "Access token", fields: [{ name: "apiKey", label: "Personal access token", kind: "secret", required: true, placeholder: "sbp_…" }] }],
  },
  // Phase 11 (devtools): Netlify sites and deploys through the Phase 9 deploy
  // adapter (lib/deploy/netlify.ts) and its hosting-connection credentials.
  {
    key: "netlify",
    displayName: "Netlify",
    authType: "api_key",
    description: "List Netlify sites and deploys, and start a new deploy from the linked repository after you confirm.",
    authNote: "Reuse a project's Netlify hosting connection (Sites → Hosting → Use for agents), or a Netlify personal access token.",
    credentialModes: [{ id: "api_key", label: "Access token", fields: [{ name: "apiKey", label: "Personal access token", kind: "secret", required: true, placeholder: "nfp_…" }] }],
  },
  // Phase 11 (bizsync): Shopify ↔ Ops products, stock, orders, customers.
  {
    key: "shopify",
    displayName: "Shopify",
    authType: "oauth2",
    description: "Sync Shopify products, stock by location, orders and customers into Ops, and push stock back after you confirm.",
    oauth: {
      scopes: SHOPIFY_SCOPES,
      envVars: ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"],
    },
    authNote:
      "Your own store, no app listing: a Dev Dashboard app in your Shopify organization (client ID + secret; ShapesOS requests 24-hour tokens with the client credentials grant), or an older admin-created custom app's Admin API token. A hosted ShapesOS Shopify app (OAuth per store) also works when SHOPIFY_CLIENT_ID/SECRET are set.",
    // Phase 14 (connectors): the single-store connection (no App Store
    // listing). Verified 2026-10-05 against
    //   shopify.dev/docs/apps/build/authentication-authorization (grants table:
    //     "Is a server-side integration that acts on your own stores → Client
    //     credentials grant"; admin-created custom apps "can no longer" be
    //     created, existing ones keep working)
    //   shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant
    //   shopify.dev/docs/apps/build/authentication-authorization/legacy/admin-custom-apps
    // Stored as { shop, access_token, webhook_secret?, auth_mode, … } so
    // shopifyAuthFrom (native/shopify.ts) works unchanged
    // (lib/bizsync/shopify/single-store.ts validates + stores it).
    credentialModes: [
      {
        id: "client_credentials",
        label: "Dev Dashboard app",
        help: "dev.shopify.com → your organization → Apps → Create app; select the scopes, release a version, install it on your store, then copy the client ID and secret from Settings. The store must be in the same organization.",
        fields: [
          { name: "shop", label: "Store domain", kind: "shop_domain", required: true, placeholder: "your-store.myshopify.com" },
          { name: "client_id", label: "Client ID", kind: "text", required: true, maxLength: 200 },
          { name: "client_secret", label: "Client secret", kind: "secret", required: true, maxLength: 500 },
        ],
      },
      {
        id: "admin_token",
        label: "Existing custom app token",
        help: "Only for a custom app created in the Shopify admin before 2026 (Apps → Develop apps → API credentials). New apps use the Dev Dashboard.",
        fields: [
          { name: "shop", label: "Store domain", kind: "shop_domain", required: true, placeholder: "your-store.myshopify.com" },
          { name: "access_token", label: "Admin API access token", kind: "secret", required: true, placeholder: "shpat_…", maxLength: 500 },
          { name: "webhook_secret", label: "API secret key (verifies webhooks)", kind: "secret", required: false, maxLength: 500, help: "Shopify signs this app's webhooks with it. Without it, webhooks are refused." },
        ],
      },
    ],
  },
  // Phase 11 (bizsync): QuickBooks Online ↔ the Ops accounting core.
  {
    key: "quickbooks",
    displayName: "QuickBooks",
    authType: "oauth2",
    description: "Map your chart of accounts, import customers and vendors, and post invoices, bills, payments and journals to QuickBooks Online after you confirm.",
    oauth: {
      scopes: QUICKBOOKS_SCOPES,
      envVars: ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET"],
    },
    authNote: "Intuit OAuth 2.0 (one QuickBooks company per connection). QUICKBOOKS_ENVIRONMENT=sandbox for Intuit's sandbox.",
  },
  // Phase 11 (bizsync): Xero ↔ the Ops accounting core (same shape as QuickBooks).
  {
    key: "xero",
    displayName: "Xero",
    authType: "oauth2",
    description: "Pick your Xero organisation, map your chart of accounts, import contacts, and post invoices, bills, payments and manual journals after you confirm.",
    oauth: {
      scopes: XERO_SCOPES,
      envVars: ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET"],
    },
    authNote: "Xero OAuth 2.0; after connecting, choose the organisation in Settings → Connectors → Business sync.",
  },
  // Phase 14 (connectors): Gusto payroll ↔ Ops pay runs (27th built-in).
  {
    key: "gusto",
    displayName: "Gusto",
    authType: "oauth2",
    description:
      "Match team members to Gusto employees, send a computed pay run's hours into Gusto's open payroll after you confirm (Gusto computes the taxes; you submit it in Gusto), and bring Gusto's taxes and net pay back onto the payslips.",
    oauth: {
      scopes: GUSTO_SCOPES,
      envVars: ["GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET"],
    },
    authNote: "Gusto OAuth2, one company per connection (a primary or full-access admin authorizes). GUSTO_ENVIRONMENT=demo (default) uses api.gusto-demo.com; production needs Gusto's app approval with employees:read, payrolls:read and payrolls:write.",
  },
  // Phase 15.4 (zernio): Zernio — ads on 7 networks (Meta, Google, TikTok,
  // LinkedIn, Pinterest, X, OpenAI) and social publishing on 16 platforms,
  // through ONE platform key (28th built-in). Each workspace gets its own
  // Zernio profile; customers connect accounts per platform on the card.
  {
    key: "zernio",
    displayName: "Zernio",
    authType: "none",
    description:
      "Ads on Meta, Google, TikTok, LinkedIn, Pinterest, X and OpenAI, and social publishing on 16 platforms — connect your accounts per platform. Creating ads and raising budgets always ask.",
    authNote:
      "Platform key (ZERNIO_API_KEY, LIVE / pre-added) — nothing to paste. Each workspace gets its own Zernio profile; connect accounts per platform on this card.",
    platformKey: { envVar: "ZERNIO_API_KEY", label: "LIVE / pre-added" },
  },
];

// ---------------------------------------------------------------------------
// E2E TEST SEAM (Playwright). Registered ONLY when E2E_MOCK_OAUTH=1.
// A fake OAuth2 provider whose authorize/token endpoints are same-origin
// routes under /api/e2e/mock-oauth/*. Lets the E2E suite exercise the full
// production OAuth round-trip (signed state → authorize → callback → token
// exchange → encrypted credential → audit row) without touching a live
// provider. NEVER enabled in production.
// ---------------------------------------------------------------------------
if (process.env.E2E_MOCK_OAUTH === "1") {
  BUILT_IN_CONNECTORS.push({
    key: "mock-oauth",
    displayName: "Mock OAuth (E2E only)",
    authType: "oauth2",
    description:
      "Test-only OAuth2 provider for Playwright E2E. Visible only with E2E_MOCK_OAUTH=1.",
    oauth: {
      scopes: ["e2e:read"],
      envVars: ["E2E_MOCK_OAUTH_CLIENT_ID", "E2E_MOCK_OAUTH_CLIENT_SECRET"],
    },
    authNote: "E2E fixture — not a real provider.",
  });
}

const KEYS = new Set(BUILT_IN_CONNECTORS.map((c) => c.key));

export function isBuiltinKey(key: string): boolean {
  return KEYS.has(key);
}

export function getBuiltinMeta(key: string): BuiltinConnectorMeta {
  const meta = BUILT_IN_CONNECTORS.find((c) => c.key === key);
  if (!meta) throw new Error(`Unknown built-in connector key: ${key}`);
  return meta;
}

export function listBuiltinConnectors(): BuiltinConnectorMeta[] {
  return [...BUILT_IN_CONNECTORS];
}

// Adapters are imported statically; each adapter module only imports the
// live client it wraps (lib/connectors/m21/live/*, the WordPress/Webflow
// ports, lib/intelligence/gsc/api.ts), so the import graph stays
// server-side only.
import type { ConnectorAdapter } from "./types";
import { withNoFakesGuard } from "./no-fakes";
import { GoogleSearchConsoleAdapter } from "./native/google-search-console";
import { Ga4Adapter } from "./native/ga4";
import { WordPressM21Adapter } from "./native/wordpress";
import { WebflowM21Adapter } from "./native/webflow";
import { GoogleDriveAdapter } from "./native/google-drive";
import { NotionAdapter } from "./native/notion";
import { BufferAdapter } from "./native/buffer";
import { ResendAdapter } from "./native/resend";
import { DataForSeoAdapter } from "./native/dataforseo";
import { MetaAdsAdapter } from "./native/meta-ads";
import { GoogleAdsAdapter } from "./native/google-ads";
import { GmailAdapter } from "./native/gmail";
import { GoogleCalendarAdapter } from "./native/google-calendar";
import { GoogleBusinessProfileAdapter } from "./native/google-business-profile";
import { OutlookAdapter } from "./native/outlook";
import { OutlookCalendarAdapter } from "./native/outlook-calendar";
import { SlackAdapter } from "./native/slack";
import { HubspotAdapter } from "./native/hubspot";
// Phase 11 (devtools).
import { LinearAdapter } from "./native/linear";
import { JiraAdapter } from "./native/jira";
import { AirtableAdapter } from "./native/airtable";
import { SupabaseAdapter } from "./native/supabase";
import { NetlifyM21Adapter } from "./native/netlify";
import { ShopifyAdapter } from "./native/shopify"; // Phase 11 (bizsync)
import { QuickbooksAdapter } from "./native/quickbooks"; // Phase 11 (bizsync)
import { XeroAdapter } from "./native/xero"; // Phase 11 (bizsync)
import { GustoAdapter } from "./native/gusto"; // Phase 14 (connectors)
import { ZernioAdapter } from "./native/zernio"; // Phase 15.4 (zernio)

const ADAPTER_CLASSES: Record<string, () => ConnectorAdapter> = {
  "google-search-console": () => new GoogleSearchConsoleAdapter(),
  ga4: () => new Ga4Adapter(),
  wordpress: () => new WordPressM21Adapter(),
  webflow: () => new WebflowM21Adapter(),
  "google-drive": () => new GoogleDriveAdapter(),
  notion: () => new NotionAdapter(),
  buffer: () => new BufferAdapter(),
  resend: () => new ResendAdapter(),
  dataforseo: () => new DataForSeoAdapter(),
  "meta-ads": () => new MetaAdsAdapter(),
  "google-ads": () => new GoogleAdsAdapter(),
  // Connector Agent slice 2: live-wired import adapters (NOT mock-only).
  gmail: () => new GmailAdapter(),
  "google-calendar": () => new GoogleCalendarAdapter(),
  "google-business-profile": () => new GoogleBusinessProfileAdapter(),
  // Phase 11 (conncore).
  outlook: () => new OutlookAdapter(),
  "outlook-calendar": () => new OutlookCalendarAdapter(),
  slack: () => new SlackAdapter(),
  hubspot: () => new HubspotAdapter(),
  // Phase 11 (devtools).
  linear: () => new LinearAdapter(),
  jira: () => new JiraAdapter(),
  airtable: () => new AirtableAdapter(),
  supabase: () => new SupabaseAdapter(),
  netlify: () => new NetlifyM21Adapter(),
  // Phase 11 (bizsync).
  shopify: () => new ShopifyAdapter(),
  quickbooks: () => new QuickbooksAdapter(),
  xero: () => new XeroAdapter(),
  // Phase 14 (connectors).
  gusto: () => new GustoAdapter(),
  // Phase 15.4 (zernio): platform key; mock mode is the labelled FAKE Zernio.
  zernio: () => new ZernioAdapter(),
};

/** Resolve a built-in connector key to its native adapter. Throws on unknown key. */
export function resolveAdapter(key: string): ConnectorAdapter {
  const make = ADAPTER_CLASSES[key];
  if (!make) throw new Error(`Unknown built-in connector key: ${key}`);
  // Phase 11 (conncore): production never returns labelled mock data.
  return withNoFakesGuard(make());
}

// ---------------------------------------------------------------------------
// Phase B (B3) / Phase 4b: live-wiring flags for the connector health checker.
//
// Phase 4b wired the last six mock-only adapters (GSC, GA4, Drive, Notion,
// Meta Ads, Google Ads) to their live APIs: with a vault credential they
// call the provider; without one they stay in labeled mock mode. All 28
// built-in adapters have live wiring, so the set is empty (0 mock-only;
// pinned by lib/connectors/m21/__tests__/registry.test.ts). Keep it in
// sync with the per-adapter file headers (scripts/verify-connector-health.mts
// scans them for the MOCK-ONLY marker).
// ---------------------------------------------------------------------------

/** Built-in keys with NO live provider wiring — health is always `unknown`. */
export const MOCK_ONLY_ADAPTER_KEYS: ReadonlySet<string> = new Set<string>([]);

/** True when the adapter has a real provider path the checker can reason about. */
export function hasLiveWiring(key: string): boolean {
  return isBuiltinKey(key) && !MOCK_ONLY_ADAPTER_KEYS.has(key);
}
