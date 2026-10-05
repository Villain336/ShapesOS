# Keys: live, connect, bring your own, both, self-host

Which keys ShapesOS holds (and charges for in credits), which ones each
workspace connects or brings itself, and which tools must be the workspace's
own instance on hosted. **The table below is generated from the typed
registry in `lib/providers/key-sources.ts`** — the same registry Settings →
Providers renders — and a unit test fails if they differ. Edit the
registry, then run `npx tsx scripts/docs/generate-keys-md.mts`.

## The five sources

| Source | Meaning |
|---|---|
| **Platform** | ShapesOS's key. The customer doesn't sign up for anything; usage is metered in credits (1 credit = $0.01). |
| **Connect** | ShapesOS's OAuth app. Each workspace clicks Connect and authorises its own account. No usage cost to ShapesOS, no credits. |
| **Bring your own** | The customer's own money, account or sending reputation. ShapesOS must not pay for it or hold it centrally. |
| **Both** | Platform key by default (charged in credits), or the workspace adds its own key and uses **no credits** for that usage, on the same plan. |
| **Self-host or your own** | One shared instance isn't tenant-safe. Self-hosted deployments use the host's env instance; on `DEPLOYMENT_MODE=hosted` the env instance is **refused** unless the workspace connects its own (URL + key) in Settings → Providers. |

## How credits are charged

- **Model tokens** (`llm_tokens`): `ceil(provider cost USD × 100 × 1.5)` per call
  (`LLM_TOKEN_COST_MULTIPLIER` in `lib/metering/credits.ts`). A model without a
  price is charged at the most expensive known rate, never 0. A call on the
  workspace's own model key is recorded at 0 credits with the credits it saved
  (Settings → Usage shows "your own key saved N credits"). The cap is checked
  **before** each platform-key call; a capped workspace is refused and nothing
  is sent. Each call is debited once (idempotent per provider response id).
- **Intelligence vendors** (SERP, volume, backlinks): the vendor's USD cost × 4
  (`INTELLIGENCE_VENDOR_MULTIPLIER`); a workspace's own vendor key is 0.
- **Context.dev on the platform key**: 1 credit per Context.dev credit.
- **Images** 3 / 22 / 85 credits (low / medium / high); **sandboxes** 1 credit
  per started minute (E2B / Daytona); **Twilio** 6 credits per voice minute,
  20 per transcription minute, 460 per tracking number per month; **direct
  mail** at 2× the provider estimate (`HOSTED_MARGIN_MULTIPLIER`), and a send
  stops at the cap.
- **System mail** (invites, magic links, alerts) is free.
- **Agency** plans pool their credits: client workspaces joined to the agency
  workspace spend ONE pool, capped and alerted as one.

## Self-host notes

- On a self-hosted deployment every "Platform" and "Both" row is simply the
  operator's own key in the environment; nothing changes for self-hosting.
- The env keys for Smartlead / Instantly are a **self-hosted fallback only**;
  on hosted, each workspace connects its own account.
- Webhook signing secrets for workspace-owned tools (Documenso, Smartlead,
  Instantly) remain host settings (`DOCUMENSO_WEBHOOK_SECRET`,
  `SMARTLEAD_WEBHOOK_SECRET`, `INSTANTLY_WEBHOOK_SECRET`).

## Every provider

