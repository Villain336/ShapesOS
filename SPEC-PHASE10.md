# Marketr — SPEC-PHASE10: Intelligence Depth — Owned Data Assets

**Status:** APPROVED by Tico 2026-09-26 — build authorized.
**Research basis:** Phase 10 research report, 2026-09-26 (parent-agent handoff; research-only subagent) + `~/workspace/marketr-strategy/DATA-AND-FUNDING-STRATEGY.md` (2026-09-25) + `~/workspace/brainstorm/marketr-data-independence.md` (2026-09-25, BRAINSTORM-ONLY inventory).

**Tico's decisions (2026-09-26):**
1. The intelligence gap is **data rented from APIs → own it**.
2. Legality posture: **right up to the ToS edge, never over it**.
3. Phase 10 serves **both** goals equally: **cut API rent AND build a data moat**.
4. **Platform-change monitoring** ("Google's update → N of your pages at risk") is **in scope**.

---

## 1. What Phase 10 is

Phases 0–7 built the marketing OS on rented data: DataForSEO for SERP/keywords, LLMs for generation, licensed vendors for everything measurable. Phase 8–9 built the brain (Business Graph, Growth Memory, Chief Strategy Agent). Phase 10 builds the **senses** — Marketr's own intelligence layer, fed by first-party and free sources first, paid APIs only where no legal build path exists.

The governing sentence: **every data line gets asked, in order: can we own it free? can we own it cheap? can we rent it cheaper? — and the answer is enforced in code.**

### The three intelligence outcomes

1. **Rank truth without rent.** For owned sites, GSC is the truth — free, official, hourly. Paid SERP calls are reserved for what GSC legally cannot see (competitors, zero-impression keywords, SERP-feature composition).
2. **A radar nobody else ships.** Platform-change monitoring is a genuine greenfield: official changelogs + GSC hourly deltas → "Google's Aug 18 Spam Update hit 3 of your pages." Zero ToS exposure, cheap to run.
3. **Honest AI visibility.** The GEO-tool category is proven (Profound at $1B, Otterly 20k+ users) but the measurement science is shaky (AI Overviews shift ~70% on repeat; ChatGPT/Perplexity citation overlap only 11%). Marketr doesn't sell a single "AI visibility score" — it sells distributions, confidence intervals, and first-party corroboration. That honesty *is* the moat.

### What Phase 10 is NOT
- Not a backlink index. Web-scale index building (Ahrefs: 8B pages/day, 35T records) is seven figures + years. Ruled out for good.
- Not SERP self-scraping. The SerpApi DMCA dismissal (Jul 20, 2026) changed litigation weather, not the build decision: Google keeps contract/IP-block/ToS enforcement, and SearchGuard (JS rendering mandatory since Jan 2025) made scraping a permanent arms race with multi-day blackouts hitting Semrush and SE Ranking. Rule stands.
- Not "one AI visibility score." Never. See M3's honest-labeling contract.
- Not unlicensed review scraping, not chat-UI scraping, not the Yelp Open Dataset (academic-only — legally unusable in the product), not ORCAS for commercial use (research-use only — lawyer before any commercial use).

---

## 2. "Right up to the edge" — the posture, with boundary lines

Tico's directive is maximum legal aggression: use every clean source to its limit, take every defensible gray-zone position with hedges, cross nothing. This section is the map. It is enforced in code review and in the verification battery (M7).

**✅ Clean — use freely, prefer over everything else:**
- Official Google surfaces: GSC API (Search Analytics 1,200 QPM/site, HOURLY_ALL data, BigQuery bulk export removes row caps), Keyword Planner API (free with manager account; product use allowed), Google Search Status Dashboard, Search Central documentation changelog, GBP API (owned listings), GA4.
- Bing Webmaster API/blog (free, inbound links for verified sites), Apple Business Connect (free).
- Common Crawl hyperlink graph (`s3://commoncrawl/projects/hyperlinkgraph/`, quarterly; domain-level PageRank/in-degree/harmonic centrality) and CC corpora — storage/reuse per their terms.
- Firecrawl OSS (self-hosted extraction core): persist ✅, resell ✅, compete ✅ — cleanest extraction stack.
- Open PageRank (30,000 free domain lookups/mo, no card — derived from CC web graph), Moz Links API free tier (2,500 rows/mo).
- GDELT (free global news corpus — candidate branded-mention source for M3).
- Google Alerts as a *consumer tool* signal (30-second baseline for competitor new-page detection — using the free product, not scraping it).

**⚠️ The edge — use with explicit hedges, documented:**
- **Licensed retail SERP APIs (DataForSEO, Serper, TalorData):** the vendors are on *firmer* legal ground post-SerpApi-dismissal, and risk sits with them — but Google's ToS breach theory survives. Hedge: the provider interface stays abstracted (§M6); we can swap vendors in days if one dies or gets enjoined.
- **Cross-user keyword-volume cache:** the single biggest remaining cost lever ($132/1M clickstream bulk, ~90% hit rate at scale [ESTIMATE]). DataForSEO §7.1 forbids using data to "compete with or adversely affect the business interests of the search engine providers." A months-long cache serving users who'd otherwise query directly is an untested gray zone — **no case law found (2026)**. **Tico decision (2026-09-26): proceed with the cache — no legal-review gate; conservative posture retained as defensive design:** TTLs of 30–90 days, cache-invalidation-on-use, per-workspace attribution so the cache can be narrowed later if needed.
- **Light use of Google's undocumented autocomplete/Suggest endpoint** for keyword ideas: low-risk at light volumes; capped client-side; never the backbone of a feature.
- **Review velocity data** via DataForSEO Business Data ($0.012–$0.05/task) or Yelp Fusion (free tier) — licensed retail paths only; enterprise review-scrapers exist but sell ToS-gray data, so Marketr does not compete with them there.

