# Marketr — Spec v0.1 (APPROVED 2026-09-21)

> Status: DRAFT for Tico's approval. Nothing is built. Vault-private.
> Date: 2026-09-21

## 1. Problem

A solo founder or small agency doing SEO today pays for a sprawl of tools that don't talk to each other: Ahrefs or Semrush ($129–$250/mo) for research, a rank tracker, Surfer/Frase for content optimization, Buffer for social, and AgencyAnalytics ($59+/mo) or SE Ranking (+$69/mo white-label add-on) just to send clients a branded report. Total stack: $300–$500/mo, five logins, copy-paste between tools. Freelancers with 3–4 small clients watch the subscription eat a client's entire fee. Nobody owns the unified, self-serve marketing workspace — and nobody has made it open-source.

## 2. Target user

**Persona A — Dana, the solo founder / content marketer (self-serve).** Runs a content-led site or small brand. Today: Ahrefs Lite or Ubersuggest + Google Docs + WordPress. Pain: $129/mo is steep, tools don't connect research → content → tracking. Switches for: one workspace at $29/mo that takes her from keyword to published article to rank movement without leaving.

**Persona B — Marcus, the agency owner / freelancer (white-label).** 5–20 retainer clients. Today: Semrush + AgencyAnalytics for white-label reports ($200+/mo combined). Pain: reporting tools don't *do* SEO, SEO tools don't white-label well. Switches for: a platform where client work actually happens (research, content, tracking) under his own brand, custom domain, client logins, scheduled branded reports — at $199/mo instead of $400+.

## 3. The idea

Marketr is the open-source marketing & SEO workspace: keyword research, competitor gap analysis, an AI content engine, rank tracking, site audits, and white-label client reporting in one self-serve OS. Self-host it free with your own API keys, or pay for hosted with data included.

The sentence: **"The open-source workspace that replaces your $400/mo SEO stack — and lets agencies resell it under their own brand."**

## 4. Why now

- **AI Overviews changed what SEO tools must track.** ~50% of queries now show generative blocks; incumbents bolted on AI-visibility tracking, and a dedicated layer is still up for grabs. Rank tracking must now include AIO presence — DataForSEO parses it at $0.0026/keyword.
- **SEO data got commoditized.** DataForSEO's pay-as-you-go API (SERP from $0.60/1K, keyword volume $0.09/1K keywords, Labs research $0.012/task) means a newcomer no longer needs Ahrefs' crawl infrastructure to offer 90% of the value.
- **Demand is proven, lane is half-open.** Open-source "Ahrefs killers" (every-app/open-seo, several all-in-one forks) are gaining traction on GitHub — but they're all *cheaper Ahrefs*, not a marketing OS, and none lead with white-label agency resale.
- **Distribution advantage:** Tico runs a marketing company. Customer zero, case-study pipeline, and a bundling path with his unlimited-requests offer exist on day one. Open-seo has stars; Marketr ships with revenue.

## 5. Core user flows

**Flow 1 — Keyword research (self-serve wedge).**
1. User creates a Project, enters their domain.
2. User enters a seed keyword → Marketr calls DataForSEO Labs, returns clustered keyword ideas with volume, difficulty, intent, CPC.
3. User filters (e.g. difficulty < 30, intent = informational), saves winners to a Keyword List.
4. One click sends a keyword to the Content Engine.

**Flow 2 — Competitor gap analysis.**
1. User enters a competitor domain.
2. Marketr pulls the competitor's ranking keywords (Labs) and diffs against the user's tracked/ranking keywords.
3. Output: "keywords they rank for that you don't," sortable by volume × difficulty, with one-click add to Keyword List or Content Engine.

**Flow 3 — Content engine (brief → draft → publish).**
1. From a keyword, user clicks "Create brief" → Marketr fetches top-10 SERP, extracts headings/entities/questions, generates an outline brief with target word count and semantic terms.
2. User approves/edits outline → "Draft" generates a full article via the configured LLM.
3. User edits in the built-in editor (SEO score live: coverage of terms, readability, length vs. SERP average).
4. Export to Markdown or publish directly to WordPress via API. Article links back to its keyword; rank tracking picks it up automatically.

**Flow 4 — Rank tracking.**
1. Keywords added to tracking (manually or from lists) are checked on schedule (daily/weekly, Standard queue).
2. Dashboard shows visibility score, winners/losers, and AI Overview presence per keyword.
3. Alerts on significant movement (Slack/email).

**Flow 5 — White-label client onboarding (agency).**
1. Agency user creates a Client workspace: client name, logo, custom subdomain (seo.clientdomain.com or client.agency.com).
2. Agency invites the client as a viewer (client login sees only branded dashboard + reports — no Marketr branding).
3. Agency schedules a monthly branded PDF report (rank movement, content shipped, audit fixes) auto-emailed to the client.