<!-- BEGIN keys-table (generated: npx tsx scripts/docs/generate-keys-md.mts) -->
| Provider | Source | Env vars (platform / self-host) | Bring your own | Notes |
|---|---|---|---|---|
| Anthropic models (Claude) | Both | `ANTHROPIC_API_KEY` | Settings → Providers | Agents, chat and writing. Platform calls are charged at 1.5× token cost; a workspace key uses no AI credits. |
| OpenAI models (GPT) | Both | `OPENAI_API_KEY`, `LLM_API_KEY` | Settings → Providers | Text workloads and failover. Platform calls are charged at 1.5× token cost; a workspace key uses no AI credits. |
| DataForSEO | Both | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | Intelligence → Data costs | Keyword, SERP and backlink data; a workspace's own vendor login is charged 0 credits. |
| Serper | Both | `SERPER_API_KEY` | Intelligence → Data costs | SERP data for intelligence; a workspace's own key is charged 0 credits. |
| Context.dev | Both | `CONTEXTDEV_API_KEY` | Intelligence → Knowledge | Web research, crawling and brand sync. The platform key is charged 1 credit per Context.dev credit; a workspace key is free. |
| Resend (newsletter) | Both | `RESEND_API_KEY` | Project → Newsletter | Newsletter sends on the platform domain, or the workspace's own Resend key. |
| OpenAI images, transcription and extraction | Platform | `OPENAI_API_KEY`, `LLM_IMAGE_MODEL` | — | Image generation (3 / 22 / 85 credits by quality), transcription and extraction on the platform key. |
| Moz / OpenPageRank | Platform | `MOZ_ACCESS_ID`, `MOZ_SECRET_KEY`, `OPENPAGERANK_API_KEY` | — | Domain authority data. |
| Yelp | Platform | `YELP_API_KEY` | — | Local listings and reviews. |
| NewsAPI | Platform | `M3_LICENSED_NEWS_PROVIDER`, `M3_NEWSAPI_KEY` | — | News mentions for AI visibility. |
| PageSpeed Insights | Platform | `PAGESPEED_API_KEY` | — | Core Web Vitals in site audits. |
| Apollo / Hunter | Platform | `APOLLO_API_KEY`, `HUNTER_API_KEY` | — | Prospect enrichment (2 credits per lookup). |
| Brandfetch, Cloudinary, Pexels, Pixabay, Unsplash | Platform | `BRANDFETCH_API_KEY`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `UNSPLASH_ACCESS_KEY` | — | Brand assets and stock media. |
| Composio | Platform | `COMPOSIO_API_KEY` | — | Hosted app actions (1 credit per tool call). |
| Zernio (ads on 7 networks, social on 16 platforms) | Platform | `ZERNIO_API_KEY`, `ZERNIO_BASE_URL` | — | One profile per workspace; 2 accounts included (plans include 3 / 10 / 25 / 50), then 600 credits per account a month. Creating ads and raising budgets always ask. |
| Twilio SMS and voice | Platform | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | — | SMS (4 credits a segment), voice minutes, tracking numbers and transcription. |
| Resend / SMTP system mail | Platform | `SMTP_HOST`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASS`, `INVITE_MAIL_FROM` | — | Invites, magic links and alerts. System mail is free. |
| E2B sandboxes | Platform | `E2B_API_KEY`, `SANDBOX_PROVIDER` | — | Agent code sandboxes (1 credit per started minute). |
| GitHub App | Platform | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | — | Repos, branches and pull requests. |
| Expo | Platform | `EXPO_ACCESS_TOKEN` | — | Mobile app builds. |
| LiveKit | Platform | `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL` | — | Realtime voice and video. |
| ShapesOS Stripe billing | Platform | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | — | Plans, seats, top-ups and overage. |
| Google (Analytics, Search Console, Business Profile, Ads, Drive, Gmail, Calendar) | Connect | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN` | — | One Google app; the Ads developer token is the platform's. |
| Microsoft (Outlook mail and calendar) | Connect | `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET` | — | Mail and calendar. |
| Slack | Connect | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | — | Notifications and approvals. |
| HubSpot | Connect | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | — | CRM sync. |
| Linear | Connect | `LINEAR_OAUTH_CLIENT_ID`, `LINEAR_OAUTH_CLIENT_SECRET` | — | Issues. |
| Atlassian (Jira) | Connect | `ATLASSIAN_OAUTH_CLIENT_ID`, `ATLASSIAN_OAUTH_CLIENT_SECRET` | — | Issues. |
| Airtable | Connect | `AIRTABLE_OAUTH_CLIENT_ID`, `AIRTABLE_OAUTH_CLIENT_SECRET` | — | Bases. |
| Notion | Connect | `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET` | — | Pages and databases. |
| Webflow | Connect | `WEBFLOW_OAUTH_CLIENT_ID`, `WEBFLOW_OAUTH_CLIENT_SECRET` | — | Sites and CMS. |
| Buffer | Connect | `BUFFER_OAUTH_CLIENT_ID`, `BUFFER_OAUTH_CLIENT_SECRET` | — | Social scheduling. |
| Meta (Facebook, Instagram, Ads) | Connect | `META_OAUTH_CLIENT_ID`, `META_OAUTH_CLIENT_SECRET` | — | Pages, Instagram and ad accounts. |
| Amazon Ads | Connect | `AMAZON_ADS_CLIENT_ID`, `AMAZON_ADS_CLIENT_SECRET` | — | Sponsored ads. |
| Shopify | Connect | `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | — | Store sync (or a single-store token, below). |
| QuickBooks | Connect | `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET` | — | Accounting export. |
| Xero | Connect | `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | — | Accounting export. |
| Gusto | Connect | `GUSTO_CLIENT_ID`, `GUSTO_CLIENT_SECRET` | — | Payroll. |
| Stripe (your payments) and POS terminal | Bring your own | — | Ops → Accounting → Settings | Your customers pay you; ShapesOS never holds your Stripe key centrally. |
| StackAdapt | Bring your own | — | Media → Advertising | Your ad spend. |
| Lob / PostGrid | Bring your own | — | Settings → Mail | Your postage. |
| Higgsfield | Bring your own | — | Project → Ads | Your video generation account. |
| Porkbun | Bring your own | — | Project → Studio | Your domain purchases. |
| Hosting (Vercel, Cloudflare Pages, Netlify) | Bring your own | — | Project → Sites → Hosting | Your hosting accounts. |
| WordPress / SFTP site credentials | Bring your own | — | Project → Sites | Your sites. |
| Supabase | Bring your own | — | Settings → Connectors | Your database. |
| Smartlead | Bring your own | `SMARTLEAD_API_KEY`, `SMARTLEAD_RELAY_CAMPAIGN_IDS` | Settings → Providers | Your sending domains and reputation. Env keys are the self-hosted fallback only. |
| Instantly | Bring your own | `INSTANTLY_API_KEY`, `INSTANTLY_RELAY_CAMPAIGN_IDS` | Settings → Providers | Your sending domains and reputation. Env keys are the self-hosted fallback only. |
| Alert channel webhooks (Slack, Telegram) | Bring your own | — | Settings → Alerts | Your channels. |
| Custom MCP servers | Bring your own | — | Settings → Connectors | Your servers. |
| Shopify single-store token | Bring your own | — | Settings → Connectors → Shopify | Your store's own app token. |
| Postiz | Self-host or your own | `POSTIZ_URL`, `POSTIZ_API_KEY` | Settings → Providers | Social scheduling sidecar. |
| Listmonk | Self-host or your own | `LISTMONK_URL`, `LISTMONK_USER`, `LISTMONK_TOKEN` | Settings → Providers | Newsletter lists and campaigns. |
| Plane | Self-host or your own | `PLANE_BASE_URL`, `PLANE_API_KEY`, `PLANE_WORKSPACE_SLUG` | Settings → Providers | Project issues. |
| Ghost | Self-host or your own | `GHOST_URL`, `GHOST_ADMIN_API_KEY` | Settings → Providers | Blog publishing. |
| Documenso | Self-host or your own | `DOCUMENSO_URL`, `DOCUMENSO_API_KEY` | Settings → Providers | E-signatures. |
| GrowthBook | Self-host or your own | `GROWTHBOOK_API_HOST`, `GROWTHBOOK_API_KEY`, `GROWTHBOOK_CLIENT_KEY` | Settings → Providers | Feature flags and experiments. |
| Umami | Self-host or your own | `UMAMI_URL`, `UMAMI_API_KEY`, `UMAMI_WEBSITE_ID`, `UMAMI_SCRIPT_URL` | Settings → Providers | Cookieless analytics. |
| Chatwoot | Self-host or your own | `CHATWOOT_BASE_URL`, `CHATWOOT_WEBSITE_TOKEN`, `CHATWOOT_WIDGET_ENABLED` | Settings → Providers | Live chat widget. |
<!-- END keys-table -->