**🚫 Never — hard lines, no exceptions, enforced in verification tests:**
- Self-scraping Google SERPs (contract/arms-race risk, spec-ruled-out).
- Bulk-extracting any vendor's API to build a competing index (detection via usage anomaly, legal liability, data rot — keyword/SERP data decays within months).
- Scraping ChatGPT/Perplexity/Gemini web UIs (ToS violation — AI-visibility prompt-sending goes through official provider APIs only).
- Scraping Reddit, Google Maps, or any platform's user content (Reddit v. Anthropic, Sept 19, 2026: ToS now has contract/unfair-competition teeth independent of copyright — "Terms of Service just got teeth").
- Yelp Open Dataset in the product (academic-only license, verified in license text).
- ORCAS/MS MARCO commercial use without counsel (research-use-only).
- Google Custom Search Engine as a dependency — it **shuts down 2027-01-01**; M6 includes a dependency sweep confirming nothing (Marketr or user BYO setups) depends on it.
- Inventing search volume from thin air. Volume is clickstream/panel data; upstream panels are enterprise-quote-only (historically millions/yr). The only retail path is $132/1M clickstream bulk or Keyword Planner. There is no third option.
- Reselling raw Google data wholesale (Keyword Planner ToS restriction).

---

## 3. Modules

### M1 — GSC-first rank intelligence

**Goal:** make GSC the default rank truth for owned sites; cut paid SERP spend to only what GSC cannot legally see.

**What it does:**
- Connects GSC per project (OAuth already exists in earlier phases). Pulls Search Analytics at hourly granularity (`HOURLY_ALL`, available since Apr 2025) for tracked queries × pages × countries × devices.
- Optional **BigQuery bulk export** path (free setup, ~$0 for small sites; removes the ~50,000 rows/day/search-type/property API cap entirely). Anonymized queries are excluded — documented honestly.
- Recomputes the visibility score and winners/losers from GSC deltas instead of paid rank checks for owned keywords. Paid SERP checks (M6 vendor abstraction) run only for: competitor keywords, zero-impression queries, and SERP-feature composition (AIO presence, feature crowding for the difficulty model).
- Before/after delta engine: given two windows, attribute per-page, per-query movement with magnitudes — this is the measurement primitive M2's radar consumes.
- URL Inspection API (2,000 QPD per site — the hard wall, no service-account escape): **priority-queue inspection scheduling**, never sweeps. GSC hourly data + custom annotations (Nov 2025) mark deployments; the API flags that annotations don't appear in comparison mode.

**Non-goals:** replacing rank tracking for non-GSC-connected sites (paid SERP stays for them); rebuilding GSC's UI; sweeps of URL Inspection.

**Data sources (legal status):** GSC API ✅; GSC → BigQuery export ✅; URL Inspection API ✅ (rate-limited, queue fairly).

**Build-order rationale:** after M6 (it defines how the residual paid-SERP layer is bought). Unlocks the largest single COGS cut in the phase.

**Cost notes:** GSC is free. Paid rank checks for an 800-keyword weekly tracked set currently run ~$1.30/mo per heavy user via DataForSEO Standard ($0.60/1K); Serper volume tier drops this to ~$0.30/1K. GSC-first takes the owned-site portion to ~$0 API cost.

### M2 — Platform-change radar (FLAGSHIP)

**Goal:** the joined product nobody ships — "Google's August 18 Spam Update hit 3 of your pages; here's what moved and what to do."

**What it does:**
- Daily cron over **official sources only** — Google Search Status Dashboard (confirmed rollout windows with exact dates; e.g., August 2026 Spam Update: began Aug 18, lasted ~2d16h), Google Search Central documentation changelog (Sept 2026 entries show the cadence), Bing Webmaster blog. **No SEO-Twitter noise** — the brainstorm's explicit constraint.
- **Critical classifier: documentation update ≠ ranking algorithm update.** A Sept 2026 Search Central docs edit is not a ranking change; the system must label each event (confirmed rollout / docs change / volatility-signal) and never alert on docs-only edits. (A recent industry guide had to explain exactly this confusion — the confusion *is* the product opportunity.)
- Correlation engine: for each confirmed rollout window, compare each connected property's GSC hourly deltas (pre-window baseline vs. during/post window) → per-page, per-query impact scores with magnitudes and confidence bands.
- Per-client mapping: "Update X → N of your pages at risk / affected," with the affected pages, the queries that moved, and a recommended verification checklist (not auto-fix prescriptions — attribution is honest about uncertainty).
- Volatility context: cross-reference with public volatility trackers (SEMrush Sensor, Moz MozCast) for SERP-flux confirmation — as corroboration, never as the impact source.
- Writes structured events to Growth Memory (Phase 8) so the Chief Strategy Agent (Phase 9) can reason about update exposure in Missions.

