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
      scopes: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/drive.file",
      ],
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
      scopes: ["ads_read", "ads_management"],
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
    authNote: "Google OAuth2 + a developer token (per-user).",
  },
  {
    key: "canva",
    displayName: "Canva",
    authType: "oauth2",
    description: "Read and export Canva designs and brand assets.",
    oauth: {
      scopes: ["design:content:read", "asset:read"],
      envVars: ["CANVA_OAUTH_CLIENT_ID", "CANVA_OAUTH_CLIENT_SECRET"],
    },
    authNote: "Canva Connect API OAuth (review-gated in production).",
  },
];

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
import { CanvaAdapter } from "./native/canva";

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
  canva: () => new CanvaAdapter(),
};

/** Resolve a built-in connector key to its native adapter. Throws on unknown key. */
export function resolveAdapter(key: string): ConnectorAdapter {
  const make = ADAPTER_CLASSES[key];
  if (!make) throw new Error(`Unknown built-in connector key: ${key}`);
  return make();
}
