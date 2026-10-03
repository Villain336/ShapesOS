// Marketr — M21 built-in connector registry (spec §7, §11).
//
// DESIGN DECISION (recorded in prisma/schema.prisma): the 12 built-in
// connectors are CODE-defined here, not DB rows. `Connector` rows exist
// ONLY for workspace-custom MCP servers (kind=mcp). Do not create DB rows
// for built-in keys — resolveAdapter() maps a built-in key directly to
// its native adapter class.

export type ConnectorAuthType = "oauth2" | "api_key" | "none";

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
}

export const BUILT_IN_CONNECTORS: BuiltinConnectorMeta[] = [
  {
    key: "google-search-console",
    displayName: "Google Search Console",
    authType: "oauth2",
    description: "Search performance: queries, pages, clicks, impressions, CTR, position.",
    oauth: {
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
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
  },
  {
    key: "dataforseo",
    displayName: "DataForSEO",
    authType: "api_key",
    description: "Keyword ideas, SERP snapshots, competitor keywords, backlinks.",
    authNote: "DataForSEO login + password (basic auth pair stored as one credential).",
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
      "Import your email network: message metadata (who you email, how often, how recently) becomes contact-graph signal. Bodies are never read.",
    oauth: {
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
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
      "Import your meeting network: event attendees and organizers become contact-graph nodes. Event details are never read.",
    oauth: {
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
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
// live port it wraps (DataForSEO, WordPress, Webflow, Buffer, Resend), so
// the import graph stays server-side only.
import type { ConnectorAdapter } from "./types";
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
};

/** Resolve a built-in connector key to its native adapter. Throws on unknown key. */
export function resolveAdapter(key: string): ConnectorAdapter {
  const make = ADAPTER_CLASSES[key];
  if (!make) throw new Error(`Unknown built-in connector key: ${key}`);
  return make();
}

// ---------------------------------------------------------------------------
// Phase B (B3) / Phase 4b: live-wiring flags for the connector health checker.
//
// Phase 4b wired the last six mock-only adapters (GSC, GA4, Drive, Notion,
// Meta Ads, Google Ads) to their live APIs: with a vault credential they
// call the provider; without one they stay in labeled mock mode. No
// built-in adapter is mock-only any more, so the set is empty. Keep it in
// sync with the per-adapter file headers (scripts/verify-connector-health.mts
// scans them for the MOCK-ONLY marker).
// ---------------------------------------------------------------------------

/** Built-in keys with NO live provider wiring — health is always `unknown`. */
export const MOCK_ONLY_ADAPTER_KEYS: ReadonlySet<string> = new Set<string>([]);

/** True when the adapter has a real provider path the checker can reason about. */
export function hasLiveWiring(key: string): boolean {
  return isBuiltinKey(key) && !MOCK_ONLY_ADAPTER_KEYS.has(key);
}