**Flow 6 — Self-host.**
1. `git clone && docker compose up` → web UI at localhost.
2. Settings → paste DataForSEO key + LLM key (or use free GSC/GA4 connectors only).
3. Same product, zero subscription, data billed pay-as-you-go to their own keys.

## 6. Data model

- **Workspace** — id, name, owner_user_id, plan (self_hosted / starter / pro / agency), white_label_config (logo_url, custom_domain, brand_color)
- **Project** — id, workspace_id, domain, locale, search_engine
- **Keyword** — id, project_id, phrase, volume, difficulty, cpc, intent, list (saved list name)
- **Ranking** — id, keyword_id, checked_at, position, url, ai_overview_present, serp_features[]
- **Competitor** — id, project_id, domain, added_at
- **ContentItem** — id, project_id, keyword_id, status (brief/draft/editing/published), outline_json, body_markdown, seo_score, published_url
- **Client** (agency) — id, workspace_id, name, login_email, viewer_role, report_schedule
- **Report** — id, client_id, period, pdf_url, sent_at
- **ApiUsage** — id, workspace_id, meter (tracked_keywords / ai_words / serp_calls), quantity, period — the billing meter
- **Issue** — id, project_id, type, severity, url, detail_json, status (open / queued / fixed / ignored), detected_at
- **FixRun** — id, project_id, mode (manual / scheduled / autopilot), started_at, fixes_applied, snapshot_ref (rollback), status, report_summary

## 7. MVP scope

1. Project setup: add domain, connect GSC + GA4 (free data in).
2. Site audit: first-party crawler, prioritized issue list with fix guidance.
3. Keyword research: seed → clustered ideas w/ volume, difficulty, intent (DataForSEO Labs).
4. Competitor gap: domain-in → keywords-they-have-you-don't, difficulty filter.
5. Rank tracking: daily/weekly checks, visibility dashboard, AIO presence flag, movement alerts.
6. Content engine: SERP-informed brief → outline approval → AI draft → editor with live SEO score → Markdown/WordPress export.
7. White-label: logo + custom subdomain + client viewer logins + scheduled branded PDF reports.
8. Self-host: one-command Docker Compose, BYO DataForSEO + LLM keys.
9. MCP server + agent skills: agents (Claude Code etc.) can run keyword research, audits, and briefs through Marketr.
10. Billing meters: tracked keywords, AI words generated, client seats.
11. AI search visibility tracking: weekly brand-mention checks across ChatGPT, Perplexity, Gemini, and Google AI Overviews; alerts when a competitor gets cited and you don't.
12. Content decay & refresh engine: watches published content for ranking/traffic decay, flags slipping pages, one-click generates a refresh brief.
13. Competitor movement radar: weekly digest of competitor publishing velocity, keyword gains, and new SERP entries.
14. Visibility score: a single 0–100 number combining rankings, AI visibility, and content health, tracked over time.
15. Fix agent (WordPress-first): audit issues flow into an agent queue with three modes — approve-each-fix, scheduled run (e.g. Sundays 2am), autopilot for safe-tier fixes. Safe tier: meta descriptions, title tags, alt text, OG tags, sitemap.xml, robots.txt, schema markup. Guardrails: pre-change snapshot, dry-run preview, one-click rollback, and a fix → re-audit verification loop that confirms each fix worked. Every run produces a "fixed X while you slept" report.

## 8. Non-goals (explicit)

