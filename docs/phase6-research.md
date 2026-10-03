# Phase 6 Research Brief — Authority & Relevance + Onboarding Intelligence Report

**Researched:** 2026-09-25. All sources dated; no vendor was contacted.
**Scope:** guest-post outreach engine, digital PR, local listings/citations, AEO agent (track + act), maps/review-site agent, and the Onboarding Intelligence Report.
**Method:** five parallel research tracks, each via current web sources. This brief records findings, honest capability verdicts (API-real vs. concierge vs. not feasible), and a recommended v1 scope shaped by the four locked decisions.

**Locked decisions (from the user — not re-litigated here):**
1. Outreach automation is **user-customizable**: a ladder (prospecting only → drafts for human send → fully automated pitching), chosen per campaign/workspace. Build the ladder/config, not a fixed depth.
2. The Intelligence Report ships **full on day one** — all audits: company intelligence, market position, competitor map, website, brand, SEO, paid-media, reputation, conversion, CRM, content, technology audits, revenue opportunities → 90-day Growth Plan.
3. Listings/citations route: honest recommendation below (§2) — no fake "one-click submits everywhere."
4. The AEO **act leg ships in Phase 6**: agents query LLMs, analyze highest-impact sources, then either act directly on that site/platform where possible or generate a concrete user action plan. Autopilot money/reputation rules (MASTER-PLAN §3.1) still apply — **no autonomous publishing without approval**.

---

## 1. Guest-post / link-outreach tooling

### 1.1 How the tools handle prospecting + deliverability (2026)

**Pitchbox** ($210–$1,200+/mo, 2026 pricing roundups): AI keyword assistant for domain prospecting, automated contact discovery with email-data scoring, imports from Ahrefs/Majestic APIs, AI personalization and AI reply handling. Deliverability: per-campaign daily send limits with scheduling windows, automated follow-ups, reply tracking with stop-on-reply, bounce mitigation, campaign send caps separated from manual reply volume, anti-footprint logic. Integrations are Zapier/Slack/Looker Studio only — **no public REST API found**. (pitchbox.com/blog, Aug 2026; technology.org, Aug 2026)

**BuzzStream** (~$24/mo): automated contact + social discovery via Chrome extension, whois fallback, conservative relationship-focused sending, automated follow-ups, open/click/reply tracking, weekly backlink checker with lost-link/nofollow/anchor-change alerts. "Has API" per listings but **no public developer docs discoverable** — effectively not an integration surface. (slashdot.org link-building pages, Sep 2026)

**Respona** ($95–$399/mo): live Google-crawler search engine for prospecting, AI contact auto-discovery, campaign templates by strategy, dynamic sequences. Added a **pay-per-placement done-for-you service** in 2026 ($100/link DR20+ up to $500 DR60+) and AI-answer visibility tracking. No public REST docs — Zapier + GA only. (technology.org, Aug 2026)

**2026 entrants:** Link Sonar ($49/mo), LinkDR (pay-per-backlink DR30+ $160 → DR60+ $500), Linkee (12M-site DB), Pitch.link (budget), Postaga (AI campaign planner, $84/mo). (technology.org, Aug 28 2026)

### 1.2 Deliverability-safe architecture (2026 consensus)

| Layer | Safe spec |
|---|---|
| Gmail/Workspace cold sending | **30–50/day/mailbox** (strict: 25–35); fresh accounts 5–10/day |
| Microsoft 365/Outlook | 30–50/day; hard throttle 30 msgs/min |
| Domain warmup | **30+ days minimum** (2–4 weeks absolute floor); ramp 10–20%/week |
| Domain strategy | 3–5+ **secondary** domains (never primary); 2–3 mailboxes per domain; rotate every 4–6 months |
| Auth | SPF + DKIM + DMARC (`p=quarantine`/`reject`) mandatory; custom tracking CNAME |
| Google/Yahoo bulk-sender rules | Enforced since Feb 2024, permanent: 5,000+/day to consumer inboxes → strict auth + **one-click unsubscribe (RFC 8058)** + **spam complaints <0.30%** (target <0.10%); Microsoft added similar rules May 2025 |
| Bounce ceilings | <2% healthy; pause at 3–5%; hard stop >5% |

2026-specific gotchas: Gmail's AI now catches mail-merged templates (hummingdeck, 2026); **shared synthetic warmup-pool footprints are algorithmically detected** — cheap peer-to-peer warmup networks burn reputations (Aug 2026); engagement (replies) matters more than raw warmup volume. (lemlist, close.com, mailreach.co, hummingdeck — all 2026; leadmagic/coldiq GitHub playbooks, Aug–Sep 2026)

### 1.3 API verdict

