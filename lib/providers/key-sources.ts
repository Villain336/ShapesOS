// ShapesOS — Phase 15.1: which keys are LIVE (platform) and which are BYOK.
//
// ONE typed registry the Settings → Providers page renders and docs/KEYS.md
// is checked against (lib/providers/__tests__/key-sources.test.ts fails when
// they drift). Owner decisions, 2026-10-05:
//   platform  one ShapesOS key where the customer shouldn't have to sign up;
//             usage is metered in credits.
//   connect   one ShapesOS OAuth app; each workspace clicks Connect and
//             authorises its own account. No usage cost to ShapesOS.
//   byok      the customer's own money / accounts / sending reputation —
//             ShapesOS must not pay for it or hold it centrally.
//   both      platform default with an optional workspace key; a workspace
//             that brings its own key uses NO credits for that usage.
//   self_host one shared instance isn't tenant-safe: self-hosted deployments
//             use the env instance; on DEPLOYMENT_MODE=hosted the env
//             instance is refused unless the workspace configures its own
//             (lib/integrations/sidecar-tenancy.ts).
// Pure data — no I/O, no secrets. `envVars` are NAMES only.

export type KeyClass = "platform" | "connect" | "byok" | "both" | "self_host";

/** Sentence-case labels the UI and docs use. */
export const KEY_CLASS_LABEL: Readonly<Record<KeyClass, string>> = {
  platform: "Platform",
  connect: "Connect",
  byok: "Bring your own",
  both: "Both",
  self_host: "Self-host or your own",
};

/** One line on what each class means (UI legend + docs). */
export const KEY_CLASS_MEANING: Readonly<Record<KeyClass, string>> = {
  platform: "ShapesOS's key. Nothing to sign up for; usage is charged in credits.",
  connect: "ShapesOS's app. Each workspace clicks Connect and authorises its own account; no credits.",
  byok: "Your own account, money or sending reputation. Add your key; ShapesOS never pays for or holds it centrally.",
  both: "ShapesOS's key by default (charged in credits), or add your own key and use no credits for it.",
  self_host: "Self-hosted: the host's instance. Hosted: connect your own instance (a shared one isn't tenant-safe).",
};

export type KeyGroup = "ai" | "data" | "messaging" | "compute" | "apps" | "marketing" | "accounts" | "sidecars";

export const KEY_GROUP_LABEL: Readonly<Record<KeyGroup, string>> = {
  ai: "AI models",
  data: "Data and research",
  messaging: "Messaging and voice",
  compute: "Compute, build and billing",
  apps: "Business apps",
  marketing: "Marketing and ads",
  accounts: "Your accounts and money",
  sidecars: "Self-hosted tools",
};

export interface KeySourceEntry {
  /** Stable id (kebab-case). */
  id: string;
  label: string;
  class: KeyClass;
  group: KeyGroup;
  /** Host env vars that configure the platform / self-host side (names only). */
  envVars: string[];
  /**
   * Where a workspace adds its OWN key when the class allows it: a
   * WORKSPACE_CREDENTIALS id (Settings → Providers form) or a plain-language
   * place for keys that already have their own screen. Null = none.
   */
  byok: { credential: string } | { where: string } | null;
  /** One sentence for operators. */
  note: string;
  /** Connect class: the built-in m21 connector keys this app serves. */
  m21?: string[];
}

const P = (id: string, label: string, group: KeyGroup, envVars: string[], note: string): KeySourceEntry => ({
  id, label, class: "platform", group, envVars, byok: null, note,
});
const C = (id: string, label: string, group: KeyGroup, envVars: string[], note: string, m21: string[]): KeySourceEntry => ({
  id, label, class: "connect", group, envVars, byok: null, note, m21,
});
const B = (id: string, label: string, group: KeyGroup, where: KeySourceEntry["byok"], note: string, envVars: string[] = []): KeySourceEntry => ({
  id, label, class: "byok", group, envVars, byok: where, note,
});
const BOTH = (id: string, label: string, group: KeyGroup, envVars: string[], where: KeySourceEntry["byok"], note: string): KeySourceEntry => ({
  id, label, class: "both", group, envVars, byok: where, note,
});
const S = (id: string, label: string, envVars: string[], note: string): KeySourceEntry => ({
  id, label, class: "self_host", group: "sidecars", envVars, byok: { credential: `sidecar:${id}` }, note,
});