- **Building our own backlink index.** Too capital-intensive; use DataForSEO Backlinks API on demand instead. (Why: index-building is Ahrefs' moat and a money pit; on-demand covers 90% of use.)
- **PPC / social scheduling / email marketing.** The "OS" expands later; MVP is the SEO wedge only. (Why: scope discipline — every all-in-one that launches with everything is mediocre at all of it.)
- **Link outreach automation.** Spam-adjacent, deliverability risk, low differentiation.
- **Local citation management.** Crowded (BrightLocal, Whitespark); revisit post-MVP.
- **Scraping-based free data tier.** Fragile and legally gray; free tier = GSC/GA4 connectors only.

## 9. Monetization

**Model:** open core (repo = distribution asset) + hosted SaaS (the business) + white-label agency tier (the high-ticket wedge). Two meters: tracked keywords and AI words generated; third lever: client seats.

| Tier | Price | What |
|---|---|---|
| Self-hosted | Free (BYO keys) | Full core, Docker, community support |
| Hosted Starter | $29/mo | 1 project, 250 tracked keywords, 20 AI articles/mo |
| Hosted Pro | $79/mo | 5 projects, 2,000 tracked keywords, 100 AI articles/mo |
| Agency White-label | $199/mo | 20 client workspaces, custom domain/logo, client logins, scheduled branded reports |

**Rationale:** undercuts Ahrefs Lite ($129/mo, 500 kw) and Semrush Pro ($140/mo) by 4–5x at entry while replacing AgencyAnalytics ($59+) + SE Ranking white-label (+$69) for agencies at a single $199 price. Unit economics (DataForSEO 2026 rates): 500 keywords tracked weekly ≈ **$1.30/mo** in SERP costs; a keyword-research session ≈ **$0.25**; an AI article ≈ **$0.05–0.30** in LLM cost. A heavy $79/mo Pro user costs roughly **$3–8/mo** to serve → ~90% gross margin. White-label has a natural expansion loop: agencies add clients, clients see the product, some become direct users.

**License:** AGPLv3 for the core (prevents a cloud provider from hosting it as a competing SaaS without contributing back — the n8n playbook), commercial license for the white-label module. *(decided 2026-09-21 — Tico approved)*

**Fix agent tiering:** approval-queue + scheduled modes included in Pro and Agency; autopilot mode is Agency-tier only, and users graduate to it through a trust ladder (N successful supervised runs before autopilot unlocks).

## 10. Differentiation & moat

1. **It's a workspace, not a toolkit.** open-seo and the forks are "cheaper Ahrefs." Marketr connects research → brief → draft → publish → rank movement in one loop. Nobody owns the loop.
2. **White-label is native, not an add-on.** Incumbents charge extra and bolt it on; agencies are the best distribution channel in this market (every client login is a demo).
3. **Agent-native from day one.** MCP server + skills so coding agents run SEO workflows inside Marketr — matches open-seo's smartest move and extends it to content.
4. **Founder-market fit as distribution.** Tico's agency is customer zero, the case-study factory, and a bundling surface for his unlimited-requests offer.
5. **Closes the loop competitors leave open.** Every SEO tool tells you what's broken; Marketr fixes it, verifies the fix with a re-audit, and reports "fixed 14 issues while you slept." The fix → verify → report cycle is a retention engine disguised as a feature.

**Directions considered and set aside:** (a) pure "open Ahrefs clone" — contested by open-seo et al., no wedge; (b) broad marketing OS incl. social/email/PPC at launch — scope death; (c) boilerplate/template play — no moat, per Blazity analysis (their repo is a 3-year, 7.3k-star agency lead magnet, not a business).

## 11. Tech approach

Next.js (App Router) + Postgres + a job queue for scheduled rank tracking; Docker Compose for self-host. DataForSEO behind an abstracted data-provider interface (single-supplier risk — the interface lets us add Serper/Bright Data later). LLM via provider abstraction (Anthropic/OpenAI/BYO). Auth: Auth.js; billing: Stripe metered billing on the three meters. WordPress publish via REST API. MCP server as a first-class interface alongside the REST API.

Dependencies: DataForSEO API key (hosted), LLM provider, Postgres, Redis (queue), Stripe, S3-compatible storage (report PDFs).

## 12. Success metrics

- **30 days:** repo public + PH launch; 1,500 GitHub stars; Product Hunt top-5 of the day; 10 agency design partners (Tico's network first); hosted waitlist 500.
- **90 days:** 5,000 stars; $10k MRR hosted (roughly: 100 Starter + 50 Pro + 15 Agency); 3 paying white-label agencies outside Tico's network; net revenue retention signal from keyword-meter expansion.

## 14. Phase 2 (post-launch)

- Content autopilot: scheduled agent drafting from the keyword list (grows the AI-words meter — the loop and the revenue are the same motion).
- Internal linking engine: site-wide internal link suggestions as new content publishes.
- Programmatic SEO builder: templates × keyword datasets → hundreds of pages at once (also powers Tico's directory portfolio — the portfolio becomes the case study).
- Backlink change monitoring: new/lost link alerts, gated to Pro+ with caps (COGS risk at $0.024/result returned).
- Template marketplace: shareable keyword strategies, brief templates, audit presets (community moat — every shared template makes the product harder to leave).

## 15. Risks & open questions

- **DataForSEO single-supplier dependency** — decided: abstract the data layer, add a second provider by month 6. *(decided)*
- **open-seo's head start in "open SEO" mindshare** — decided: we don't fight on "open Semrush," we win on workspace-loop + white-label + his distribution. *(decided)*
- **Google SERP volatility** (num=100 removal already raised tracking costs industry-wide; AIO parsing is a moving target) — needs monitoring, not a blocker. *(needs research — ongoing)*
- **PH spike without retention** — mitigated by wedge design: rank tracking is inherently recurring (users come back to see movement). *(decided)*
- **License choice** — AGPLv3 core + commercial white-label. *(decided 2026-09-21)*
- **Product name** — Marketr. *(decided 2026-09-21)*
- **Build order** — in-house beta with Tico's agency first, then public repo + Product Hunt with real numbers. *(decided 2026-09-21)*
- **Content engine quality bar** — AI content is table stakes; the differentiator is the SERP-informed brief + live score, not the prose itself. *(decided)*
- **Auto-fix trust** — one bad automated change to a live site destroys trust permanently. Mitigated by the trust ladder (approve-each → scheduled → autopilot), safe-tier gating, pre-change snapshots, and one-click rollback. WordPress-first via REST API; other CMSs later. *(decided)*
