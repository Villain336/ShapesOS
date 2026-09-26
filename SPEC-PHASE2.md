# Marketr — Phase 2 Spec: from SEO workspace to marketing OS

**Status:** APPROVED by Tico on 2026-09-21. Milestone order confirmed; build proceeds M12 → M22 in order.
One approved change: **Canva Connect is the default studio in M22**; building an open-source
alternative is a later aspiration, not the current M22 default (already reflected below).
This extends `SPEC.md` (M1–M11, all complete).
**Origin:** Tico's 2026-09-21 feature directive (17 items).
**Research:** three parallel verification streams completed 2026-09-21 (ledger: marketr-research-docs,
marketr-research-growth, marketr-research-seo). Key corrections baked in below.

## Research corrections (read first)

1. **pdfcn EXISTS** — shadcn-labs, MIT, shadcn-registry install (`@pdfcn`), two renderer bases
   (Takumi or Forme — pick ONE per project). Verified: github.com/shadcn-labs/pdfcn, pdfcn.dev.
2. **shadcn email library EXISTS** — `emailcn` (same shadcn-labs family), blocks on react-email /
   MJML / jsx-email bases. Verified: github.com/shadcn-labs/emailcn, emailcn.run.
3. **BONUS: editorcn EXISTS** — shadcn-labs Tiptap v3 block + toolbar editors. This is the answer to
   "make everything editable": **Tiptap JSON is the single source of truth** — edit in dashboard,
   serialize server-side, render to PDF via pdfcn or email via emailcn, themed by brand kit.
4. **Higgsfield open-source repo does NOT exist** as Tico means it. `github.com/higgsfield-ai/higgsfield`
   is an old GPU-orchestration project, unrelated to AI video/image. The creative company only ships
   API + SDKs. → Ad factory uses the **Higgsfield API** via the existing workspace skills. No repo.
5. **Polotno is NOT free for commercial use.** Open repo, but production requires a paid license
   (comparisons cite ~$199–399/mo tiers — re-verify at purchase). Budget flag against the umbrella cap.
   Canva Connect API exists as an optional connector (OAuth, review-gated for public integrations).
6. **Domain purchasing: Porkbun** — JSON API, no access gating, free public price feed. GoDaddy
   (50-domain gate) and Namecheap ($50/20-domain gate) are out; Cloudflare Registrar API is
   enterprise-gated. Note: in-app purchasing adds ICANN registrant-verification compliance surface.
7. **Backlinks: DataForSEO Backlinks API** — ~$0.06 per 1,000 rows, 2.8T-link index, pay-as-you-go.
   Ahrefs API is enterprise-gated (~$1,499/mo). Cap unbounded pulls in UI with cost estimates.
8. **Local SEO:** 4 API-feasible features — geo-grid rank tracking (buildable NOW via DataForSEO Maps
   SERP, ~$0.50/week/client for a 5×5 grid × 5 keywords), competitor GBP/review intel (no Google
   approval needed), review monitoring + alerts (now), GBP dashboard/posts (AFTER Google approval —
   **file the GBP API application immediately; backlog has no ETA as of Sept 2026**).
9. **Social scheduling: integrate Buffer** as a publisher connector (days of work; Buffer absorbs all
   platform app-review pain). Direct platform APIs = months of per-platform review across agency
   clients; X write access alone is ~$200/mo direct. Marketr owns calendar + AI drafting + approvals.
10. **Newsletter: self-built on react-email + Resend Broadcasts**, BYO-key model (same as DataForSEO/
    LLM keys). Real work is per-client sender-domain verification (SPF/DKIM/DMARC), not the send API.
11. **WhatsApp alerts** need WhatsApp Business API approval + message templates (via Twilio) — phase it
    after Slack/Telegram/email. Telegram (bot API) and Slack (webhooks) are frictionless.

## Architecture additions