export const KEY_SOURCES: readonly KeySourceEntry[] = [
  // ── Both: platform default, optional workspace key (no credits) ──
  BOTH("anthropic", "Anthropic models (Claude)", "ai", ["ANTHROPIC_API_KEY"], { credential: "model:anthropic" },
    "Agents, chat and writing. Platform calls are charged at 1.5× token cost; a workspace key uses no AI credits."),
  BOTH("openai", "OpenAI models (GPT)", "ai", ["OPENAI_API_KEY", "LLM_API_KEY"], { credential: "model:openai" },
    "Text workloads and failover. Platform calls are charged at 1.5× token cost; a workspace key uses no AI credits."),
  BOTH("dataforseo", "DataForSEO", "data", ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"], { where: "Intelligence → Data costs" },
    "Keyword, SERP and backlink data; a workspace's own vendor login is charged 0 credits."),
  BOTH("serper", "Serper", "data", ["SERPER_API_KEY"], { where: "Intelligence → Data costs" },
    "SERP data for intelligence; a workspace's own key is charged 0 credits."),
  BOTH("contextdev", "Context.dev", "data", ["CONTEXTDEV_API_KEY"], { where: "Intelligence → Knowledge" },
    "Web research, crawling and brand sync. The platform key is charged 1 credit per Context.dev credit; a workspace key is free."),
  BOTH("resend-newsletter", "Resend (newsletter)", "messaging", ["RESEND_API_KEY"], { where: "Project → Newsletter" },
    "Newsletter sends on the platform domain, or the workspace's own Resend key."),

  // ── Platform: ShapesOS key, metered in credits ──
  P("openai-images", "OpenAI images, transcription and extraction", "ai", ["OPENAI_API_KEY", "LLM_IMAGE_MODEL"],
    "Image generation (3 / 22 / 85 credits by quality), transcription and extraction on the platform key."),
  P("moz", "Moz / OpenPageRank", "data", ["MOZ_ACCESS_ID", "MOZ_SECRET_KEY", "OPENPAGERANK_API_KEY"], "Domain authority data."),
  P("yelp", "Yelp", "data", ["YELP_API_KEY"], "Local listings and reviews."),
  P("newsapi", "NewsAPI", "data", ["M3_LICENSED_NEWS_PROVIDER", "M3_NEWSAPI_KEY"], "News mentions for AI visibility."),
  P("pagespeed", "PageSpeed Insights", "data", ["PAGESPEED_API_KEY"], "Core Web Vitals in site audits."),
  P("apollo-hunter", "Apollo / Hunter", "data", ["APOLLO_API_KEY", "HUNTER_API_KEY"], "Prospect enrichment (2 credits per lookup)."),
  P("brand-media", "Brandfetch, Cloudinary, Pexels, Pixabay, Unsplash", "data",
    ["BRANDFETCH_API_KEY", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "PEXELS_API_KEY", "PIXABAY_API_KEY", "UNSPLASH_ACCESS_KEY"], "Brand assets and stock media."),
  P("composio", "Composio", "apps", ["COMPOSIO_API_KEY"], "Hosted app actions (1 credit per tool call)."),
  // Phase 15.4 (zernio): LIVE / pre-added. One platform key; each workspace gets
  // its own Zernio profile and connects its accounts there (Settings → Connectors).
  P("zernio", "Zernio (ads on 7 networks, social on 16 platforms)", "marketing", ["ZERNIO_API_KEY", "ZERNIO_BASE_URL"],
    "One profile per workspace; 2 accounts included (plans include 3 / 10 / 25 / 50), then 600 credits per account a month. Creating ads and raising budgets always ask."),
  P("twilio", "Twilio SMS and voice", "messaging", ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
    "SMS (4 credits a segment), voice minutes, tracking numbers and transcription."),
  P("system-mail", "Resend / SMTP system mail", "messaging", ["SMTP_HOST", "SMTP_FROM", "SMTP_USER", "SMTP_PASS", "INVITE_MAIL_FROM"],
    "Invites, magic links and alerts. System mail is free."),
  P("e2b", "E2B sandboxes", "compute", ["E2B_API_KEY", "SANDBOX_PROVIDER"], "Agent code sandboxes (1 credit per started minute)."),
  P("github-app", "GitHub App", "compute", ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"], "Repos, branches and pull requests."),
  P("expo", "Expo", "compute", ["EXPO_ACCESS_TOKEN"], "Mobile app builds."),
  P("livekit", "LiveKit", "compute", ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_URL"], "Realtime voice and video."),
  P("stripe-billing", "ShapesOS Stripe billing", "compute", ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"], "Plans, seats, top-ups and overage."),

  // ── Connect: platform OAuth app, each workspace authorises its own account ──
  // `m21` names the built-in connectors (lib/connectors/m21/registry.ts); the
  // unit suite checks envVars cover each connector's own env var names.
  C("google", "Google (Analytics, Search Console, Business Profile, Ads, Drive, Gmail, Calendar)", "apps",
    ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN"],
    "One Google app; the Ads developer token is the platform's.",
    ["google-search-console", "ga4", "google-drive", "google-ads", "gmail", "google-calendar", "google-business-profile"]),
  C("microsoft", "Microsoft (Outlook mail and calendar)", "apps", ["MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET"],
    "Mail and calendar.", ["outlook", "outlook-calendar"]),
  C("slack", "Slack", "apps", ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"], "Notifications and approvals.", ["slack"]),
  C("hubspot", "HubSpot", "apps", ["HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET"], "CRM sync.", ["hubspot"]),
  C("linear", "Linear", "apps", ["LINEAR_OAUTH_CLIENT_ID", "LINEAR_OAUTH_CLIENT_SECRET"], "Issues.", ["linear"]),
  C("atlassian", "Atlassian (Jira)", "apps", ["ATLASSIAN_OAUTH_CLIENT_ID", "ATLASSIAN_OAUTH_CLIENT_SECRET"], "Issues.", ["jira"]),
  C("airtable", "Airtable", "apps", ["AIRTABLE_OAUTH_CLIENT_ID", "AIRTABLE_OAUTH_CLIENT_SECRET"], "Bases.", ["airtable"]),
  C("notion", "Notion", "apps", ["NOTION_OAUTH_CLIENT_ID", "NOTION_OAUTH_CLIENT_SECRET"], "Pages and databases.", ["notion"]),
  C("webflow", "Webflow", "marketing", ["WEBFLOW_OAUTH_CLIENT_ID", "WEBFLOW_OAUTH_CLIENT_SECRET"], "Sites and CMS.", ["webflow"]),
  C("buffer", "Buffer", "marketing", ["BUFFER_OAUTH_CLIENT_ID", "BUFFER_OAUTH_CLIENT_SECRET"], "Social scheduling.", ["buffer"]),
  C("meta", "Meta (Facebook, Instagram, Ads)", "marketing", ["META_OAUTH_CLIENT_ID", "META_OAUTH_CLIENT_SECRET"],
    "Pages, Instagram and ad accounts.", ["meta-ads"]),
  C("amazon-ads", "Amazon Ads", "marketing", ["AMAZON_ADS_CLIENT_ID", "AMAZON_ADS_CLIENT_SECRET"], "Sponsored ads.", []),
  C("shopify", "Shopify", "apps", ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"], "Store sync (or a single-store token, below).", ["shopify"]),
  C("quickbooks", "QuickBooks", "apps", ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET"], "Accounting export.", ["quickbooks"]),
  C("xero", "Xero", "apps", ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET"], "Accounting export.", ["xero"]),
  C("gusto", "Gusto", "apps", ["GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET"], "Payroll.", ["gusto"]),

  // ── Bring your own: the customer's money, accounts or reputation ──
  B("stripe-tenant", "Stripe (your payments) and POS terminal", "accounts", { where: "Ops → Accounting → Settings" },
    "Your customers pay you; ShapesOS never holds your Stripe key centrally."),
  B("stackadapt", "StackAdapt", "accounts", { where: "Media → Advertising" }, "Your ad spend."),
  B("mail-print", "Lob / PostGrid", "accounts", { where: "Settings → Mail" }, "Your postage."),
  B("higgsfield", "Higgsfield", "accounts", { where: "Project → Ads" }, "Your video generation account."),
  B("porkbun", "Porkbun", "accounts", { where: "Project → Studio" }, "Your domain purchases."),
  B("hosting", "Hosting (Vercel, Cloudflare Pages, Netlify)", "accounts", { where: "Project → Sites → Hosting" }, "Your hosting accounts."),
  B("site-credentials", "WordPress / SFTP site credentials", "accounts", { where: "Project → Sites" }, "Your sites."),
  B("supabase", "Supabase", "accounts", { where: "Settings → Connectors" }, "Your database."),
  B("smartlead", "Smartlead", "accounts", { credential: "outreach:smartlead" },
    "Your sending domains and reputation. Env keys are the self-hosted fallback only.", ["SMARTLEAD_API_KEY", "SMARTLEAD_RELAY_CAMPAIGN_IDS"]),
  B("instantly", "Instantly", "accounts", { credential: "outreach:instantly" },
    "Your sending domains and reputation. Env keys are the self-hosted fallback only.", ["INSTANTLY_API_KEY", "INSTANTLY_RELAY_CAMPAIGN_IDS"]),
  B("alert-webhooks", "Alert channel webhooks (Slack, Telegram)", "accounts", { where: "Settings → Alerts" }, "Your channels."),
  B("custom-mcp", "Custom MCP servers", "accounts", { where: "Settings → Connectors" }, "Your servers."),
  B("shopify-store", "Shopify single-store token", "accounts", { where: "Settings → Connectors → Shopify" }, "Your store's own app token."),

  // ── Self-host only, or the workspace's own instance on hosted ──
  S("postiz", "Postiz", ["POSTIZ_URL", "POSTIZ_API_KEY"], "Social scheduling sidecar."),
  S("listmonk", "Listmonk", ["LISTMONK_URL", "LISTMONK_USER", "LISTMONK_TOKEN"], "Newsletter lists and campaigns."),
  S("plane", "Plane", ["PLANE_BASE_URL", "PLANE_API_KEY", "PLANE_WORKSPACE_SLUG"], "Project issues."),
  S("ghost", "Ghost", ["GHOST_URL", "GHOST_ADMIN_API_KEY"], "Blog publishing."),
  S("documenso", "Documenso", ["DOCUMENSO_URL", "DOCUMENSO_API_KEY"], "E-signatures."),
  S("growthbook", "GrowthBook", ["GROWTHBOOK_API_HOST", "GROWTHBOOK_API_KEY", "GROWTHBOOK_CLIENT_KEY"], "Feature flags and experiments."),
  S("umami", "Umami", ["UMAMI_URL", "UMAMI_API_KEY", "UMAMI_WEBSITE_ID", "UMAMI_SCRIPT_URL"], "Cookieless analytics."),
  S("chatwoot", "Chatwoot", ["CHATWOOT_BASE_URL", "CHATWOOT_WEBSITE_TOKEN", "CHATWOOT_WIDGET_ENABLED"], "Live chat widget."),
];

/** Entries of one class, in registry order. */
export function keySourcesByClass(cls: KeyClass): KeySourceEntry[] {
  return KEY_SOURCES.filter((e) => e.class === cls);
}

/** Every problem with the registry, or [] (unit suite + boot check). */
export function keySourceProblems(credentialIds: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of KEY_SOURCES) {
    if (seen.has(e.id)) problems.push(`duplicate id ${e.id}`);
    seen.add(e.id);
    if (!(e.class in KEY_CLASS_LABEL)) problems.push(`${e.id}: unknown class ${e.class}`);
    if ((e.class === "byok" || e.class === "both" || e.class === "self_host") && !e.byok) {
      problems.push(`${e.id}: class ${e.class} needs a BYOK entry (credential or where)`);
    }
    if ((e.class === "platform" || e.class === "connect") && e.byok) problems.push(`${e.id}: class ${e.class} must not offer BYOK`);
    if ((e.class === "platform" || e.class === "connect" || e.class === "self_host") && e.envVars.length === 0) {
      problems.push(`${e.id}: class ${e.class} needs its env var names`);
    }
    if (e.byok && "credential" in e.byok && !credentialIds.includes(e.byok.credential)) {
      problems.push(`${e.id}: unknown workspace credential ${e.byok.credential}`);
    }
    for (const v of e.envVars) if (!/^[A-Z][A-Z0-9_]*$/.test(v)) problems.push(`${e.id}: bad env var name ${v}`);
  }
  return problems;
}

/** The docs/KEYS.md table body, generated from the registry (the test diffs it). */
export function keysMarkdownTable(): string {
  const lines = ["| Provider | Source | Env vars (platform / self-host) | Bring your own | Notes |", "|---|---|---|---|---|"];
  for (const e of KEY_SOURCES) {
    const byok = !e.byok ? "—" : "credential" in e.byok ? "Settings → Providers" : e.byok.where;
    const env = e.envVars.length ? e.envVars.map((v) => `\`${v}\``).join(", ") : "—";
    lines.push(`| ${e.label} | ${KEY_CLASS_LABEL[e.class]} | ${env} | ${byok} | ${e.note} |`);
  }
  return lines.join("\n");
}
