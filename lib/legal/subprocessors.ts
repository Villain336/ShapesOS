// ShapesOS — subprocessor registry (beta readiness, WS=legal).
//
// ONE typed list of every third party that can process customer data on a
// hosted ShapesOS install. /subprocessors renders it, /privacy reads it for
// its "who we share data with" section, and the unit test
// (lib/legal/__tests__/subprocessors.test.ts) fails when a provider env var
// appears in .env.example — or a row in lib/providers/key-sources.ts —
// without a row here or an explicit "not a subprocessor" reason below.
//
// Written from the code, not from marketing: `purpose`, `dataShared` and
// `retention` say what the integration actually sends and what we know the
// vendor keeps. Nothing here claims a certification ShapesOS does not hold.
// Legal review pending (lib/legal/public-pages.ts LEGAL_DRAFT_PENDING_REVIEW).
//
// Pure data — no I/O, no secrets. `envVars` are NAMES only.

export type SubprocessorBasis =
  /** Runs on every hosted install: part of the platform. */
  | "platform"
  /** Only when the operator sets the key (off otherwise). */
  | "when_configured"
  /** Only after a workspace member connects that account (our OAuth app). */
  | "connected"
  /** The customer's own account, key or instance; ShapesOS never holds it centrally. */
  | "customer_chosen";

export const SUBPROCESSOR_BASIS_LABEL: Readonly<Record<SubprocessorBasis, string>> = {
  platform: "Platform",
  when_configured: "When configured",
  connected: "When you connect it",
  customer_chosen: "Your own account",
};

export const SUBPROCESSOR_BASIS_MEANING: Readonly<Record<SubprocessorBasis, string>> = {
  platform: "Part of the hosted service. Every workspace's data can reach it.",
  when_configured: "Used only when the operator has turned it on for the install.",
  connected: "Used only for the workspace that connects its own account through the ShapesOS app.",
  customer_chosen: "You bring the account, key or instance; you hold the contract with the vendor.",
};

export interface Subprocessor {
  /** Stable id (kebab-case). */
  id: string;
  name: string;
  basis: SubprocessorBasis;
  /** What ShapesOS uses it for. */
  purpose: string;
  /** What data can reach it. */
  dataShared: string;
  /** Where the vendor processes the data, as far as the code and the deploy docs know. */
  location: string;
  /** What is kept there, and the setting that controls it when we have one. */
  retention: string;
  /** Host env var NAMES that configure it (documented in .env.example). */
  envVars: readonly string[];
  /** lib/providers/key-sources.ts ids this row covers. */
  keySourceIds: readonly string[];
}

const row = (s: Subprocessor): Subprocessor => s;