- **BrandKit model** (new, M12): per-client logo, colors, fonts, tone. Consumed by pdfcn reports,
  emailcn emails, ad factory prompts, and Polotno templates. White-labeling = "which brand kit +
  which template", zero per-client code.
- **Template pipeline** (M12): every report/email/content template stored as **Tiptap JSON + brand
  token set** in Postgres → edited with editorcn block editor → rendered server-side
  (`generateHTML`) → pdfcn (PDF buffer) or emailcn + `render()` (email HTML).
- **Alerting hub** (M13): event bus → channel adapters (Slack webhook, Telegram bot, email, WhatsApp
  phased). Reuses emailcn for email bodies.
- **Provider cost guards**: cost-estimate UI before unbounded DataForSEO pulls (backlinks, large
  grids, review polling); per-workspace spend caps; all metered like existing usage meters.
- **Audit coverage**: report generation, alert dispatches, autopilot runs, domain purchases,
  social publishes, newsletter sends — all audit-logged (M11 pattern).

## Milestones

### Wave 1 — Sellable + sticky (build first)

**M12 — Brand kits + white-label reporting**
BrandKit CRUD (logo upload, colors, fonts, tone, client mapping). Report templates as editable
Tiptap JSON (editorcn block editor). pdfcn renderer (pick Takumi OR Forme once, behind a small
adapter). Scheduled + on-demand branded client reports: rankings, visibility, AI Overview presence,
fix-agent activity, backlink summaries (once M15 lands). PDF stored/streamed, audit-logged.
Done = generate a Launchabl-branded PDF from a template edited in the dashboard.

**M13 — Alerting hub**
Slack (incoming webhooks), Telegram (bot API), email (emailcn + Resend/SMTP) now; WhatsApp
(Twilio, template-approved) phased. Events: ranking drops/spikes, AI Overview appearances, new
backlinks lost/found (M15), review alerts (M16), fix-agent completions, report ready. Per-project
subscriptions, quiet hours, severity routing. Done = drop a keyword 10 spots, alert lands in Slack
+ email within the cron window.