**Non-goals:** predicting algorithm updates; attributing movement that the data can't support; scraping SEO blogs for rumors.

**Data sources (legal status):** Search Status Dashboard ✅; Search Central changelog RSS ✅; Bing Webmaster blog RSS ✅; GSC hourly data ✅; SEMrush Sensor / MozCast (public pages, read-only display) ✅.

**Build-order rationale:** highest visibility moat, lowest cost, zero legal exposure. Flagship — ship it early in the feature sequence so the moat is live while heavier modules build.

**Cost notes:** RSS + cron + GSC calls are ~$0. The summarizer runs on the local/owned-model ladder (distilled small model per the data-independence ladder — renting-the-teacher-once for labels on our own data is legit).

### M3 — AI-visibility intelligence layer

**Goal:** deepen Phase 6's AEO module into intelligence, not more commodity prompt-sending. The differentiator is *honest measurement + first-party corroboration + action mapping*.

**What it does (the honest-labeling contract is non-negotiable):**
- **Never a single "AI visibility score."** Every metric ships as: per-engine share with Wilson-style confidence intervals, N-rep stability score, leader-flip rate, and an `unstable_share > 30%` flag (the open GEO methodology's threshold). AI Overviews shift ~70% on repeat; ChatGPT/Perplexity citation overlap is 11% — per-engine reporting is mandatory, composite scores are noise. API-vs-UI variance >15% is surfaced as a data-quality event, not hidden.
- Versioned prompt panels (Phase 6 pattern kept): 12–25 frozen real buyer prompts per brand, run at fixed cadence, never swapped weekly; N-repeat runs on money prompts.
- **Citation-URL tracking:** which URLs get cited per engine per prompt, citation-gap analysis (competitor cited where you aren't), per-prompt citation lists with domain normalization.
- **First-party correlation layer:** GSC AI Overview impressions + GA4 AI-referrer traffic (chat.openai.com, perplexity.ai, gemini.google.com — one vendor-adjacent source claims ~4x organic conversion; Marketr reports the user's own GA4 numbers, never the claim) + AI crawler activity in server logs (GPTBot, OAI-SearchBot, ClaudeBot, Claude-User, PerplexityBot, Bytespider) as a *preceding* indicator of citing. First-party signal is the honest anchor.
- **Branded-mention tracking** across the web: the Ahrefs Dec-2025 study of 75,000 brands found branded web mentions correlate **0.664–0.709** with AI-assistant visibility vs **0.266–0.326** for Domain Rating and ~0.19–0.30 for raw backlinks. Sources: GDELT ✅, CC-NEWS ✅, licensed news/search APIs — never platform scraping. This reframes "link building" as **entity/mention building** inside Marketr's outreach and content guidance.
- **Citation-gap → action mapping:** "Perplexity cites competitor X's pricing page for 8/15 buyer prompts you target; your pricing page lacks [structured facts]" — connected to the content engine's briefs (Phase 2), not just a dashboard.

**Non-goals:** commodity prompt-sending as a standalone feature (Elmo exists — free, open-source, self-hosted, unlimited prompts); claiming measurement precision the science doesn't support; scraping chat UIs.

**Data sources (legal status):** official LLM provider APIs (OpenAI/Anthropic/Gemini/Perplexity) for prompt-sending ✅; GSC ✅; GA4 ✅; server-log bot analysis (user's own logs) ✅; GDELT ✅; CC-NEWS ✅. **Elmo — SELECTED (Tico, 2026-09-26) over in-house multi-LLM prompt-sending:** MIT-licensed (Copyright 2026 Blue Whale Software, LLC) — verified AGPL-compatible 2026-09-26; actively developed; self-hosted, unlimited prompts, BYO LLM API keys. Chat-UI scraping 🚫.

**Build-order rationale:** builds on Phase 6's already-correct methodology (versioned prompts, N-reps, per-engine reporting) — this phase adds the intelligence layer on top.

**Cost notes:** DIY prompt-sending via official APIs costs fractions of a cent per prompt at scale [ESTIMATE]; DataForSEO AI Optimization ($0.05/call) is the overflow path. Compare: Otterly $29/mo (15 prompts) → $489/mo; Profound $99/mo (50 prompts) → $399+; Ahrefs Brand Radar $199/mo add-on.

### M4 — Competitor change fleet

**Goal:** *semantic* competitor intelligence — not pixel diffs (solved commodity), but "what changed, why it matters, what to do."

**What it does:**
- **New-page discovery** (the hard part no vendor productizes): weekly competitor sitemap diffing + `lastmod` tracking → "competitor X published 14 new URLs this week." Google Alerts as the 30-second consumer-tool baseline for indexed new pages. Closest commercial analog is sitemap-change alerting (Hexowatch) — Marketr owns the joined version.
- **Self-hosted change detection** for tracked competitor URLs: changedetection.io pattern (free, self-hostable — the OSS escape hatch) rather than Visualping-class SaaS ($14–49/mo). Firecrawl OSS core or Crawlee for fetching.
- **AI summaries over diffs** — the current frontier, and shallow everywhere else: each detected change gets a semantic summary (what changed: pricing, positioning, new offer, new content cluster), a why-it-matters assessment tied to the user's tracked keywords (competitor gap module, Phase 1), and a recommended response routed to the relevant playbook/mission.
- **Review velocity** via licensed paths only: GBP API (owned listings) + Yelp Fusion + DataForSEO Business Data ($0.012–$0.05/task). Sentiment/complaint-theme mining on the user's *own* licensed data. No unlicensed review scraping — Reddit v. Anthropic gives ToS teeth, and review-scraping SaaS is ToS-gray enterprise software Marketr does not emulate.
- Weekly competitor digest (already in SPEC.md MVP scope, item 13 — this phase makes it real): publishing velocity, keyword gains (from Labs/SERP data), new SERP entries, pricing/offer changes.

**Non-goals:** pixel-diff monitoring as a standalone product (commodity); auto-discovering competitor pages without sitemaps/signals (no clean method exists — documented honestly); scraping G2/Capterra/Trustpilot at scale.

**Data sources (legal status):** competitor sitemaps ✅ (public); self-fetch of public pages ✅ (polite, robots-respecting); Google Alerts ✅ (consumer tool); licensed review APIs ✅; unlicensed review scraping 🚫.

**Build-order rationale:** after M6 (vendor abstraction) and M1 (GSC deltas feed the "why it matters" correlation). The fleet pattern reuses M6's crawling infra.

**Cost notes:** self-hosted fetching is ~$0 marginal; changedetection.io-class tooling is free. The cost is compute politeness, not API bills.

### M5 — Modeled difficulty engine

**Goal:** own the KD model — a differentiator no vendor sells. KD = f(median referring domains of top-10 SERP, authority gap, SERP-feature crowding).

**What it does:**
- Inputs, all obtainable: top-10 SERP per keyword (via M6's abstracted vendor layer) + authority signals per ranking domain (CC hyperlink graph domain PageRank/in-degree ✅, Open PageRank 30k free lookups/mo ✅, Moz free tier 2,500 rows/mo ✅) + SERP-feature composition (AIO presence, feature crowding from the same SERP pull).
- **Volume treated as a ±band, not point truth**, below an unstudied threshold [UNVERIFIED] — clickstream accuracy degrades for low-volume keywords and no vendor publishes an error curve. The model carries uncertainty through to the UI ("difficulty 32 ± 9, low confidence on volume").
- Quarter-over-quarter authority comparison from CC graph archives (years of history) as a trend input — the best production use of the graph found in research.
- Benchmarked against DataForSEO's `labs/bulk_keyword_difficulty` ($0.132/1K) as the paid reference — the model must beat or match it on a held-out eval set before it replaces the vendor call in any user-facing path.
- Writes versioned model artifacts; eval results are honest about uncertainty (the Phase 9 honest-attribution pattern).

**Non-goals:** page-level or anchor-text analysis from the CC graph (it has neither — domain-level only, no anchors, quarterly freshness); replacing vendor difficulty before the eval bar is met.

**Data sources (legal status):** CC hyperlink graph ✅ (~16GB one-time download, $0/query, confidence-capped at 0.50); Open PageRank ✅; Moz free tier ✅; SERP vendor data (licensed) ⚠️-edge per §2; DataForSEO bulk difficulty as paid benchmark ⚠️-edge per §2.

**Build-order rationale:** needs M6's vendor layer for SERP inputs and M1's GSC data for outcome labels (did keywords at predicted difficulty actually rank?). It's the purest "moat" module — own the model, rent the inputs.

**Cost notes:** replaces $0.132/1K vendor difficulty calls at scale once the eval bar is met; authority inputs are ~$0.

### M6 — Data-provider abstraction + volume cache (FOUNDATION)

**Goal:** the architectural spine everything else consumes. No module buys data except through this layer.

**What it does:**
- **Abstracted SERP vendor interface:** Serper ($1.00→$0.30/1K at volume; Google-only), DataForSEO Standard ($0.60/1K, credits never expire), TalorData ($1.00→$0.25/1K at scale; strongest AI-Overview detection at 64.5% in one 2026 benchmark [UNVERIFIED beyond that benchmark]). Swappable in days — the hedge against vendor death, price hikes (DataForSEO raised most rates ~20% on 2026-07-01 — single-supplier risk is real and growing), or legal events. Route by need: TalorData when AIO detection matters, Serper at volume for price, DataForSEO for breadth.
- **Cross-user keyword-volume cache** (the cost lever: $132/1M clickstream bulk, ~90% hit at scale [ESTIMATE]): **Tico decision (2026-09-26): proceed, no legal-review gate.** Conservative design posture regardless: 30–90 day TTLs, cache-invalidation-on-use, per-workspace attribution so the cache can be narrowed later if counsel ever weighs in.
- **Keyword Planner as primary volume path** where ToS allows (free; manager account; plan for the ~5-business-day manual Basic-access review; Explorer access blocks `KeywordPlanIdeaService` — documented in setup UX). Keyword Planner ToS allows product use; reselling raw Google data wholesale is restricted.
- **CSE shutdown sweep (2027-01-01):** dependency check across Marketr and documented BYO-key user setups — confirm nothing depends on Google CSE; migrate anything that does before the cutoff.
- **Demand-driven backlink verification fleet** (verifies *known* links cheaply: $6/mo beta → ~$1.4K/mo at 100K users [ESTIMATE]): seed discovery from the free CC graph (stale ~1 month) or one-time licensed API buys; new/lost deltas computed from scheduled DataForSEO Backlinks API pulls (~$0.02/pull per domain batch). Discovery of *new* links always needs an index or licensed data — documented, never hand-waved.
- **Data-cost circuit breakers:** per-workspace API-budget caps with alert + pause (the money-rules pattern applied to data spend — Phase 10 moves no client money, but it must not burn Marketr's margin either).
- **Serpstat dataset decision support:** the 1.7T-link / 170M-domain dataset (~$30.8K all-zones / ~$19.4K .com-only, one-time) remains the unique licensed backlink asset purchase. **Tico decision (2026-09-26): DEFERRED until more funding is available** — stays in reserve, not a foundation. Refresh/redistribution terms must still be verified in writing before any feature ever depends on it.

**Non-goals:** any cache design that locks before legal review; depending on unverified Serpstat terms; depending on CSE past 2027-01-01.

**Build-order rationale:** **build first.** Every other module consumes this layer (SERP inputs, volume, authority, cost metering). Getting the abstraction and the legal gate right up front prevents rework across M1–M5.

### M7 — Verification battery

**Goal:** prove the phase's two claims — rent went down, moat went up — and that no boundary line was crossed.

**What it does:**
- **Cost-tracking hooks:** meter every external API call per workspace per vendor; dashboard of data COGS per user per month vs. the pre-Phase-10 baseline. Targets (§8) are pass/fail gates.
- **Honest-labeling checks (M3):** automated tests that fail the build if any AI-visibility metric ships without confidence intervals, per-engine breakdown, and stability scores. No single-score regressions, ever.
- **Legal-boundary tests:** no calls to prohibited surfaces (assert no chat-UI scraping endpoints, no Maps/Reddit scraping, no Yelp Open Dataset code paths); cache TTLs within the approved policy; vendor abstraction intact (kill-switch test: swap the default SERP vendor in config, all consumers still work).
- **Difficulty-model evals:** held-out set vs. DataForSEO bulk difficulty; the model only replaces vendor calls when it meets the bar (§M5).
- **Radar accuracy:** backtest the platform-change radar against known 2026 rollouts (August 2026 Spam Update window) on demo properties — precision/recall of the impact mapping, and the docs-vs-algorithm classifier's false-positive rate.
- **Demo seeds:** GSC-connected demo property, versioned GEO prompt panel, competitor sitemap fixtures, CC-graph sample slice — so verification runs without live credentials.
- Standard: tsc clean, changed-file secret scan, production build green, preview health (`/` → 200, `/dashboard` → 307).

### M8 — Community engagement (Okara-style, draft-first)

**Goal:** find live conversations where the user's expertise is genuinely relevant, and draft replies worth posting — the community-visibility loop Okara proved, rebuilt on Marketr's approval philosophy. (Tico decision 2026-09-26: fold into Phase 10.)

**What it does:**
- **Opportunity discovery:** monitors Reddit (via official API with the user's own credentials — Reddit's public API wound down Sept 30, 2026, commercial pricing ~$12K/mo reported [UNVERIFIED], so the product never proxies Reddit at platform scale), Hacker News (Algolia HN Search API — free), and niche forums via RSS/Google Alerts. Finds threads where a competitor is mentioned, a question matches the user's expertise, or a launch moment is forming.
- **Draft-first, always:** the agent drafts the reply/post; it lands in the Phase 9 approval inbox; the human edits and posts natively. This is Okara's ban-safe pattern and it is also the legally safe one — Reddit v. Anthropic (Sept 2026) gave platform ToS contract-law teeth, and communities punish automation faster than any moderator does.
- **Taste guardrails:** drafts must be short, specific, and human-sounding (the Medium teardown consensus: over-polished AI replies get punished on Reddit/HN). A "would a person with context write this" check before anything reaches the inbox.
- **Closed loop:** posted replies tracked for upvotes/replies/traffic; outcomes feed M3's branded-mention tracking (community participation drives the mentions that correlate 0.66–0.71 with AI-assistant visibility) and Growth Memory.

**Non-goals:** autoposting without human approval; astroturfing or fake engagement; holding user credentials to post on their behalf without explicit per-account OAuth; scraping Reddit/Maps.

### M9 — Expert knowledge base ("think like expert marketers")

**Goal:** a vetted, versioned corpus of marketing expertise that the Chief Strategy Agent, missions, and playbooks retrieve from — so Marketr reasons with expert patterns, not just data. (Tico proposal 2026-09-26: ingest modern marketing courses, vetted books, platform courses like Meta Ads and Google Ads.)

**What it does:**
- **Ingestion pipeline:** PDF/docs → chunk → embed → versioned corpus, with per-source provenance. Retrieval is source-attributed in agent outputs ("per Meta's official documentation…", "per Google Search Central…").
- **Clean-sourcing tiers (binding):**
  - ✅ **Tier 1 — official platform materials:** Meta Blueprint, Google Skillshop, Google Search Central docs, Bing Webmaster guidelines, platform help centers. Free, official, licensed for learning — and the highest-value tactics sources.
  - ✅ **Tier 2 — openly licensed:** public-domain marketing classics, CC-BY materials.
  - ⚠️ **Tier 3 — Tico's own purchased materials:** courses/books he personally bought may feed *his private deployment only*. They do NOT ship in the AGPL repo or the commercial product without redistribution rights.
  - 🚫 **Never:** bulk-ingesting ripped/pirated course PDFs into the shipped product — the Anthropic $1.5B settlement (Sept 2026, pirated book corpora) is the exact pattern to avoid.
- **Licensing headline (verified 2026-09-26):** of all platform academies, **only Google Search Central is CC-BY 4.0** (shippable with attribution). Meta Blueprint, Google Skillshop, TikTok Academy, LinkedIn Marketing Labs are free-to-learn but all-rights-reserved; HubSpot Academy explicitly bans copying; Salesforce Trailhead explicitly bans scraping for AI training. The shipped corpus is therefore Tier 2-led; platform courses feed it only via original synthesis. (Full source list: `M9-CORPUS-SOURCES.md`.)
- **Day-1 seed set (15 sources, priority ingestion order):** Google Search Central docs (CC-BY 4.0) · *Foundations in Digital Marketing* — Grayson (CC-BY 4.0) · *Scientific Advertising* — Hopkins (PD) · *My Life in Advertising* — Hopkins (PD) · *Introducing Marketing* — Burnett (CC-BY 3.0) · *The Psychology of Advertising* — Scott (PD) · SBA Marketing & Sales guides (PD) · FTC .com Disclosures (PD) · Wikipedia marketing clusters (BY-SA, segregated asset) · marketskills GitHub (MIT) · marketing-without-money (CC0) · plus learn-only→synthesis: Meta Blueprint, Google Skillshop, TikTok Academy, LinkedIn Marketing Labs, CXL/Copyhackers blogs. **Full target: every non-paywalled source in `M9-CORPUS-SOURCES.md` (#1–24) is ingested** — the seed set is the priority order, not the ceiling. Ongoing source research (standing directive, 2026-09-26) keeps feeding new clean sources into the corpus.
- **Known gap:** expert paid-media/SEM depth has no safe open source — Tier 3 (Reforge/CXL/Demand Curve) fills it in the private overlay.
- **Learn vs. ingest — the precise boundary (clarified 2026-09-26):** copyright protects *expression*, not *ideas*. What the licenses/ToS forbid is **ingestion** — storing verbatim chunks of Meta Blueprint, Skillshop, HubSpot Academy, etc. in the shipped corpus (reproduction/distribution). What is fully permitted is **learning** — reading those courses, extracting the tactics and frameworks, and writing *original* playbooks that embody that knowledge, with factual attribution ("per Meta's official guidance…"). That is what every marketing book author does.
  - ✅ **Tier 1S — synthesized playbooks (shippable):** original playbooks written by the team (or agents) from learning Tier 1 sources. Ideas, tactics, frameworks, checklists — in our own words. Cite the source of the knowledge; never quote it at length.
  - ✅ Fair-use short quotation for factual claims, attributed.
  - ❌ Bulk verbatim ingestion of all-rights-reserved academy text into the shipped corpus.
  - ❌ Automated scraping of any site whose ToS forbids it (HubSpot §6.1 bans copying; Trailhead bans scraping for AI training). Synthesis is done from legitimately accessed material — no scrapers against ToS.
  - ❌ Confusing "the model summarized it" with training — summarizing with an LLM is not model training, but it doesn't launder a ToS-violating scrape either.
- **Consumers:** Chief Strategy Agent context enrichment, mission planning, playbook generation, content briefs — every agent that currently reasons from data alone gets an expert-patterns layer.
- **Prompt layer:** `EXPERT-CONSTITUTION.md` (v1, 2026-09-26) — the drop-in system prompts + few-shot reasoning exemplars that make frontier models reason in Marketr's expert style now. Four agents covered (Chief Strategy Agent, mission planner, playbook generator, content/brief), global hard rules prepended to each, 12 exemplars in SFT-ready input → trace → output shape. This file is also the specification for the future fine-tune trace dataset.
- **Eval:** a marketing Q&A benchmark (held-out, source-attributed answers); the corpus only grows when precision holds.

**Non-goals:** claiming expertise the corpus doesn't cover; unattributed regurgitation; ingesting anything whose redistribution rights aren't settled.

---

## 4. Safety invariants (structural, non-negotiable)

Carried from Phases 5/7/9 — Phase 10 changes none of them:

1. **Zero custody.** Phase 10 moves no money. Data-cost circuit breakers (§M6) protect Marketr's margin; they never touch client spend.
2. **Autopilot never buys.** No mission, playbook, or intelligence alert can authorize media spend.
3. **Propose/execute separation.** The radar and the fleet *report*; actions go through the Phase 9 approval executor with human-signed authority.
4. **The §2 boundary map is enforced in tests** (M7 legal-boundary tests), not just documented.
5. **Kill switches:** per-workspace data-collection pause, per-workspace API-budget cap, global vendor cutover.
6. **Audit everything:** every external API call metered and logged (this doubles as the cost-tracking source).
7. **Cross-tenant boundary:** the volume cache is keyed to never leak one tenant's queries to another's reporting (cache hits are aggregate-counted, never attributed).

---

## 5. UI (locked house style)

All new UI follows the locked references (StudioApp.tsx code, CRM tweet, better-ui + emil-design-eng skills). Phase 10 is backend-heavy; the UI surface is dashboards over dense data:

- **Intelligence / Radar page:** dense table of platform-change events (date, source, type badge [rollout / docs / volatility], affected pages count) + event detail with per-page impact deltas and confidence bands.
- **Rank intelligence:** GSC-sourced visibility tables (query × page × delta) with before/after windows; paid-SERP rows badged by source (GSC vs vendor).
- **AI visibility:** per-engine distribution charts with confidence intervals and stability scores — tables first, charts only where distributions need them. The honest-labeling contract applies to UI copy: "estimated range," never "score."
- **Competitor digest:** dense table of detected changes (competitor, change type, semantic summary, recommended response) + weekly digest view.
- **Difficulty:** keyword table with modeled difficulty, ± uncertainty band, and input provenance (which authority sources fed the estimate).
- **Data costs (agency/admin):** per-workspace API spend table — the margin dashboard.
- Lucide only, no emoji, light mode `#FAFAF7` shell, violet primaries/tabs, no teal/green buttons, borders for structure.

---

## 6. Data model (new tables)

- `data_source` — id, workspace_id, type (gsc / ga4 / serp_vendor / planner / cc_graph / llm_provider), config JSON (encrypted credentials), status, connected_at. (The registry M6's abstraction reads.)
- `serp_vendor_config` — id, workspace_id, vendor (serper / dataforseo / talordata), routing rules, monthly budget cap, status. (Vendor routing + circuit breaker.)
- `api_meter` — append-only: id, workspace_id, vendor, meter (serp_call / volume_lookup / ai_prompt / backlink_pull), quantity, cost_usd, period. (Cost tracking + billing input.)
- `volume_cache` — keyword hash, locale, volume_band (never a false-precision point value), source, fetched_at, expires_at (TTL 30–90 days per §M6 defensive posture), hit counts.
- `gsc_snapshot` — id, project_id, window_start, window_end, granularity (hourly/daily), rows (aggregated), pulled_at. (Rank truth store; raw row retention policy per cost.)
- `platform_event` — id, source (status_dashboard / search_central / bing_blog), event_type (rollout / docs_change / volatility), title, started_at, ended_at, url, classification_confidence.
- `page_impact` — id, platform_event_id, project_id, page, query, delta_clicks, delta_impressions, impact_score, confidence_band. (M2's correlation output.)
- `geo_prompt_panel` — id, workspace_id, engine, prompt_set_version, prompts JSON, cadence, n_reps. (M3 versioned panels.)
- `geo_observation` — id, panel_id, run_at, rep, brand_mentioned, citation_urls[], sentiment, stability metadata. (Never aggregated into a single score at write time.)
- `competitor_watch` — id, project_id, competitor_domain, sitemap_url, last_diff_at, new_urls[]. (M4 discovery state.)
- `competitor_change` — id, watch_id, url, detected_at, change_type, semantic_summary, why_it_matters, recommended_response, status.
- `difficulty_estimate` — id, keyword, locale, estimate, uncertainty_band, inputs_provenance JSON, model_version, evaluated_at. (M5 versioned outputs.)
- `link_verification` — id, workspace_id, target_url, source_url, status (verified / lost / unknown), checked_at. (Demand-driven fleet state.)

All workspace-scoped, RLS-isolated, matching Phase 8/9 conventions. No changes to existing tables. Raw GSC rows and crawl payloads get retention policies (the strategy doc's warning: retention policy is the real cost lever).

---

## 7. Build order (proposed)

1. **M6 — Data-provider abstraction + volume cache.** Everything consumes this. Tico approved proceeding on the cache (2026-09-26) with the defensive TTL posture. CSE shutdown sweep runs here.
2. **M1 — GSC-first rank intelligence.** Biggest COGS cut; produces the delta engine M2 needs.
3. **M2 — Platform-change radar.** Flagship greenfield; cheap, fast, zero legal exposure. Ship early for the visible moat.
4. **M5 — Modeled difficulty engine.** Needs M6's SERP inputs and M1's outcome labels; purest moat module.
5. **M3 — AI-visibility intelligence layer.** Builds on Phase 6's methodology; adds variance-aware reporting, citation tracking, first-party correlation.
6. **M9 — Expert knowledge base.** Feeds the agents that M3/M5 built; retrieval layer over the clean-sourced corpus.
7. **M4 — Competitor change fleet.** Reuses M6's fetching infra; semantic summaries over diffs.
8. **M8 — Community engagement.** Reuses the Phase 9 approval inbox; draft-first HN/Reddit opportunity loop.
9. **M7 — Verification battery.** Cost hooks, honest-labeling checks, legal-boundary tests, radar backtest, model evals, M8 taste-check evals, M9 Q&A benchmark, demo seeds, standard build gates.

**Why M6 before M1:** M1's residual paid-SERP layer, M5's SERP inputs, and M4's fetching all route through M6's abstraction. Building consumers first would bake in today's vendor assumptions — the exact single-supplier risk the strategy doc flags (DataForSEO's ~20% 2026-07-01 price rise).

---

## 8. Cost-reduction targets (pass/fail for M7)

From the strategy doc's cost curves (build-vs-buy, [ESTIMATE]s — re-verify before signing vendor terms):

| Scale | Buy path | Build path (Phase 10 target) |
|---|---|---|
| Beta (~50 users) | $474/mo | **≤ $107/mo** |
| 1K paying | $9,472/mo | **≤ $1,599/mo** |
| 10K paying | $94,720/mo | **≤ $11,706/mo** |
| 100K paying | $947,200/mo | **≤ $94,480/mo** |

Phase 10's direct contributions:
- **M1:** owned-site rank checks move from paid SERP (~$1.30/mo per heavy user at DataForSEO Standard; ~$0.65 at Serper volume) to ~$0 GSC cost for GSC-connected properties.
- **M5:** replaces $0.132/1K vendor difficulty calls once the eval bar is met.
- **M6 cache:** volume lookups bend toward ~90% cache hit at scale [ESTIMATE] against the $132/1M clickstream bulk cost.
- **Guardrail:** per hosted Pro user, data COGS stays within the $3–8/mo envelope that holds ~90% gross margin (SPEC.md §9 unit economics).

These are measured by M7's cost hooks against a pre-Phase-10 baseline — not claimed, proven.

---

## 9. Never-do list (carried from the strategy doc — binding)

1. **Web-scale backlink index** — seven figures + years; ruled out for good.
2. **Self-scraping Google SERPs** — ToS breach by Marketr itself + permanent SearchGuard arms race.
3. **Bulk-extracting any vendor's API to clone their database** — textbook ToS violation (usage-anomaly detection, legal liability, data rot).
4. **Yelp Open Dataset in the product** — academic-only license.
5. **Inventing search volume from thin air** — non-crawlable, period.
6. **Cache-as-shadow-database** — the defensive TTL posture (§M6) is mandatory; Tico accepted the residual §7.1 risk (2026-09-26).
7. **Depending on Google CSE past 2027-01-01** — shutdown confirmed; sweep in M6.

---

## 10. Open questions for Tico (not blocking the spec)

1. **Legal review budget:** ~~the DataForSEO §7.1 cache question~~ — RESOLVED 2026-09-26: Tico approved proceeding with the cache; no legal review. Defensive TTL posture stays in the design.
2. **Serpstat dataset:** RESOLVED 2026-09-26 — DEFERRED until more funding is available. Stays in reserve; terms verified in writing before anything ever depends on it.
3. **Rank-check frequency:** RESOLVED 2026-09-26 — Tico: keep weekly checks for long-tail tracked keywords (margin lever declined; refresh cadence wins).
4. **Elmo:** RESOLVED 2026-09-26 — Tico selected Elmo over in-house multi-LLM prompt-sending. MIT license verified AGPL-compatible; actively developed. Self-hosted with BYO LLM API keys.
5. **Branded-mention sources:** RESOLVED 2026-09-26 — Tico: use the most reliable source, licensed if that's what it takes. Free-only (GDELT/CC-NEWS) is the fallback, not the default.
6. **M9 source list:** which specific courses, books, and platform certifications should seed the Tier 1/2 corpus — and which Tier 3 materials (personally purchased) should feed the private overlay?

---

## 11. Decisions — LOCKED by Tico (2026-09-26)

- **The gap is rented data → own it.** Every data line is interrogated in the own-free → own-cheap → rent-cheaper order.
- **Legality: right up to the edge, never over.** The §2 boundary map is binding; the edge positions (§7.1 cache, vendor ToS exposure) carry explicit hedges; the 🚫 lines are enforced in tests.
- **Both goals, equally.** Rent reduction is measured (M7 cost hooks, §8 targets); the moat is the radar (M2), the honest AI-visibility layer (M3), the owned difficulty model (M5), and the semantic competitor fleet (M4).
- **Platform-change radar is in scope** and is the flagship module (M2).
- **M8 — Community engagement (Okara-style, draft-first)** folded into Phase 10 (Tico, 2026-09-26). Drafts land in the Phase 9 approval inbox; humans post natively. No autoposting, no astroturfing.
- **M9 — Expert knowledge base** added to Phase 10 (Tico proposal, 2026-09-26): a vetted, versioned RAG corpus over clean-sourced marketing expertise (Tier 1 official platform materials + Tier 2 openly-licensed; Tier 3 personally-purchased materials are private-overlay only; ripped/pirated PDFs never ship).
- **Polotno clone:** Tico (2026-09-26) decided the native creative editor — a Polotno (polotno.com, MIT open-source core) reference implementation — **replaces the Canva Connect integration**. This was already tracked as the "own open-source Canva alternative" later milestone (SPEC-PHASE2.md); it is now named and scoped as a later phase (Phase 12 candidate), not Phase 10.