export const SUBPROCESSORS: readonly Subprocessor[] = [
  // ── Platform infrastructure (always, on hosted) ──
  row({
    id: "render",
    name: "Render",
    basis: "platform",
    purpose: "Hosts the web service, the agent worker, the scheduled jobs and the PostgreSQL 16 database (render.yaml).",
    dataShared: "All account and workspace data, at rest in the database and in transit through the service.",
    location: "Virginia, United States (Render region virginia).",
    retention: "Database point-in-time recovery for 7 days and logical exports kept 7 days (docs/deploy/RENDER.md). Render's SOC 2 report is Render's, not ours.",
    envVars: ["RENDER_API_KEY"],
    keySourceIds: [],
  }),
  row({
    id: "cloudflare",
    name: "Cloudflare",
    basis: "platform",
    purpose: "DNS, TLS termination and the proxy / rate-limit rule in front of the app; R2 object storage for uploaded files, reports, run recordings and the nightly database backup; Turnstile CAPTCHA on sign-in when CAPTCHA_PROVIDER=turnstile.",
    dataShared: "Every request passes through the proxy (IP address, headers, request bodies in transit). Files, reports and recordings are stored in R2 (bucket shapesos-files); backups in shapesos-backups. Turnstile sees the sign-in visitor's IP and browser signals.",
    location: "Global edge network; R2 buckets use the \"auto\" jurisdiction (data stored in the nearest Cloudflare region to the first write).",
    retention: "Files stay until deleted by the workspace or the workspace is deleted. Backups are removed after 35 days by the bucket lifecycle rule.",
    envVars: ["MARKETR_S3_ENDPOINT", "MARKETR_S3_ACCESS_KEY", "MARKETR_S3_SECRET_KEY", "BACKUP_S3_ENDPOINT", "BACKUP_S3_ACCESS_KEY", "BACKUP_S3_SECRET_KEY", "CAPTCHA_SECRET_KEY", "LIVE_CLOUDFLARE_TOKEN"],
    keySourceIds: [],
  }),

  // ── Model providers ──
  row({
    id: "anthropic",
    name: "Anthropic",
    basis: "platform",
    purpose: "Claude models for the lead agent, sub-agents, the code agent and client-facing copy (lib/llm/router.ts).",
    dataShared: "Prompts and tool results: the messages, documents, records and files an agent is working on, plus the tool outputs it reads. Never the vault secrets or your provider keys. A workspace that adds its own Anthropic key sends the same calls under its own account.",
    location: "United States.",
    retention: "By default only zero-data-retention-eligible models are routed; models that require 30-day retention are used only when the operator sets LLM_ALLOW_RETENTION_MODELS=1 (lib/llm/router.ts).",
    envVars: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "LIVE_ANTHROPIC_API_KEY"],
    keySourceIds: ["anthropic"],
  }),
  row({
    id: "openai",
    name: "OpenAI",
    basis: "platform",
    purpose: "GPT models for bulk and background text work and model failover; image generation; transcription and extraction (lib/llm/openai.ts, lib/images, lib/clipper/transcribe.ts).",
    dataShared: "Prompts, tool results, images to generate or describe, audio to transcribe. A workspace that adds its own OpenAI key sends the text calls under its own account.",
    location: "United States.",
    retention: "Text requests are sent with store: false so responses are not kept on OpenAI's side beyond its abuse-monitoring window (lib/llm/openai.ts). Image and audio calls follow OpenAI's API data policy.",
    envVars: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_API_KEY", "LLM_BASE_URL", "EXTRACTION_API_KEY", "TRANSCRIPTION_API_KEY", "TRANSCRIPTION_BASE_URL"],
    keySourceIds: ["openai", "openai-images"],
  }),

  // ── Billing, mail, compute ──
  row({
    id: "stripe",
    name: "Stripe",
    basis: "platform",
    purpose: "Plans, seats, credit top-ups and invoices for the hosted service (lib/metering/billing.ts).",
    dataShared: "Billing email, workspace id and plan, and the payment details you enter on Stripe's hosted checkout page. Card numbers never touch ShapesOS.",
    location: "United States (Stripe, Inc.), with Stripe's global processing.",
    retention: "Stripe keeps payment and invoice records under its own policy; ShapesOS keeps the Stripe customer and subscription ids.",
    envVars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    keySourceIds: ["stripe-billing"],
  }),
  row({
    id: "resend",
    name: "Resend",
    basis: "platform",
    purpose: "System email (invites, sign-in links, password resets, alerts, finance documents, booking mail), newsletter sends on the platform domain, and inbound reply handling for the CRM inbox.",
    dataShared: "Recipient addresses and names, subject and message content, delivery events.",
    location: "United States.",
    retention: "Resend keeps delivery logs under its own policy; ShapesOS keeps the message ledger in your workspace.",
    envVars: ["RESEND_API_KEY", "RESEND_INBOUND_WEBHOOK_SECRET", "RESEND_WEBHOOK_SECRET"],
    keySourceIds: ["system-mail", "resend-newsletter"],
  }),
  row({
    id: "e2b",
    name: "E2B",
    basis: "platform",
    purpose: "Ephemeral sandboxes where the code agent runs commands, tests and builds (SANDBOX_PROVIDER=e2b, lib/sandbox).",
    dataShared: "Repository contents and files the agent works on, command output, and any data a run writes into its sandbox.",
    location: "United States.",
    retention: "Sandboxes are destroyed when the run ends or idles out (lib/sandbox); checkpoints live in ShapesOS storage, not at E2B.",
    envVars: ["E2B_API_KEY"],
    keySourceIds: ["e2b"],
  }),
  row({
    id: "daytona",
    name: "Daytona",
    basis: "when_configured",
    purpose: "Alternative sandbox provider for the code agent (SANDBOX_PROVIDER=daytona).",
    dataShared: "Same as E2B: repository contents, files and command output of a run.",
    location: "Per Daytona's region configuration.",
    retention: "Sandboxes are destroyed when the run ends or idles out.",
    envVars: ["DAYTONA_API_KEY", "DAYTONA_API_URL"],
    keySourceIds: [],
  }),
  row({
    id: "zernio",
    name: "Zernio",
    basis: "platform",
    purpose: "Ads on 7 networks and social publishing on 16 platforms. Each workspace gets its own Zernio profile and connects its accounts there (Settings → Connectors).",
    dataShared: "The tokens of the social and ad accounts you connect, the posts, creatives, budgets and the spend and performance metrics that come back. Creating ads and raising budgets always ask you first.",
    location: "Per Zernio's hosting (not verified in code).",
    retention: "Zernio keeps the connected-account tokens and campaign history for the profile until the account is disconnected.",
    envVars: ["ZERNIO_API_KEY", "ZERNIO_BASE_URL"],
    keySourceIds: ["zernio"],
  }),
  row({
    id: "twilio",
    name: "Twilio",
    basis: "when_configured",
    purpose: "SMS, voice calls, call-tracking numbers and call transcription (lib/calls, lib/messaging).",
    dataShared: "Phone numbers, message text, call audio and transcripts, caller ids.",
    location: "United States, with Twilio's global carrier network.",
    retention: "Twilio keeps message and call logs under its own policy; ShapesOS stores the transcript and the call row in your workspace.",
    envVars: ["TWILIO_AUTH_TOKEN", "TWILIO_API_KEY", "TWILIO_API_SECRET"],
    keySourceIds: ["twilio"],
  }),
  row({
    id: "livekit",
    name: "LiveKit",
    basis: "when_configured",
    purpose: "Realtime voice and video sessions (media is relayed through LiveKit's servers).",
    dataShared: "Audio and video streams of a session and the participant identities.",
    location: "Per the configured LiveKit region.",
    retention: "Streams are not recorded by LiveKit unless a recording is started; ShapesOS stores recordings it makes in its own storage.",
    envVars: ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_URL", "LIVEKIT_CLOUD_API_KEY", "LIVEKIT_CLOUD_API_SECRET", "LIVEKIT_CLOUD_URL"],
    keySourceIds: ["livekit"],
  }),
  row({
    id: "composio",
    name: "Composio",
    basis: "when_configured",
    purpose: "Hosted actions on business apps (1 credit per tool call). Composio holds the OAuth tokens for the apps a workspace connects through it.",
    dataShared: "The connected app's OAuth tokens and the request and response of each action an agent runs.",
    location: "United States (not verified in code).",
    retention: "Tokens stay at Composio until the app is disconnected.",
    envVars: ["COMPOSIO_API_KEY", "COMPOSIO_BASE_URL"],
    keySourceIds: ["composio"],
  }),
  row({
    id: "expo",
    name: "Expo (EAS)",
    basis: "when_configured",
    purpose: "Mobile app builds.",
    dataShared: "The app source and build artifacts of the project being built.",
    location: "United States.",
    retention: "Build artifacts under Expo's own policy.",
    envVars: ["EXPO_ACCESS_TOKEN"],
    keySourceIds: ["expo"],
  }),
  row({
    id: "github",
    name: "GitHub",
    basis: "connected",
    purpose: "Repositories, branches and pull requests the code agent works on, through the ShapesOS GitHub App installed on your organisation.",
    dataShared: "Repository contents, branch and pull-request text, webhook events for the repositories you install the app on.",
    location: "United States (GitHub, Inc.).",
    retention: "Your repositories stay at GitHub under your own account; ShapesOS keeps the clone only inside a run's sandbox.",
    envVars: ["GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "LIVE_GITHUB_TOKEN"],
    keySourceIds: ["github-app"],
  }),

  // ── Data and research vendors (business data: keywords, domains, pages, listings) ──
  row({
    id: "dataforseo",
    name: "DataForSEO",
    basis: "platform",
    purpose: "Keyword, SERP, backlink and business-listing data (lib/providers/dataforseo.ts).",
    dataShared: "The keywords, domains, locations and business names you research. No end-user personal data.",
    location: "Not verified in code.",
    retention: "Query logs under DataForSEO's policy.",
    envVars: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
    keySourceIds: ["dataforseo"],
  }),
  row({
    id: "serper",
    name: "Serper",
    basis: "when_configured",
    purpose: "Google SERP data for intelligence.",
    dataShared: "The search queries you research.",
    location: "Not verified in code.",
    retention: "Query logs under Serper's policy.",
    envVars: ["SERPER_API_KEY"],
    keySourceIds: ["serper"],
  }),
  row({
    id: "contextdev",
    name: "Context.dev",
    basis: "when_configured",
    purpose: "Web research, crawling and brand sync.",
    dataShared: "The URLs and research questions you ask about, and the pages fetched for them.",
    location: "Not verified in code.",
    retention: "Under Context.dev's policy.",
    envVars: ["CONTEXTDEV_API_KEY"],
    keySourceIds: ["contextdev"],
  }),
  row({
    id: "talordata",
    name: "Talor Data",
    basis: "when_configured",
    purpose: "Intelligence data vendor routed through the data-source registry (lib/intelligence/providers).",
    dataShared: "The keywords and domains you research.",
    location: "Not verified in code.",
    retention: "Under the vendor's policy.",
    envVars: ["TALORDATA_API_KEY"],
    keySourceIds: [],
  }),
  row({
    id: "moz-openpagerank",
    name: "Moz / OpenPageRank",
    basis: "when_configured",
    purpose: "Domain authority data.",
    dataShared: "The domains you look up.",
    location: "United States.",
    retention: "Query logs under each vendor's policy.",
    envVars: ["MOZ_SECRET_KEY", "OPENPAGERANK_API_KEY"],
    keySourceIds: ["moz"],
  }),
  row({
    id: "yelp",
    name: "Yelp",
    basis: "when_configured",
    purpose: "Local listings and reviews.",
    dataShared: "The business names and locations you look up.",
    location: "United States.",
    retention: "Query logs under Yelp's policy.",
    envVars: ["YELP_API_KEY"],
    keySourceIds: ["yelp"],
  }),
  row({
    id: "newsapi",
    name: "NewsAPI",
    basis: "when_configured",
    purpose: "News mentions for AI visibility.",
    dataShared: "The brand and topic queries you track.",
    location: "Not verified in code.",
    retention: "Query logs under NewsAPI's policy.",
    envVars: ["M3_NEWSAPI_KEY"],
    keySourceIds: ["newsapi"],
  }),
  row({
    id: "pagespeed",
    name: "Google PageSpeed Insights",
    basis: "when_configured",
    purpose: "Core Web Vitals in site audits.",
    dataShared: "The URLs you audit (Google fetches them).",
    location: "United States (Google LLC).",
    retention: "Under Google's API policy.",
    envVars: ["PAGESPEED_API_KEY"],
    keySourceIds: ["pagespeed"],
  }),
  row({
    id: "apollo-hunter",
    name: "Apollo / Hunter",
    basis: "when_configured",
    purpose: "Prospect enrichment (2 credits per lookup).",
    dataShared: "Personal data of the prospects you enrich: names, work emails, companies and domains. You are responsible for a lawful basis to enrich them.",
    location: "United States.",
    retention: "Lookups under each vendor's policy; results are stored in your CRM.",
    envVars: ["APOLLO_API_KEY", "HUNTER_API_KEY"],
    keySourceIds: ["apollo-hunter"],
  }),
  row({
    id: "brand-media",
    name: "Brandfetch, Cloudinary, Pexels, Pixabay, Unsplash",
    basis: "when_configured",
    purpose: "Brand assets and stock media for the design studio.",
    dataShared: "Domain names (Brandfetch), search terms (stock libraries) and, for Cloudinary, the images uploaded for transformation.",
    location: "Not verified in code (vendor-dependent).",
    retention: "Cloudinary keeps uploaded transforms until deleted; the others keep query logs.",
    envVars: ["BRANDFETCH_API_KEY", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "PEXELS_API_KEY", "PIXABAY_API_KEY", "UNSPLASH_ACCESS_KEY"],
    keySourceIds: ["brand-media"],
  }),

  // ── Sign-in, telemetry, push ──
  row({
    id: "google-signin",
    name: "Google (Sign in with Google)",
    basis: "when_configured",
    purpose: "Google OAuth sign-in (auth.ts).",
    dataShared: "Your Google account email, name and subject id at sign-in.",
    location: "United States (Google LLC).",
    retention: "Google logs the sign-in under its own policy; ShapesOS keeps the subject id as your user id.",
    envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    keySourceIds: [],
  }),
  row({
    id: "hcaptcha",
    name: "hCaptcha",
    basis: "when_configured",
    purpose: "Alternative CAPTCHA step-up on sign-in (CAPTCHA_PROVIDER=hcaptcha).",
    dataShared: "The sign-in visitor's IP address and browser signals.",
    location: "United States.",
    retention: "Under hCaptcha's policy.",
    envVars: ["CAPTCHA_SECRET_KEY"],
    keySourceIds: [],
  }),
  row({
    id: "sentry",
    name: "Sentry (or self-hosted GlitchTip)",
    basis: "when_configured",
    purpose: "Server error reports (lib/observability/sentry.ts).",
    dataShared: "Error type, a scrubbed message and stack, the route, method and request id. Never headers, cookies, query strings, bodies, user ids or emails.",
    location: "United States for sentry.io; wherever the operator hosts GlitchTip otherwise.",
    retention: "Events for the retention period configured on the error tracker.",
    envVars: ["SENTRY_DSN"],
    keySourceIds: [],
  }),
  row({
    id: "otel-collector",
    name: "OpenTelemetry collector (operator-chosen)",
    basis: "when_configured",
    purpose: "Request traces (lib/observability/otel.ts).",
    dataShared: "Spans with route names, timings and the URLs of outbound calls.",
    location: "Wherever the operator points OTEL_EXPORTER_OTLP_ENDPOINT.",
    retention: "Under the collector's own policy.",
    envVars: ["OTEL_EXPORTER_OTLP_ENDPOINT"],
    keySourceIds: [],
  }),
  row({
    id: "web-push",
    name: "Browser push services (Apple, Google, Mozilla)",
    basis: "when_configured",
    purpose: "Web Push notifications to browsers that opted in (lib/push).",
    dataShared: "The subscription endpoint and an encrypted payload; the push service cannot read the notification text.",
    location: "The browser vendor's push service.",
    retention: "Undelivered messages are dropped after the push service's TTL.",
    envVars: ["VAPID_PRIVATE_KEY"],
    keySourceIds: [],
  }),

  // ── Connect: the ShapesOS OAuth app, each workspace authorises its own account ──
  row({
    id: "google-workspace",
    name: "Google (Analytics, Search Console, Business Profile, Ads, Drive, Gmail, Calendar)",
    basis: "connected",
    purpose: "Reads and writes in the Google products you connect.",
    dataShared: "The data of the connected product: analytics, search data, listings, ad accounts, files, mail and calendar entries, as the scopes you grant allow.",
    location: "United States (Google LLC).",
    retention: "Stays in your Google account; ShapesOS stores the OAuth tokens encrypted and what agents fetched.",
    envVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN", "GBP_API_KEY", "MARKETR_GBP_WEBHOOK_SECRET"],
    keySourceIds: ["google"],
  }),
  row({ id: "microsoft", name: "Microsoft (Outlook mail and calendar)", basis: "connected", purpose: "Mail and calendar.", dataShared: "The mailbox and calendar entries you connect.", location: "United States / European Union per your Microsoft tenant.", retention: "Stays in your Microsoft account.", envVars: ["MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET"], keySourceIds: ["microsoft"] }),
  row({ id: "slack", name: "Slack", basis: "connected", purpose: "Notifications and approvals in your Slack workspace.", dataShared: "Messages ShapesOS posts and the replies it reads.", location: "United States.", retention: "Stays in your Slack workspace.", envVars: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"], keySourceIds: ["slack"] }),
  row({ id: "hubspot", name: "HubSpot", basis: "connected", purpose: "CRM sync.", dataShared: "Contacts, companies and deals you sync.", location: "United States / European Union per your HubSpot account.", retention: "Stays in your HubSpot account.", envVars: ["HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET"], keySourceIds: ["hubspot"] }),
  row({ id: "linear", name: "Linear", basis: "connected", purpose: "Issues.", dataShared: "The issues and comments you sync.", location: "United States.", retention: "Stays in your Linear workspace.", envVars: ["LINEAR_OAUTH_CLIENT_ID", "LINEAR_OAUTH_CLIENT_SECRET"], keySourceIds: ["linear"] }),
  row({ id: "atlassian", name: "Atlassian (Jira)", basis: "connected", purpose: "Issues.", dataShared: "The issues and comments you sync.", location: "Per your Atlassian site's region.", retention: "Stays in your Atlassian site.", envVars: ["ATLASSIAN_OAUTH_CLIENT_ID", "ATLASSIAN_OAUTH_CLIENT_SECRET"], keySourceIds: ["atlassian"] }),
  row({ id: "airtable", name: "Airtable", basis: "connected", purpose: "Bases.", dataShared: "The bases and records you sync.", location: "United States.", retention: "Stays in your Airtable account.", envVars: ["AIRTABLE_OAUTH_CLIENT_ID", "AIRTABLE_OAUTH_CLIENT_SECRET"], keySourceIds: ["airtable"] }),
  row({ id: "notion", name: "Notion", basis: "connected", purpose: "Pages and databases.", dataShared: "The pages and databases you sync.", location: "United States.", retention: "Stays in your Notion workspace.", envVars: ["NOTION_OAUTH_CLIENT_ID", "NOTION_OAUTH_CLIENT_SECRET"], keySourceIds: ["notion"] }),
  row({ id: "webflow", name: "Webflow", basis: "connected", purpose: "Sites and CMS.", dataShared: "The site content you publish.", location: "United States.", retention: "Stays in your Webflow account.", envVars: ["WEBFLOW_OAUTH_CLIENT_ID", "WEBFLOW_OAUTH_CLIENT_SECRET", "LIVE_WEBFLOW_TOKEN"], keySourceIds: ["webflow"] }),
  row({ id: "buffer", name: "Buffer", basis: "connected", purpose: "Social scheduling.", dataShared: "The posts you schedule.", location: "United States.", retention: "Stays in your Buffer account.", envVars: ["BUFFER_OAUTH_CLIENT_ID", "BUFFER_OAUTH_CLIENT_SECRET"], keySourceIds: ["buffer"] }),
  row({ id: "meta", name: "Meta (Facebook, Instagram, Ads)", basis: "connected", purpose: "Pages, Instagram and ad accounts.", dataShared: "Posts, creatives, budgets and metrics of the accounts you connect.", location: "United States (Meta Platforms).", retention: "Stays in your Meta accounts.", envVars: ["META_OAUTH_CLIENT_ID", "META_OAUTH_CLIENT_SECRET"], keySourceIds: ["meta"] }),
  row({ id: "amazon-ads", name: "Amazon Ads", basis: "connected", purpose: "Sponsored ads.", dataShared: "Campaigns, budgets and metrics of the ad account you connect.", location: "United States.", retention: "Stays in your Amazon Ads account.", envVars: ["AMAZON_ADS_CLIENT_ID", "AMAZON_ADS_CLIENT_SECRET"], keySourceIds: ["amazon-ads"] }),
  row({ id: "shopify", name: "Shopify", basis: "connected", purpose: "Store sync (or a single-store token you add yourself).", dataShared: "Products, orders and customers of the store you connect.", location: "Canada / United States (Shopify Inc.).", retention: "Stays in your Shopify store.", envVars: ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"], keySourceIds: ["shopify", "shopify-store"] }),
  row({ id: "quickbooks", name: "QuickBooks", basis: "connected", purpose: "Accounting export.", dataShared: "The invoices and ledger entries you export.", location: "United States (Intuit).", retention: "Stays in your QuickBooks company.", envVars: ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET"], keySourceIds: ["quickbooks"] }),
  row({ id: "xero", name: "Xero", basis: "connected", purpose: "Accounting export.", dataShared: "The invoices and ledger entries you export.", location: "Per your Xero organisation's region.", retention: "Stays in your Xero organisation.", envVars: ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET"], keySourceIds: ["xero"] }),
  row({ id: "gusto", name: "Gusto", basis: "connected", purpose: "Payroll.", dataShared: "The payroll and employee records you sync.", location: "United States.", retention: "Stays in your Gusto company.", envVars: ["GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET"], keySourceIds: ["gusto"] }),

  // ── Your own account, key or instance ──
  row({ id: "stripe-tenant", name: "Stripe (your payments) and POS terminal", basis: "customer_chosen", purpose: "Your customers pay you; ShapesOS never holds your Stripe key centrally.", dataShared: "Your customers' orders and payments, under your Stripe account.", location: "United States (Stripe, Inc.).", retention: "Your Stripe account's records.", envVars: [], keySourceIds: ["stripe-tenant"] }),
  row({ id: "stackadapt", name: "StackAdapt", basis: "customer_chosen", purpose: "Your programmatic ad spend.", dataShared: "Campaigns and budgets under your account.", location: "Canada / United States.", retention: "Your account's records.", envVars: [], keySourceIds: ["stackadapt"] }),
  row({ id: "mail-print", name: "Lob / PostGrid", basis: "customer_chosen", purpose: "Direct mail: your postage, your account.", dataShared: "Recipient names and postal addresses of the mail pieces you send.", location: "United States / Canada.", retention: "Your account's records.", envVars: [], keySourceIds: ["mail-print"] }),
  row({ id: "higgsfield", name: "Higgsfield", basis: "customer_chosen", purpose: "Your video generation account.", dataShared: "Prompts and source media for the videos you generate.", location: "Not verified in code.", retention: "Your account's records.", envVars: [], keySourceIds: ["higgsfield"] }),
  row({ id: "porkbun", name: "Porkbun", basis: "customer_chosen", purpose: "Your domain purchases.", dataShared: "Registrant details for the domains you buy.", location: "United States.", retention: "Your registrar account.", envVars: [], keySourceIds: ["porkbun"] }),
  row({ id: "hosting", name: "Hosting (Vercel, Cloudflare Pages, Netlify)", basis: "customer_chosen", purpose: "Deploys of the sites ShapesOS builds for you, to your hosting account.", dataShared: "The site files you deploy.", location: "Per your hosting provider.", retention: "Your hosting account.", envVars: ["LIVE_VERCEL_TOKEN", "LIVE_NETLIFY_TOKEN"], keySourceIds: ["hosting"] }),
  row({ id: "site-credentials", name: "WordPress / SFTP site credentials", basis: "customer_chosen", purpose: "Your own sites, with credentials you add (stored encrypted).", dataShared: "The site files and posts ShapesOS edits for you.", location: "Your own server.", retention: "Your site.", envVars: ["LIVE_WORDPRESS_APP_PASSWORD", "LIVE_WORDPRESS_URL"], keySourceIds: ["site-credentials"] }),
  row({ id: "supabase", name: "Supabase", basis: "customer_chosen", purpose: "Your database, connected in Settings → Connectors.", dataShared: "The tables you let agents read and write.", location: "Per your Supabase project's region.", retention: "Your project.", envVars: [], keySourceIds: ["supabase"] }),
  row({ id: "smartlead", name: "Smartlead", basis: "customer_chosen", purpose: "Cold outreach from your own sending domains (env keys are the self-hosted fallback only).", dataShared: "Prospect names and addresses, the sequences you send and replies.", location: "Not verified in code.", retention: "Your Smartlead account.", envVars: ["SMARTLEAD_API_KEY", "SMARTLEAD_WEBHOOK_SECRET"], keySourceIds: ["smartlead"] }),
  row({ id: "instantly", name: "Instantly", basis: "customer_chosen", purpose: "Cold outreach from your own sending domains (env keys are the self-hosted fallback only).", dataShared: "Prospect names and addresses, the sequences you send and replies.", location: "Not verified in code.", retention: "Your Instantly account.", envVars: ["INSTANTLY_API_KEY", "INSTANTLY_WEBHOOK_SECRET"], keySourceIds: ["instantly"] }),
  row({ id: "callrail", name: "CallRail", basis: "customer_chosen", purpose: "Call tracking with your own CallRail account (CALLS_PROVIDER=callrail).", dataShared: "Call events, caller numbers and recordings metadata.", location: "United States.", retention: "Your CallRail account.", envVars: ["CALLRAIL_API_KEY", "CALLRAIL_WEBHOOK_SECRET", "CALLRAIL_WEBHOOK_ACCEPT_SHARED_SECRET"], keySourceIds: [] }),
  row({ id: "vibe", name: "Vibe (CTV media buying)", basis: "customer_chosen", purpose: "Connected-TV ad buying with your own Vibe account (lib/flywheel/ctv/vibe.ts).", dataShared: "Campaigns, creatives and budgets under your account.", location: "United States.", retention: "Your Vibe account.", envVars: ["VIBE_CLIENT_ID", "VIBE_CLIENT_SECRET", "VIBE_API_TOKEN"], keySourceIds: [] }),
  row({ id: "alert-webhooks", name: "Alert channel webhooks (Slack, Telegram)", basis: "customer_chosen", purpose: "Alerts posted to channels you own.", dataShared: "The alert text.", location: "Your channel's provider.", retention: "Your channel.", envVars: [], keySourceIds: ["alert-webhooks"] }),
  row({ id: "custom-mcp", name: "Custom MCP servers", basis: "customer_chosen", purpose: "Tool servers you add in Settings → Connectors.", dataShared: "Whatever the tools you call send and return.", location: "Your server.", retention: "Your server.", envVars: [], keySourceIds: ["custom-mcp"] }),
  row({ id: "nango", name: "Nango (dataset builder OAuth runtime)", basis: "customer_chosen", purpose: "Managed OAuth and request proxying for Dataset Builder sources such as Google Drive (lib/datasetbuilder/nango.ts).", dataShared: "The OAuth tokens and the files fetched for a dataset.", location: "Per your Nango deployment.", retention: "Tokens until the connection is removed.", envVars: ["NANGO_SECRET_KEY"], keySourceIds: [] }),
  row({ id: "nemo", name: "NeMo Data Designer (extraction engine)", basis: "customer_chosen", purpose: "Synthetic augmentation and extraction engine for Dataset Builder, at an endpoint you run (lib/datasetbuilder/engines.ts).", dataShared: "The dataset rows being compiled.", location: "Your endpoint.", retention: "Your endpoint.", envVars: ["NEMO_DATA_DESIGNER_ENDPOINT"], keySourceIds: [] }),

  // ── Self-hosted sidecars: the host's instance, or on hosted the workspace's own ──
  row({ id: "postiz", name: "Postiz", basis: "customer_chosen", purpose: "Social scheduling sidecar.", dataShared: "The posts you schedule and the social tokens held by Postiz.", location: "Your instance.", retention: "Your instance.", envVars: ["POSTIZ_URL", "POSTIZ_API_KEY"], keySourceIds: ["postiz"] }),
  row({ id: "listmonk", name: "Listmonk", basis: "customer_chosen", purpose: "Newsletter lists and campaigns.", dataShared: "Subscriber addresses and campaign content.", location: "Your instance.", retention: "Your instance.", envVars: ["LISTMONK_URL", "LISTMONK_TOKEN"], keySourceIds: ["listmonk"] }),
  row({ id: "plane", name: "Plane", basis: "customer_chosen", purpose: "Project issues.", dataShared: "Issues and comments.", location: "Your instance.", retention: "Your instance.", envVars: ["PLANE_BASE_URL", "PLANE_API_KEY"], keySourceIds: ["plane"] }),
  row({ id: "ghost", name: "Ghost", basis: "customer_chosen", purpose: "Blog publishing.", dataShared: "The posts you publish.", location: "Your instance.", retention: "Your instance.", envVars: ["GHOST_URL", "GHOST_ADMIN_API_KEY"], keySourceIds: ["ghost"] }),
  row({ id: "documenso", name: "Documenso", basis: "customer_chosen", purpose: "E-signatures.", dataShared: "The documents sent for signature and the signers' names and emails.", location: "Your instance.", retention: "Your instance.", envVars: ["DOCUMENSO_URL", "DOCUMENSO_API_KEY", "DOCUMENSO_WEBHOOK_SECRET"], keySourceIds: ["documenso"] }),
  row({ id: "growthbook", name: "GrowthBook", basis: "customer_chosen", purpose: "Feature flags and experiments.", dataShared: "Flag evaluations and experiment assignments.", location: "Your instance.", retention: "Your instance.", envVars: ["GROWTHBOOK_API_HOST", "GROWTHBOOK_API_KEY"], keySourceIds: ["growthbook"] }),
  row({ id: "umami", name: "Umami", basis: "customer_chosen", purpose: "Cookieless analytics on shared design pages.", dataShared: "Page views on the pages you share (no cookies, no personal identifiers).", location: "Your instance.", retention: "Your instance.", envVars: ["UMAMI_URL", "UMAMI_API_KEY", "UMAMI_SCRIPT_URL"], keySourceIds: ["umami"] }),
  row({ id: "chatwoot", name: "Chatwoot", basis: "customer_chosen", purpose: "Live chat widget (off unless CHATWOOT_WIDGET_ENABLED=true).", dataShared: "Chat conversations with your visitors.", location: "Your instance.", retention: "Your instance.", envVars: ["CHATWOOT_BASE_URL", "CHATWOOT_WEBSITE_TOKEN"], keySourceIds: ["chatwoot"] }),
  row({ id: "penpot", name: "Penpot", basis: "customer_chosen", purpose: "Design file import/export sidecar.", dataShared: "The design files you exchange.", location: "Your instance.", retention: "Your instance.", envVars: ["PENPOT_BASE_URL", "PENPOT_ACCESS_TOKEN"], keySourceIds: [] }),
  row({ id: "activepieces", name: "Activepieces", basis: "customer_chosen", purpose: "Host-wide automation engine; a flow is usable only from the workspace a platform operator bound it to.", dataShared: "The inputs and outputs of the flows you run.", location: "The operator's instance.", retention: "The operator's instance.", envVars: ["ACTIVEPIECES_URL", "ACTIVEPIECES_API_KEY"], keySourceIds: [] }),
  row({ id: "dub", name: "Dub (short links)", basis: "customer_chosen", purpose: "Self-hosted short links, QR codes and personalised URLs.", dataShared: "The destination URLs and click counts.", location: "The operator's instance.", retention: "The operator's instance.", envVars: ["DUB_BASE_URL"], keySourceIds: [] }),
  row({ id: "voicestudio", name: "VoiceStudio (text to speech)", basis: "customer_chosen", purpose: "The default text-to-speech backend, run by the operator (lib/voice/voicestudio.ts).", dataShared: "The text to speak.", location: "The operator's instance.", retention: "The operator's instance.", envVars: ["VOICESTUDIO_URL"], keySourceIds: [] }),
];

/**
 * Key-source ids that are deliberately NOT a subprocessor row, with the reason.
 * (Empty today: every key source maps to a row.)
 */
export const UNLISTED_KEY_SOURCES: Readonly<Record<string, string>> = {};

/**
 * Env vars that match PROVIDER_ENV_PATTERN but are not a third party that
 * processes customer data: internal secrets, our own hosts, test-only knobs.
 * Each needs a reason, so the next person can disagree with it.
 */
export const NOT_SUBPROCESSOR_ENV: Readonly<Record<string, string>> = {
  // Internal signing and encryption secrets: never leave the server.
  ACTION_OAUTH_STATE_SECRET: "internal OAuth state signing secret; never sent to a third party",
  AUTHORITY_APPROVAL_SECRET: "internal approval-envelope signing secret",
  AUTH_SECRET: "Auth.js JWT signing secret; stays on the server",
  NEXTAUTH_SECRET: "legacy alias of AUTH_SECRET",
  CRON_SECRET: "internal cron bearer secret between our own services",
  REMINDERS_CRON_SECRET: "internal cron bearer secret between our own services",
  MARKETR_APPROVAL_SECRET: "internal approval receipt signing secret",
  MESSAGING_INBOUND_EMAIL_SECRET: "internal HMAC for reply addresses; verifies Resend's inbound webhook (Resend has its own row)",
  MESSAGING_UNSUBSCRIBE_SECRET: "internal HMAC for unsubscribe tokens",
  PAYLOAD_SECRET: "Payload CMS session secret; the CMS runs inside our own database",
  PIXEL_SIGNING_SECRET: "internal HMAC for attribution pixel URLs",
  SRA_SIGNING_SECRET: "internal HMAC for reallocation approval envelopes",
  FAKE_CALLRAIL_SECRET: "labelled fake provider for demos and tests; never a real vendor",
  FAKE_MAIL_SECRET: "labelled fake provider for demos and tests; never a real vendor",
  FAKE_MESSAGING_SECRET: "labelled fake provider for demos and tests; never a real vendor",
  FAKE_TELEPHONY_SECRET: "labelled fake provider for demos and tests; never a real vendor",
  VAPID_PUBLIC_KEY: "public half of the Web Push key pair (the private key is on the web-push row)",
  // Our own hosts and URLs (where ShapesOS itself runs), not vendors.
  APP_BASE_URL: "our own public URL",
  APP_PUBLIC_URL: "our own public URL",
  APP_URL: "our own public URL",
  AUTH_URL: "our own public URL",
  NEXTAUTH_URL: "our own public URL",
  NEXT_PUBLIC_APP_URL: "our own public URL",
  MARKETR_BASE_URL: "our own public URL",
  APP_HOST: "our own host name (host routing)",
  WEBSITE_HOST: "our own host name (host routing)",
  COLLAB_PUBLIC_URL: "our own collaboration server (scripts/collab.mts) on our own infrastructure",
  SANDBOX_PREVIEW_HOST: "our own Docker preview gateway host (self-host only)",
  DOCKER_HOST: "the local Docker Engine socket (self-host sandbox provider), not a vendor",
  CLAMAV_HOST: "our own ClamAV sidecar for upload scanning, run on our infrastructure",
  FLEET_CONTACT_URL: "the contact URL we put in OUR crawler's User-Agent (lib/intelligence/fleet/polite-fetch.ts)",
  LLM_SELF_HOST: "flag for a self-hosted OpenAI-compatible endpoint (vLLM/Ollama) run by the operator; the endpoint itself is LLM_BASE_URL on the OpenAI row",
  // Database and infrastructure credentials: covered by the Render row (hosted) or the host.
  DATABASE_URL: "our own database (Render row on hosted)",
  BACKUP_DATABASE_URL: "our own database (pg_dump mode on self-host)",
  LATENCY_APP_DATABASE_URL: "test harness only (scripts/latency)",
  SMOKE_APP_DATABASE_URL: "test harness only (scripts/smoke)",
  SHAPESOS_DB_HOST: "our own database host on Render (Render row)",
  SHAPESOS_DB_OWNER_PASSWORD: "our own database owner password (AWS migrate task)",
  APP_DB_PASSWORD: "our own database role password",
  POSTGRES_PASSWORD: "docker compose database password",
  ADMIN_PASSWORD: "the self-host admin sign-in password; never leaves the server",
  MINIO_ROOT_PASSWORD: "docker compose MinIO password (local object storage, not a vendor)",
  REDIS_URL: "nothing in the app reads it; no Redis on hosted",
  AWS_SECRET_ACCESS_KEY: "AWS deployment only (infra/aws); the hosted beta runs on Render. An AWS deployment must add an AWS row before launch",
  AWS_SESSION_TOKEN: "AWS deployment only (infra/aws); see AWS_SECRET_ACCESS_KEY",
  AWS_CONTAINER_AUTHORIZATION_TOKEN: "AWS Fargate task credentials only (infra/aws); see AWS_SECRET_ACCESS_KEY",
  SMTP_HOST: "the operator's own SMTP relay (self-host); hosted system mail goes through Resend (its row)",
  // Test-only knobs.
  E2E_ADMIN_PASSWORD: "end-to-end test fixture",
  E2E_BASE_URL: "end-to-end test fixture",
  LATENCY_BASE_URL: "latency harness fixture",
  // Customer-side SSO: the customer's own identity provider, under their contract.
  OIDC_CLIENT_ID: "the customer's own OIDC identity provider (Okta, Keycloak, Authentik); their contract, their data",
  OIDC_CLIENT_SECRET: "see OIDC_CLIENT_ID",
  BOXYHQ_SAML_CLIENT_ID: "the customer's own SAML identity provider through a self-hosted BoxyHQ Jackson bridge",
  BOXYHQ_SAML_CLIENT_SECRET: "see BOXYHQ_SAML_CLIENT_ID",
};

/**
 * Env var names that look like a provider credential or endpoint. A new one
 * in .env.example needs a subprocessor row or a NOT_SUBPROCESSOR_ENV reason.
 */
export const PROVIDER_ENV_PATTERN =
  /(API_KEY|API_SECRET|SECRET_KEY|CLIENT_ID|CLIENT_SECRET|DSN|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|_LOGIN|PRIVATE_KEY|API_URL|BASE_URL|ENDPOINT|_TOKEN|_SECRET|_HOST|_URL|_PASSWORD)$/;

/** Every key in .env.example (set or commented out). */
export function envExampleKeys(envExample: string): string[] {
  return [...new Set([...envExample.matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]))];
}

/** The provider-shaped subset of .env.example keys. */
export function envExampleProviderKeys(envExample: string): string[] {
  return envExampleKeys(envExample).filter((k) => PROVIDER_ENV_PATTERN.test(k));
}

export function subprocessorsByBasis(basis: SubprocessorBasis): Subprocessor[] {
  return SUBPROCESSORS.filter((s) => s.basis === basis);
}

/** The row(s) that name a key source, for the privacy page's provider lines. */
export function subprocessorsForKeySource(keySourceId: string): Subprocessor[] {
  return SUBPROCESSORS.filter((s) => s.keySourceIds.includes(keySourceId));
}

/** Every problem with the registry against the live key sources and .env.example, or []. */
export function subprocessorProblems(keySourceIds: readonly string[], envExample: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const coveredKeySources = new Set<string>();
  const coveredEnv = new Set<string>();
  const documented = new Set(envExampleKeys(envExample));
  for (const s of SUBPROCESSORS) {
    if (seen.has(s.id)) problems.push(`duplicate id ${s.id}`);
    seen.add(s.id);
    if (!(s.basis in SUBPROCESSOR_BASIS_LABEL)) problems.push(`${s.id}: unknown basis ${s.basis}`);
    for (const f of ["name", "purpose", "dataShared", "location", "retention"] as const) {
      if (!s[f].trim()) problems.push(`${s.id}: empty ${f}`);
    }
    for (const k of s.keySourceIds) {
      if (!keySourceIds.includes(k)) problems.push(`${s.id}: unknown key source ${k}`);
      coveredKeySources.add(k);
    }
    for (const v of s.envVars) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(v)) problems.push(`${s.id}: bad env var name ${v}`);
      else if (!documented.has(v)) problems.push(`${s.id}: env var ${v} is not documented in .env.example`);
      coveredEnv.add(v);
    }
  }
  for (const k of keySourceIds) {
    if (!coveredKeySources.has(k) && !UNLISTED_KEY_SOURCES[k]) {
      problems.push(`key source ${k} has no subprocessor row (keySourceIds) and no UNLISTED_KEY_SOURCES reason`);
    }
  }
  for (const v of envExampleProviderKeys(envExample)) {
    if (!coveredEnv.has(v) && !NOT_SUBPROCESSOR_ENV[v]) {
      problems.push(`${v} is a provider env var in .env.example with no subprocessor row and no NOT_SUBPROCESSOR_ENV reason`);
    }
  }
  for (const v of Object.keys(NOT_SUBPROCESSOR_ENV)) {
    if (coveredEnv.has(v)) problems.push(`${v} is both on a subprocessor row and in NOT_SUBPROCESSOR_ENV`);
  }
  return problems;
}