**M14 — Retention loops** (previously decided, now spec'd)
AI search visibility tracking (ChatGPT/Perplexity/Gemini answer presence for tracked keywords),
content decay & refresh engine ("these N pages are decaying → approve refresh draft"), competitor
radar (competitor content/ranking movement digests), composite visibility score per project.
Done = dashboard shows visibility score trend + a decay list with one-click refresh drafts.

### Wave 2 — SEO depth

**M15 — Link intelligence**
DataForSEO Backlinks API: backlink explorer, referring domains, anchors, lost/found, spam scores;
competitor link gap; cost-estimate UI before large pulls. Internal linking suggestions computed from
site crawls (orphan pages, anchor-text opportunities, click-depth) surfaced in the fix-agent inbox
and content editor. Done = backlink profile + 10 internal-link suggestions for a connected site.

**M16 — Local SEO**
Geo-grid rank tracking (DataForSEO Maps SERP → map-pack visibility grid, report-ready visuals);
competitor GBP + review intel (no Google approval needed); review monitoring with AI sentiment
summaries feeding the M13 alert hub. GBP API application filed at milestone start; GBP performance
dashboard + Google Posts scheduling land when approval arrives. Done = 5×5 geo-grid for a Launchabl
client keyword rendering in a branded report.

### Wave 3 — Scale

**M17 — pSEO builder** (programmatic SEO)
Template (editorcn) + dataset (CSV/upload/API) → N programmatic pages → deploy via existing
connectors (WP/Webflow/hosting). Built-in guardrails: uniqueness checks, internal-link wiring
(M15), sitemap inclusion, noindex-until-approved. This productizes the senior-care directory
playbook. Done = 20-page programmatic set generated, reviewed, and deployed from a template.

**M18 — Content autopilot**
Scheduled pipeline: keyword/brief → draft → (approval gate) → publish to WP/Webflow/hosting.
Per-workspace autopilot scope, approval policies (auto/approve-all/approve-per-item), full audit
trail, pause/kill switch. Trust ladder continues: supervised (M4) → scheduled (this) → full
autopilot (later, explicit opt-in). Done = week-long autopilot run with approvals on mock targets.

### Wave 4 — Marketing OS

**M19 — Newsletter builder**
emailcn templates (editable via editorcn) + brand kits → Resend Broadcasts; BYO Resend key;
per-client sender-domain verification wizard (SPF/DKIM/DMARC); subscriber lists (CSV import);
scheduled sends; open/click tracking. Done = themed newsletter composed, scheduled, and sent.

**M20 — Social scheduling**
Buffer as publisher connector (OAuth, per-workspace); content calendar UI; AI draft from
brief/content item (brand voice from brand kit); approval workflow; scheduled publish via Buffer
(FB, IG, LinkedIn, Threads, TikTok, X, YouTube, Bluesky, GBP). Analytics pull-back where Buffer
provides it. Done = week of posts drafted, approved, and published through Buffer.

**M21 — Ad factory (Higgsfield API)**
Brief/brand kit → Higgsfield API (image + video) creative generation; variant matrix (hooks,
formats, sizes per placement); human review + regenerate loop; export to studio (M22) and social
(M20) queues. Cost metering per generation; uses existing higgsfield workspace skills, no repo.
Done = 6 ad variants (3 hooks × 2 formats) generated from one brief.

**M22 — Marketing studio + domains**
Canva Connect API as the **default studio** (OAuth; programmatic design creation, asset sync, brand
templates, export; note: public integrations require Canva review, brand-template autofill is
Enterprise-oriented). Polotno deprioritized — no commercial license spend. **Future goal: build our
own open-source Canva alternative** (tracked as a later milestone, not this wave; Tico 2026-09-26:
named as a Polotno — polotno.com, MIT open-source core — reference implementation that **replaces
the Canva Connect integration**; Phase 12 candidate per SPEC-PHASE10.md §11). Porkbun
integration: availability check + purchase without leaving Marketr (registrant flow + ICANN
verification handled in UI). Done = Canva-connected workspace creating/exporting an on-brand design;
test domain checked (real purchase only on Tico's approval).

## Sequencing rationale

Brand kits (M12) first because reports, emails, ads, and studio output all consume them. Alerts
(M13) and retention loops (M14) next: cheap, high agency value, and the actual moat. SEO depth
(M15–M16) before scale (M17–M18) because link/local data feeds pSEO and autopilot quality. Creative
(M21–M22) last: highest cost, most external dependencies (Polotno license, Higgsfield spend).

## Risks and trade-offs

- **Surface-area explosion.** This is 11 milestones on top of 11. Mitigation: strict wave order, kill
  criteria per milestone (if M12's renderer choice fights us, timebox and cut scope, don't gold-plate).
- **Studio licensing:** Canva Connect is the default (no license cost); the future own-build
  alternative is deferred to a later milestone — no Polotno spend unless Tico re-prioritizes it.
- **WhatsApp + GBP API approvals** are outside our control — both are phased, neither blocks its wave.
- **DataForSEO spend** on backlinks/grids/reviews needs the cost-estimate UI from day one of M15.
- **AGPL + proprietary pieces:** Polotno (commercial) and Twilio/Resend/Buffer (SaaS) are dependencies,
  not derived code — compatible, but self-hosted users must bring their own keys/accounts (consistent
  with the existing BYO model).
- **Scope note:** this officially retires the earlier "don't expand into social/email/generic PPC"
  boundary. Marketr is now a marketing OS per the original SPEC language ("marketing and SEO
  workspace/OS") — flagging the change explicitly rather than letting it drift silently.

## Out of scope

Public launch, Product Hunt, public repo, Stripe billing changes, SSO against a real IdP, KMS
provider, SOC 2. Unchanged from DEPLOY.md §7.