**API-real (integrate, don't build):**
- **Smartlead API** — public REST (~50 endpoints): programmatic warmup on/off + ramp config, inbox rotation, campaigns, lead injection, reply detection, webhooks. ~$39/mo, unlimited mailboxes + warmup. (GitHub skills, Sep 2026)
- **Instantly API v2** — public REST (Bearer, ~150+ endpoints, scoped keys): same + AI reply categorization, inbox placement tests, `reply_received` webhooks. (agent.mue.app FAQ, Jul 2026)
- **Email verification APIs** — MillionVerifier (~$19/10K, cheapest), ZeroBounce, NeverBounce v4, Bouncer, Kickbox. ~$0.001–0.01/verify. (techbullion, Sep 2026)
- **Hunter.io API** — email finding + verification for prospecting.
- **Google Postmaster Tools API** — programmatic domain/IP reputation + spam-rate monitoring (public, documented).
- **Gmail API / Microsoft Graph** — OAuth send + reply detection; BUT Gmail restricted scopes (`gmail.send`, `gmail.readonly`) require **Google's security assessment/audit** for a production app (gmass, Feb 2026) — a real cost/gating factor.

**Build in-house (no usable API):** Pitchbox, Respona, BuzzStream have no public REST — only Zapier. Their prospecting logic, sequence engine, reply detection, opportunity scoring, site-quality checks, backlink monitoring, and placement verification are the build.

**Not feasible / not safe:**
- Volume ceilings are law (~30–50/day/mailbox); scaling = buying infrastructure, not a settings toggle.
- Warmup cannot be shortcut; synthetic warmup pools are detected.
- **CASL (Canada):** consent required before first send — automated cold outreach to Canada is effectively off-limits.
- **CAN-SPAM:** $53,088/email (2026 figure); honest headers, physical address, opt-out within 10 business days — suppression enforcement must be instant.
- **GDPR/UK PECR:** cold B2B legal only under documented legitimate interest + easy objection; templated blasts fail the test.
- UX must hard-block: Canada cold pitching, primary-domain sending, skip-warmup sending, Gmail free accounts.

**Recommendation for the ladder:** integrate sending/warmup via Smartlead or Instantly API (sidesteps Google's security assessment); build the guest-post engine (prospect discovery, opportunity scoring, 3-depth sequence engine, reply detection, suppression, placement verification). The user-customizable ladder maps to: depth 1 = prospecting + scoring only; depth 2 = + drafts queued for human send; depth 3 = + automated pitching with all deliverability guardrails enforced and hard blocks above.

---

## 2. Citation / listing management reality

### 2.1 Channel-by-channel verdicts

| Channel | Verdict | Reality |
|---|---|---|
| **Google Business Profile** | **API-real (gated)** | Full CRUD real: locations, hours (regular/special/category-specific), attributes, categories, photo upload, local posts (Offers/Events/Updates — **Recurrence Info added April 7, 2026**), **review replies**, insights. **Limits:** API access requires application — verified GBP active 60+ days + website; **quota 0 QPM until approved, 300 QPM after**; **hard 10 edits/min per profile cap** (un-raisable). Verification (postcard/video) is owner-performed; API can only initiate/complete the flow. Q&A API discontinued Nov 2025. Post view counts (Sep 2026) are dashboard-only. (Google GBP API docs; ppc.land, Sep 10 2026; GMBapi.com, Apr 14 2026) |
| **Bing Places** | **API-real (partner-gated)** | Exists for "trusted partners": email partneronbp@microsoft.com, sandbox first, then production. Free GBP import (rebuilt Oct 2025). Lightest major-channel gate — realistic for a small platform willing to apply. (Bing Places API docs; ppc.land, Oct 2025) |
| **Apple Business** | **Reseller-gated** | Business Connect API exists but partner-only (~5 large platforms have access per gmbapi.com; dbaPlatform resells). **April 14, 2026: Apple folded Business Connect into the wider "Apple Business" platform.** No self-serve path for a small platform. (gmbapi.com; beyondyourbrand.co.uk, Sep 2026) |
| **Yelp** | **Reseller-gated / manual** | Fusion API is **read-only** — no listing writes. Writes via Yelp's Knowledge partner program (dedicated claiming API; Moz got one in 2017). Small platform: manual owner claim or become a partner. (business.yelp.com Leads API PDF, 2024; Medium/Places benchmark, Jun 2026) |
| **Data Axle** | **Reseller-gated** | No self-serve reseller API. Local Listings SaaS ~$12/mo/location; aggregator submission to its 16.7M-business DB is bought wholesale by listing-management partners (BrightLocal, Moz, Advice Local, Vendasta). (Slashdot/TechnologyCounter, 2026; advicelocal.com) |
| **Localeze (TransUnion)** | **Reseller-gated** | ~$79/yr + partner submissions; no open reseller path. (Slashdot, 2026; vendasta docs) |
| **Foursquare** | **Reseller-gated (enterprise)** | Pivoted to location-data licensing; a "background data source" now — businesses can't reliably claim/manage directly. Enterprise licensing only. (localdataexchange.com; vendasta docs) |
| **BrightLocal** | **Concierge-only for building** | Citation Builder is **hand-submitted by staff** (~$3/submission, $2/credit bulk), 2–4 week turnaround — "We submit data by hand." Tracking automated; aggregator submission ($65 for 4 aggregators) is resold wholesale. (brightlocal.com; archive.org; omnimarketing, Aug 2026) |
| **Whitespark** | **Concierge-only** | Manual submission service, ~70% acceptance, 3-week turnaround. Citation Finder is research; To-Do List is a manual workflow aid. (whitespark.ca blog, Sep 2026) |
| **Yext** | **API-real (expensive, reseller-gated)** | Genuinely API-driven: direct publisher integrations, 200+ publishers, real-time sync, duplicate suppression. But **rental model** — enhanced data reverts on cancellation (~$500–1,000+/yr/location); partner access via enterprise deals. (yext.com; vendasta docs; inoriseo.com, 2026) |
| **Moz Local** | **API-real (mid-market)** | Automated distribution to partner network + aggregators (~$4/mo add-on), duplicate detection; data persists after cancellation. ~$14–33/mo/location (2026). (upgrowth.in, 2026; slashdot, 2026) |
| **BBB + long tail** | **Manual-only** | No APIs. Industry consensus: aggregator distribution for breadth + manual for high-value niche (TripAdvisor, Healthgrades, Avvo, Houzz, BBB). ~20–40 hours for a 40–60-directory manual pass. |
| **Wildcard: Local Data Exchange** | **API-real (paid, small-friendly)** | API-first infra for small local-SaaS platforms: listings + reviews APIs, sandbox, **~$0.008/call**, 50+ publishers day one, "under 30 days to first integration." Closest thing to a plug-in citation backend. (localdataexchange.com, crawled Sep 2026; PR Newswire, 2025) |

### 2.2 Structural truth

Nobody has "one-click submit everywhere." Three layers: **(1) API layer** (real, narrow — Google, Bing, Apple, Facebook, where first-party APIs or partner programs exist); **(2) aggregator layer** (wholesale — Data Axle/Localeze/Foursquare, accessible only through an existing partner); **(3) concierge/manual layer** (the long tail — human form-fills, even at BrightLocal and Whitespark, who say so on their own sites).

### 2.3 Recommended v1 model (coordinator's call)

- **API-direct where real:** build GBP management first (apply for Basic API access now — needs Marketr's own verified GBP 60+ days + website; design for the 10-edits/min/profile cap and owner-side verification steps). Apply for Bing trusted-partner status in parallel — lightest gate.
- **Reseller where viable:** don't chase aggregator direct deals. Evaluate **Local Data Exchange** as the API-first backend ($0.008/call, sandbox, small-platform friendly) — fastest path to real programmatic breadth.
- **Apple = guided "claim your free Apple Business listing" flow**, not fake automation (partner-gated).
- **Concierge/brief workflow for the long tail:** an honest "citation brief" product — competitor-gap analysis (the Whitespark trick: show where top-3 competitors are listed), pre-filled per-directory NAP payloads, tracked manual-submission checklist with verification sweep. Price as done-for-you or DIY, never as "automatic."
- **Product honesty rule:** label every channel by its true tier in the UI (API-synced / aggregator-distributed / manual submission). The differentiator is gap analysis, tracking, and owning listings — not fake automation.

**Open question for the spec:** prototype the Local Data Exchange integration now (fastest programmatic breadth) or start pure GBP+Bing direct and keep distribution manual/resold for later.

---

## 3. AEO/GEO tracking + the act leg

### 3.1 How the tools track (methodology, 2026)

All tools run **stable, versioned prompt sets on cadence** (not continuous querying):
- **Otterly:** user-defined prompts + keyword→prompt converter, daily checks, weekly reports; tracks ChatGPT, Perplexity, Google AI Overviews, AI Mode, Copilot. Brand Visibility Index = mention frequency × position × authority. (otterly.ai; rankability.com, Sep 2026)
- **Peec:** daily prompt runs; measures brand mentions AND source citations (cited without brand named). €89/mo base. (Medium @mail_8018, Nov 2025; dailyemerald.com, Apr 2026)
- **Scrunch:** prompt-level tracking, 3-day refresh (daily for new prompts). (dailyemerald.com, Apr 2026)
- **Profound:** "browser-side capture across 80+ countries" — real consumer-UI scraping (enterprise risk appetite). (dailyemerald.com, Apr 2026)
- Community best practice: **20–50 "money prompts"** (buyer-intent comparisons, "best for…", troubleshooting) from sales calls/support tickets; verbatim weekly; value is in the trend. (mersel.ai, Mar 2026; dev.to, Sep 2026)

**Detection & scoring:** mention frequency + position (1st/2nd/3rd) + sentiment + cited domains. Core KPIs: Citation Rate, **Answer Share of Voice** = (brand appearances ÷ total responses) × 100, Share of Model, per-engine recommendation rate, sentiment, entity accuracy. Non-determinism handled by repetition — open-source **Lumora (AGPL)** runs each prompt N=3 and reports mention *rate* (2/3 = 67%), not a binary flag. (github.com/arcwel/lumora; medium.com/@yevgo888, Feb 2026)

**Key empirical findings:**
- Profound (100k prompts): **89% of AI citations differ between ChatGPT and Perplexity; only 11% of domains overlap** — aggregate visibility scores are un-actionable; per-engine reporting is mandatory. (fountaincity.tech, May 2026)
- Featured (Jun–Aug 2026): 22,881 citations across 11,499 domains; **76% of cited domains appeared exactly once**; no universal media list — sources shift per question. (medium.com/@brettfarmiloe, Aug 2026)
- AirOps (16,851 queries): DA/backlinks had **no positive correlation** with ChatGPT citations. What predicts citation: retrieval position (58% at position 1 vs 14% at position 10) and query-matching headings. (same)
- Citation leaders: ChatGPT → Wikipedia 47.9%, Reddit 11.3%; Perplexity → Reddit 46.7%, YouTube 13.9%; Google AI → Reddit 21%, YouTube 18.8%. AI Overviews cite ~7.7 sources/answer. (Profound 2024–25; allaboutai.com; blog.applabx.com, Sep 2026)

### 3.2 Self-hosted feasibility

**2026 API pricing (verified):** OpenAI GPT-5-mini $0.25/$2.00 per 1M in/out (nano $0.05/$0.40 for judge calls); Anthropic Haiku 4.5 $1.00/$5.00 (batch −50%, caching −90%); Google Gemini 3.8 Flash $0.75/$3.75 (promo through Dec 31, 2026); Perplexity Sonar $1.00/$1.00 + $5–12/1K request fee, **returns citations natively**. (anotherwrapper.com, Sep 2026; anthropic.com/pricing; aiseoshift.com, Sep 2026; felloai.com, Sep 2026)

**Worked cost** (per brand, weekly, 30 prompts × 4 engines × 3 reps ≈ 360 generations + 360 judge calls): generations ≈ $1.00/mo; LLM-as-judge on GPT-5 nano ≈ $0.12/mo; **total ≈ $1–5/mo per brand** (budget models), ≈ $15–40/mo with flagships, ~4.3× for daily cadence. Token cost is trivial — vendors charge €89+/mo for regional infra and ops. **Perplexity's Agent API** (2026) passes through provider models + tool fees; separate Search API at $5/1K. (felloai.com, Sep 2026)

**Parsing:** Perplexity Sonar returns citations natively; Claude web_search and Gemini grounding return sources; OpenAI Responses API web_search grounds answers. For plain completions, the proven **LLM-as-judge** pattern (Lumora, OneGlanse): cheap model extracts {mentioned, position, sentiment, competitors, cited sources} as JSON — ~$0.00007/call on nano-class models.

**Scoring:** mention rate (over N reps), per-engine SoV, recommendation rate, sentiment distribution, source citation frequency by domain — deterministic aggregation over stored runs (Postgres + scheduler, as Lumora/Elmo/Aperture do — open-source, MIT/AGPL, already in the wild).

### 3.3 The ToS line (critical)

- Anthropic Consumer ToS §3(7): no automated access *"through a bot, script, or otherwise"* except via API key. (anthropic.com legal archive, Sep 2026)
- OpenAI Terms of Use 2(c)(iv): no data extraction *"other than as permitted through the API."*
- **Reddit v. Anthropic (N.D. Cal., Sept 19, 2026):** court rejected Anthropic's demurrer to Reddit's ToS-breach scraping suit — ToS claims now have real litigation teeth. (lexblog.com, Sep 2026)
- **Verdict: automated prompting of consumer chat UIs violates both vendors' ToS.** Profound/Peec do browser-side capture anyway (enterprise risk appetite); Marketr must not ship that as the default. **Official API prompting is the permitted lane.**
- Honest caveat (OneGlanse README): the consumer-UI answer often ≠ raw API completion for the same prompt (UI layer adds/suppresses citations). API-based tracking is a **proxy** — disclose per-engine spread, don't claim exact consumer-surface fidelity.

### 3.4 "Source impact" methodology (converging practice)

1. **Citation frequency ranking:** aggregate cited domains/URLs across the prompt set; "citation efficiency" = citations per URL. Dageno AI 2026 benchmark: listicles 1.89, YouTube 1.83, review platforms 1.23, Reddit 0.73. (medium.com/@dagenoai, Apr 2026)
2. **Co-occurrence lift (the defensible "impact" metric):** P(brand recommended | source X cited) − P(brand recommended | source X not cited), per engine, over run history. High-lift domains are where effort pays.
3. **Page-level citability features** (GEO16 framework, arxiv 2509.10762): Metadata & Freshness (r=0.68, +47% citation impact), Semantic HTML (r=0.65, +42%), Structured Data (r=0.63, +39%) — concrete fixes for the action layer.

### 3.5 The act leg (ships in Phase 6)

Pipeline: prompt set (versioned, per-client) → scheduler (weekly default) → fan-out via **official APIs only** (N=3 reps, web-search grounding where available) → parse (native citations or LLM-as-judge JSON) → score (mention rate, per-engine SoV, sentiment, source frequency + co-occurrence lift) → **act**:
- **Owned-domain sources** (client's own site/pages): generate specific content fixes from the GEO16 pillars (metadata/freshness, semantic HTML, structured data, query-matching headings) → these flow through the existing supervised fix-agent ladder (propose → approve → apply).
- **Third-party sources** (Reddit threads, review sites, listicles, YouTube): Marketr cannot edit these — generate a **concrete user action plan** (e.g., "answer this Reddit thread," "claim/update this listicle entry," "earn a review on G2") with the expected lift attached.
- **Approval gates:** no autonomous publishing, per Phase 6 exit gate and §3.1. The act leg proposes; the human approves.

**Not feasible / excluded:** scraping consumer chat UIs (ToS-violating); Google AI Overviews without a SERP provider (Google SearchGuard blocks scrapers — Nozzle reported ~80% data loss Sep 2026; options: BYO DataForSEO SERP API per Marketr's existing data strategy, or approximate AIO via organic rankings — 76.1% of AIO-cited URLs rank top-10 organic — and label the gap honestly); exact-string brand matching alone (use LLM-as-judge with alias list); cross-engine composite scores (89% divergence makes them un-actionable).

**Open questions for the spec:** judge-model routing (local Ollama for zero-egress vs. nano-class API — note Gemini free tier prohibits confidential data); AIO coverage route (DataForSEO vs. organic-rankings approximation); which flagship models justify the premium per brand.

---

## 4. Digital PR workflows

### 4.1 HARO's status (fast-moving, 2026)

- **Cision shut HARO down Dec 9, 2024** (rebranded as Connectively, then discontinued; Cision moved to CisionOne). (prezly.com academy, ~Aug 2026)
- **Featured.com bought HARO from Cision and relaunched it April 2025.** (PRNewswire)
- **May 26, 2026: Featured revived Connectively too** — migrating its platform (100K users, 2,500 publishers) to the Connectively brand; HARO stays standalone; Featured relaunched June 2, 2026 as an "AI co-pilot for PR." (GlobeNewswire)
- Quality concern: revived HARO has **user complaints about AI-generated responses flooding the platform with little quality control** — a trust gap Marketr should internalize. (Prezly guide)

**Mechanics (query → pitch):** journalists post source requests with deadline + requirements; platforms distribute via email digests (HARO's classic 3x/day), real-time alerts, or in-platform browsing. Sources keep an expert profile (bio, credentials, past placements), filter queries by category, submit a pitch (short quote + bio + headshot) in-platform or by reply email. Anti-noise mechanics: Qwoted verifies journalists AND experts, anonymizes requesters, **holds new requests 2 hours on free tier** (speed is the game — paid removes the delay). (slashdot.org comparisons, 2026)

**2026 alternatives:** Qwoted (premium, verified — Forbes/Bloomberg/Reuters; free = 2 pitches/mo with delay; Pro $149/mo or $99/mo annual); Featured (free Starter 3 answers/mo; Pro $99/mo or $49/mo/seat annual); Source of Sources / SOS (free, founded by HARO's founder); SourceBottle (AU/UK); #JournoRequest on X (real-time, needs monitoring); Help a B2B Writer (~3 queries/week, B2B SaaS fit); ProfNet (enterprise). Qwoted's "Has API" is a marketplace integration API (Gmail/Outlook/LinkedIn), **not** a public query feed for reselling — treat as unverified for aggregation.

### 4.2 Journalist-outreach tool mechanics

- **Muck Rack** (Feb 2026): **Media List Agent** — from pitch content, recommends journalists to add/remove with explanations (recent articles, location), surfaces up to 50, and **explicitly never sends without human approval**. 2026 State of AI in PR: only **12% of PR pros use AI agents today**. (GlobeNewswire, 2026-02-02)
- Pricing: Muck Rack ~$5K–$53K/yr (no trial); **Prowly** (now Semrush AI PR Toolkit) ~$258–$416/mo; **Prezly** ~$80–100/mo, **no built-in media database by design**. (prezly.com, Aug 2026)
- List-building in 2026: curated verified databases (Muck Rack 250K+ accuracy-over-scale vs. Cision 850K+), beat/recent-coverage matching, AI matching agents — winning workflow is *assisted* curation: agent proposes, human approves. **No media-database vendor offers a cheap/resellable API** — databases are the moat, sold as seats.

### 4.3 Toolable vs. human — the honest split

**Genuinely toolable:** query aggregation/alerting (HARO/Connectively/Qwoted/SOS/HAB2BW/#JournoRequest digests, de-dupe, keyword-match against client expertise profiles, deadline triage — the clearest automation win); research assist (summarize journalist's recent articles, pitch-the-gap, client credentials, deadline feasibility); pitch drafting as **first drafts, not send-ready** (structured templates, quote skeletons, pre-send checklists); follow-up sequencing with hard caps (max 2 follow-ups, then 90-day re-engagement), declination logging, CRM hygiene.

**Must stay human:** the judgment call ("Use AI for the research. Do not use it for the judgment." — Brett Farmiloe, Featured CEO, Aug 2026); relationships (85% of journalists: best opener is a no-ask email); exclusive offers/embargoes (never automated — BCC = embargo-break risk; individual sends only); fact-checking (72% of journalists worry about AI hallucinations; 1,000+ documented UK articles built on fictitious AI "experts"). (medium.com/@baldikovn, Nov 2025; LinkedIn/Yana Basaranovich, May 2026)

**2026 meta-context:** AI made personalized-looking pitching near-zero cost, which flooded inboxes and poisoned the channel — "signal that used to prove effort now proves nothing, because a script can produce that line." AI-generated pitch *send* is now actively harmful: 78% of journalists block spammers; 52% block for excessive follow-ups; 88% delete irrelevant pitches (#1 reason). Never auto-send on behalf of the client's identity — fake-identity outreach scandals (Movchan/Gradient Labs, Aug 2026) are an active reputational hazard. (tech.eu, 2026-08-03; hunterwalk.medium.com, Sep 2026; swordandthescript.com, Apr 2026)

**Journalist pitching vs. guest-post outreach (structural differences):** journalists get ~50 pitches/week with long memories — a bad pitch burns a relationship, not just a bounce. Rules: no attachments (spam filters; paste text, link a Drive kit); subject ≤49 chars, no clickbait; SPF/DKIM/DMARC aligned; warm inboxes 2–3 weeks (10→25→50/day); test spam placement first; 1:1 sends never BCC; ≤30/day per inbox for tier-1; max 2 follow-ups at 48-hr cadence; **run a humanize/de-AI pass** (journalists are hypersensitive to AI signals — em-dash density, formulaic structure — and many run AI detectors); check pitching guidelines and what they already covered (**pitch the gap**); reference audience fit (78% want direct audience relevance; only 3% say outreach always reflects their community). (openpr.com, 2026; GitHub craftos-dev pr-comms skill, 2026)

**Recommended v1:** "query aggregation + pitch drafting + tracking — with humans sending." Opportunity feed (ingest + keyword/profile match + deadline triage with same-day urgency flags); draft workspace (research brief, quote skeleton, pre-send checklist) — never auto-send; relationship CRM-lite (history, declinations, 90-day re-engagement, max-2-follow-up enforcement); coverage attribution (submitted → placed, tie to visibility). **Do not build in v1:** auto-sending pitches, automated follow-up emailing, media-database licensing. The industry's 2026 consensus — including Muck Rack's own agent design — is *agent proposes, human approves*.

---

## 5. Review-site / maps management

### 5.1 GBP API in 2026: what's programmable

**Review replies via API are real:** `PUT /v4/accounts/{accountId}/locations/{locationId}/reviews/{reviewId}/reply` (`accounts.locations.reviews.updateReply`) — creates or replaces the public owner reply. Reviews live on the legacy v4 API (never migrated to v1 — confirmed Sep 2026). Also real: `batchGetReviews`, Pub/Sub new-review notifications, business info/hours/categories/photos/attributes, LocalPosts (Offers/Events/Updates).

**New April 2026 (three changes, confirmed):**
- **ReviewReplyState (API v4.9)** — every reply is pre-publication moderated: PENDING → APPROVED/REJECTED. GMBapi.com observed ~12,000 replies rejected in its ecosystem, with false positives (reviewer's legal name, exclamation marks). A REJECTED reply is silently blocked — **any reply agent must query reply state, not just submit**. (ppc.land, Apr 9 2026; GMBapi.com, Apr 14 2026)
- **Recurrence Info** (April 7) — recurring Events/Offers posts programmable.
- **Customer review images** (live April 20, 2026) — review photos now in the review object; new brand-intelligence surface.

**Access:** verified locations only; Google API project approval; OAuth `business.manage` scope via user consent (no service accounts); ~10 edits/min per-profile cap; no sandbox (`validateOnly=true` where supported). **Owner-required directly:** verification, ownership claims/transfers, and the review-link/QR channels Google formalized Dec 31, 2025. Q&A API discontinued Nov 3, 2025 (being replaced by AI "Ask Maps").

**Bottom line:** replies, posts, hours, photos, attributes are all API-real. The constraint is Google's API approval + policy, not technical capability.

### 5.2 Google's stance on automated replies

**No single policy line bans "automated review replies" by name.** The binding constraints are overlapping 2026 policy lines:
- Replies are pre-publication moderated (ReviewReplyState); a **"Report owner response"** feature (Aug 2026) lets reviewers flag owner replies — Google treats replies "with the same scrutiny as reviews." Flag patterns can affect profile standing.
- **Solicitation rules, April 17, 2026** (ppc.land): quota-based staff solicitation banned; reviews mentioning staff by name banned; incentives = "fake engagement, strictly prohibited" (formalized Dec 31, 2025); review gating/filtering unhappy customers named as banned. Enforcement ladder: silent removal → consumer-facing "fake reviews removed" banner → restriction/suspension. 2025 enforcement: 292M reviews blocked/removed, 13M fake profiles removed (Google Trust & Safety, Apr 16, 2026).
- Google's own posture is **draft-only**: GBP's "Suggest description" writer and limited-test AI review-reply drafts (US/Brazil/India, since ~March 2026; Gemini–Business Profile integration announced June 10, 2026) are all human-in-the-loop, never auto-posting. (mbadv.agency, 2026)

**What the reputation tools actually do (2026):**
- **Birdeye** (BirdAI): "Posts on its own, or holds for approval — **you decide**"; G2 reviews (Jan–Jul 2026) confirm Google auto-response in production. → Configurable auto-post exists at market scale.
- **Podium**: "Recommend a Reply" — AI drafts, human clicks Reply to publish. → Draft-then-approve.
- **GatherUp**: Auto Reply Templates — AI selects from brand-approved responses, auto-replies to positive reviews; AI-generated replies posted from dashboard. → Template-auto for positives, human posting otherwise.

Industry standard: **AI-drafted, auto-post configurable (especially positives), approval-gated for negatives** — and Google has not shut down Birdeye/Podium. The compliance lever is at the content layer (moderation + reportable replies), not a ban on automated posting.

### 5.3 Review velocity: legitimate orchestration

Marketr already has QR pages and triggers (Phase 3). The 2026-compliant additions: **CRM/PMS/POS transaction webhooks → SMS/email request at "smart timing"** (inside an existing conversation thread — the highest-converting channel, within Google's four documented channels: receipts, thank-you emails, end-of-chat, in-store QR — Dec 31, 2025 help docs); NFC tap stands / location-specific QR; sentiment-split funnels — handle carefully: routing happy customers to Google and unhappy to a private channel is standard (GatherUp, Jun 2026) but adjacent to Google's review-gating prohibition — frame as "feedback triage," never suppress.

### 5.4 Apple Business Connect + Bing Places

- **Apple:** public API since Jan 2023 (business info, hours, photos, Showcases, Insights). **Review replies: NOT programmable** (2026 open-source adapter documents `replyToReview` returning "informative error — Apple does not support reply API"). Apple Maps reviews are aggregated from partner sources (Yelp etc.). → v1: listing sync + read/monitor; replies manual or deferred.
- **Bing Places:** **no native review system, no reply function at all.** Reviews are aggregated from TripAdvisor, Yelp, ThreeBestRated, Facebook — respond on those platforms. Listing-data API is real and free (bulk edits, agency accounts); platform relaunched Oct 2025 with better Google-import flows. → v1: NAP/hours/photo sync via API; review management = redirect to source platforms. (hustlemarketers.com, Sep 2026)

### 5.5 Recommended v1 model

**AI-drafted replies in an approval queue — never auto-post in v1.** The human taps approve (or edits first); Marketr posts via API and polls ReviewReplyState PENDING→APPROVED, retrying/escalating on REJECTED. Sentiment routing: positives get instant drafts in-queue; negatives flagged urgent for human eyes. Guardrails before drafting: block staff names, PII, incentives language, keyword-stuffed templates. Optional v2 (explicit per-business opt-in, mirroring Birdeye): configurable auto-post for 4–5★ reviews with the same moderation-state loop. Apple/Bing: listing sync + review monitoring only; replies manual/deferred.

---

## 6. Recommended Phase 6 v1 scope (synthesis)

Shaped by the four locked decisions. "API-real / concierge / not feasible" verdicts inline.

### O1 — Guest-post outreach engine (user-customizable ladder)
- **Build:** prospect discovery (SERP + contact scraping, Hunter.io for email finding), opportunity scoring (site quality, relevance), sequence engine with the **3-depth ladder** — depth 1: prospecting + scoring only; depth 2: + drafts queued for human send; depth 3: + automated pitching with all guardrails enforced. Reply detection, stop-on-reply, bounce handling, instant suppression/opt-out enforcement, placement verification + backlink monitoring (lost-link/nofollow/anchor-change alerts).
- **Integrate (don't build):** sending + warmup via **Smartlead or Instantly API** (white-label-ready, unlimited mailboxes — sidesteps Google's Gmail security assessment); verification via MillionVerifier/ZeroBounce; deliverability monitoring via Postmaster Tools API.
- **Hard UX blocks:** no Canada cold pitching (CASL), no primary-domain sending, no skip-warmup sending, no Gmail free accounts, no Canada… (enforced, not warned).
- **Compliance:** CAN-SPAM ($53,088/email 2026) physical address + 10-day opt-out honoring; GDPR legitimate-interest documentation for EU/UK.

### O2 — Digital PR (query aggregation + drafting + tracking; humans send)
- **Build:** opportunity feed ingesting HARO/Connectively/Qwoted/SOS/HAB2BW/#JournoRequest (email-digest parsing + monitoring), keyword/profile matching against client expertise, deadline triage with same-day urgency flags; draft workspace (journalist research brief, pitch-the-gap analysis, quote skeleton, pre-send checklist); relationship CRM-lite (history, declination reasons, 90-day re-engagement, max-2-follow-up enforcement); coverage attribution (submitted → placed → visibility).
- **Do not build in v1:** auto-sending pitches, automated follow-up emailing, media-database licensing (prohibitively expensive enterprise moat). No media-database resell play.
- **Quality bar:** humanize/de-AI pass on drafts (journalists run AI detectors); never auto-send on client identity.

### L1 — Listings/citations (honest three-tier model)
- **API-direct:** GBP management (apply for Basic API access now — needs Marketr's own verified GBP 60+ days + website; design for 10-edits/min cap; owner-side verification manual); Bing trusted-partner application in parallel.
- **Reseller:** evaluate **Local Data Exchange** ($0.008/call, sandbox) as the programmatic breadth backend — fastest honest path to aggregator coverage without enterprise deals.
- **Guided flows:** Apple Business = "claim your free listing" walkthrough, not fake automation.
- **Concierge/brief:** citation brief product for the long tail — competitor-gap analysis (show where top-3 competitors are listed), pre-filled NAP payloads, tracked manual checklist with verification sweep.
- **UI honesty rule:** every channel labeled by true tier (API-synced / aggregator-distributed / manual submission).

### A1 — AEO agent (track + act)
- **Track:** versioned per-client prompt sets (20–50 money prompts from sales/support), weekly cadence, official APIs only (GPT-5-mini/nano, Haiku 4.5, Gemini 3.8 Flash, Perplexity Sonar), N=3 repetitions, web-search grounding where available. Parse via native citations or LLM-as-judge JSON on nano-class models. **Cost ≈ $1–5/mo per brand.**
- **Score:** mention rate, per-engine Answer Share of Voice, recommendation rate, sentiment, source citation frequency + co-occurrence lift. **Per-engine reporting only** — no composite scores (89% cross-engine citation divergence).
- **Act:** owned-domain sources → specific content fixes from GEO16 pillars (metadata/freshness, semantic HTML, structured data, query-matching headings) through the supervised fix-agent ladder; third-party sources → concrete user action plans with expected lift attached. Approval gates on all publishing.
- **Excluded:** consumer-chat-UI scraping (ToS-violating per Reddit v. Anthropic, Sep 2026); disclose the API-proxy caveat honestly.

### R1 — Maps/review-site agent
- **GBP (API-real):** AI-drafted review replies in an approval queue — human approves/edits, Marketr posts via v4 `updateReply`, polls ReviewReplyState to APPROVED, escalates on REJECTED. Sentiment routing (positives instant drafts; negatives urgent). Pre-draft guardrails: no staff names, no PII, no incentives language, no keyword-stuffed templates.
- **Listing upkeep:** hours, attributes, photos, posts (incl. recurring posts) via API; review-media objects as a brand-intelligence surface; Pub/Sub new-review notifications.
- **Velocity:** CRM/PMS/POS webhooks → smart-timing requests in existing threads; sentiment-split funnels framed as "feedback triage," never suppression (gating prohibition, Apr 2026).
- **Apple/Bing:** listing sync + review monitoring; replies manual/deferred (Apple has no reply API; Bing has no native reviews).
- **v2 (explicit opt-in):** configurable auto-post for 4–5★ reviews, mirroring Birdeye — not in v1.

### I1 — Onboarding Intelligence Report (full, day one)
- **Connect:** website, GBP, GA4, Search Console, Meta, Google Ads, CRM, email platform, Shopify, social accounts (OAuth where available; credential-vault pattern from Phase 5).
- **Twelve audits → one report:** company intelligence, market position, competitor map, website, brand, SEO, paid-media, reputation, conversion, CRM, content, technology audits + revenue opportunities → **recommended 90-day Growth Plan**.
- **Build note:** most audit inputs already exist (Phases 0–5: SEO stack, paid-media buying data, review config, CRM, content engine, site auditing). New work: paid-media audit pack, brand audit, conversion audit, technology audit, and the report compiler (PDF + dashboard) that turns twelve audits into one prioritized plan. This is the wedge demo — it should be the most polished surface in the phase.

### Cross-cutting (all tracks)
- **No autonomous publishing without approval** — Phase 6 exit gate; §3.1 red-lane rule. Every external action (pitch send at depth 3, review reply post, listing edit, content fix) is approval-bound or human-executed.
- **Deliverability safeguards** — Phase 6 exit gate: warmup enforcement, volume ceilings, auth checks, suppression lists, bounce circuit-breakers, all battery-tested.
- **Placement-tracking accuracy** — Phase 6 exit gate: backlink verification, coverage attribution, listing-verification sweeps, citation-frequency audits.
- **Tenant isolation:** workspace-scoped everything (prospects, sequences, listings, prompt sets, reports) with battery-proven cross-workspace denials — same bar as prior phases.

---

## 7. Honest limitations & open questions for the spec

1. **Local Data Exchange vs. pure GBP+Bing direct** — prototype the LDE integration now (fastest programmatic breadth) or defer distribution to manual/resold? (Spec decision.)
2. **Google AI Overviews coverage** — BYO DataForSEO SERP API (consistent with Marketr's data strategy, but routes client queries to a third party) vs. organic-rankings approximation (76.1% of AIO-cited URLs rank top-10 organic) with the gap labeled honestly. (Spec decision.)
3. **Judge-model routing** — local Ollama for zero-egress parsing vs. nano-class API calls (note: Gemini free tier prohibits confidential data). (Spec decision.)
4. **Gmail API direct vs. Smartlead/Instantly partner** — direct means budgeting for Google's security assessment; partner sidesteps it. Recommendation: partner. (Spec decision.)
5. **Auto-post for 4–5★ reviews** — v1 behind explicit per-business opt-in, or v2 only? Track research leans v1-drafts-only with v2 opt-in; Birdeye precedent shows the market tolerates configurable auto-post. (Spec decision.)
6. **Outreach at depth 3 is infrastructure, not config** — 30+ day warmup before first production send, secondary domains, 30–50/day/mailbox ceilings. The product must sell the *setup* honestly, not promise instant volume.
7. **HARO/Connectively quality decay** — AI-generated response flooding on the revived platforms means Marketr's query-matching and pitch quality bar must be *higher* than the platform average, or placements won't convert. The trust gap is the opportunity.
8. **No media-database licensing play** — databases are the enterprise moat (Muck Rack $5K–$53K/yr, no trial). Marketr competes on matching + drafting + tracking, not on owning the database.
9. **Apple review replies don't exist as an API** — any UI implying otherwise would be a lie; monitor-only in v1.
10. **AEO numbers are directional** — API-based tracking is a proxy of consumer surfaces (UI ≠ API completions); per-engine spread is itself the metric. Never present a single "AI visibility score" as ground truth.

---

*End of Phase 6 research brief. Next step: docs/specs/SPEC-PHASE6.md.*
