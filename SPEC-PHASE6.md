# SPEC — Phase 6: Authority & Relevance + Onboarding Intelligence Report

**Status:** SPEC — APPROVED by Tico 2026-09-25 (all 5 open questions decided). Not built.
**Date:** 2026-09-25
**Master plan ref:** `docs/MASTER-PLAN.md` — "Phase 6 — Authority & relevance (2 cycles)" + Onboarding Intelligence Report
**Research:** `docs/phase6-research.md` (outreach tooling, listings reality, AEO tracking + act, digital PR, review-site management — all 2026-grounded, five tracks with honest capability verdicts)

---

## 1. What Phase 6 builds

Six build tracks, in a hard order. **Nothing publishes without approval — that is the exit gate, not a feature.**

| Track | What | Why this order |
|---|---|---|
| **O1 — Guest-post outreach engine** | Prospect discovery, opportunity scoring, 3-depth sequence engine, sending via Smartlead/Instantly API, reply detection, suppression, placement verification + backlink monitoring | The ladder config is the product decision Tico locked; depth 3 needs 30+ day warmup before first send, so the engine must exist first |
| **O2 — Digital PR** | Query aggregation (HARO/Connectively/Qwoted/SOS/HAB2BW/#JournoRequest), keyword/expertise matching, deadline triage, draft workspace, relationship CRM-lite, coverage attribution | Humans send — the 2026 industry consensus (Muck Rack's own agent never sends without approval); aggregation + drafting is the automation win |
| **L1 — Listings/citations, honest three-tier** | Tier 1 API-real (GBP direct + Bing trusted-partner); Tier 2 Local Data Exchange evaluation as programmatic breadth backend; Tier 3 guided claim flows + citation-brief product for the long tail | Nobody has one-click-everywhere; the differentiator is gap analysis, tracking, and tier honesty, not fake automation |
| **A1 — AEO agent (track + act)** | Versioned prompt sets, weekly cadence, official LLM APIs only, N=3 reps, LLM-as-judge parsing, per-engine scoring, source-impact analysis; act leg: owned-domain GEO16 fixes via the supervised ladder, third-party sources → user action plans | Agents query LLMs, find the highest-impact sources, then act where possible or hand the user a concrete plan — Tico's directive, verbatim |
| **R1 — Maps/review-site agent** | AI-drafted review replies in an approval queue with ReviewReplyState polling, listing upkeep (hours/attributes/photos/posts), review-velocity orchestration, Apple/Bing sync + monitor | Google's April 2026 pre-publication moderation makes reply-state polling load-bearing; v1 is drafts-only, never auto-post |
| **I1 — Onboarding Intelligence Report** | Connect the stack → twelve audits + revenue opportunities → recommended 90-day Growth Plan (dashboard + PDF) | The wedge demo that sells the platform; most audit inputs already exist from Phases 0–5 |

### The core design decisions

1. **Outreach depth is user-customizable, not fixed.** A 3-depth ladder chosen per campaign/workspace: depth 1 = prospecting + scoring only; depth 2 = + AI-drafted pitches queued for human send; depth 3 = fully automated pitching. Each depth has its own trust-ladder gating. Depth 3 requires secondary domains, 30+ day warmup, and hard daily caps — it is infrastructure, not a config toggle.
2. **The Intelligence Report ships full on day one.** All twelve audits (company intelligence, market position, competitor map, website, brand, SEO, paid-media, reputation, conversion, CRM, content, technology) + revenue opportunities → 90-day Growth Plan. §2/I1 maps every audit to its existing data source.
3. **Listings are honestly three-tiered.** Tier 1 (API-real): GBP direct management — note the gating (Marketr needs its own 60+ day verified GBP to apply; 10 edits/min/profile cap is un-raisable) — plus Bing trusted-partner application. Tier 2: evaluate Local Data Exchange ($0.008/call, sandbox, 50+ publishers) as the programmatic breadth backend. Tier 3: guided "claim your free listing" flows (Apple Business Connect) + an honest citation-brief product for the long tail (competitor-gap analysis, pre-filled NAP payloads, tracked manual checklist). Every channel is labeled by its true tier in the UI — no fake "one-click everywhere" claims.
4. **The AEO act leg ships in Phase 6.** Versioned prompt sets (20–50 money prompts), weekly cadence, official APIs only (nano-class models), N=3 reps, LLM-as-judge parsing, per-engine reporting (no composite scores — 89% cross-engine citation divergence makes them un-actionable). Source-impact scoring via citation frequency + co-occurrence lift. Owned-domain sources → GEO16-pillar content fixes through the supervised fix-agent ladder (approval-gated). Third-party sources (Reddit threads, listicles, review sites, YouTube) → concrete user action plans with expected lift attached. **Excluded:** consumer-chat-UI scraping — ToS-violating, with real litigation teeth after Reddit v. Anthropic (Sept 2026).
5. **No autonomous publishing without approval.** Every external action in this phase — a depth-3 pitch send, a review reply post, a listing edit, an AEO content fix, a PR draft send — is approval-bound or human-executed. This is the phase exit gate and a §3.1 red-lane rule, not a configurable preference.
6. **Journalists are not prospects.** Guest-post outreach and journalist pitching are structurally different: journalists get ~50 pitches/week with long memories, and a bad pitch burns a relationship, not just a bounce. O2 enforces the journalist ruleset (no auto-send on client identity ever, max 2 follow-ups at 48h cadence, 1:1 sends never BCC, no attachments, humanize/de-AI pass, pitch-the-gap) as code, not guidelines.

---

## 2. Track-by-track build plan

### O1 — Guest-post outreach engine (the 3-depth ladder)

Build the engine; integrate sending. Pitchbox, Respona, and BuzzStream have no public REST APIs — their prospecting logic, sequence engine, reply detection, opportunity scoring, and placement verification are the build. Sending and warmup integrate via Smartlead or Instantly API (white-label-ready, ~$39/mo unlimited mailboxes — sidesteps Google's Gmail restricted-scope security assessment).

**The ladder config** (per campaign, chosen by the user; per workspace defaults):

| Depth | Name | What Marketr does | Trust-ladder gating |
|---|---|---|---|
| 1 | Prospecting only | SERP + contact discovery, Hunter.io email finding, opportunity scoring (site quality, relevance, traffic), no sending whatsoever | Scheduled — runs, reports, never sends |
| 2 | Drafts for human send | Everything in depth 1 + AI-personalized pitch drafts queued per prospect; human reviews, edits, and clicks send | Supervised — every send is a human click; drafts expire after 14 days unsent |
| 3 | Automated pitching | Everything in depth 2 + Marketr sends via Smartlead/Instantly: sequences, follow-ups (max 2), stop-on-reply, bounce handling | Supervised-with-rails — requires: secondary domains only, 30+ day warmup complete, SPF+DKIM+DMARC verified, daily caps enforced, suppression lists current |

**Depth-3 enablement checklist (all must be true, enforced in code):**
1. Sending domain is a secondary domain — primary domains are hard-blocked from cold sending.
2. Domain warmup ≥ 30 days with ramp history (10–20%/week) — skip-warmup sending is hard-blocked.
3. SPF + DKIM + DMARC (`p=quarantine` or `reject`) verified; custom tracking CNAME set.
4. No Gmail free accounts — Workspace/M365 or sending-partner inboxes only.
5. Daily caps: ≤ 30–50/day/mailbox (strict default 30); fresh mailboxes ramp 5–10/day.
6. Recipient country ≠ Canada for cold pitching (CASL consent requirement) — hard-blocked, not warned.
7. Physical mailing address + one-click unsubscribe (RFC 8058) on every template (CAN-SPAM: $53,088/email, 2026).

**Engine components:**
- **Prospect discovery:** SERP scraping for `"write for us" / "guest post" / "contributor guidelines"` + niche queries; contact discovery (site contact pages, whois fallback, Hunter.io API for email finding + verification).
- **Opportunity scoring:** domain quality (DR/Ahrefs-style via DataForSEO), topical relevance (embedding similarity to client niche), traffic estimate, outbound-link hygiene, "accepts guest posts" signal confidence. Score 0–100; threshold configurable per campaign.
- **Sequence engine:** per-depth templates with AI personalization (first-line + angle, never full-template generation — Gmail's 2026 AI catches mail-merged templates); automated follow-ups at depth 3 only (max 2, 48h+ cadence); stop-on-reply; bounce handling (<2% healthy, pause at 3–5%, hard stop >5%).
- **Deliverability monitoring:** Google Postmaster Tools API (domain/IP reputation, spam rate — target <0.10%, hard ceiling 0.30%); inbox placement tests via Instantly; shared synthetic warmup pools are banned (algorithmically detected footprints burn reputations — 2026).
- **Suppression:** global opt-out list (instant enforcement, 10-business-day CAN-SPAM honoring), per-campaign suppression, hard-bounce quarantine, reply-based auto-suppression.
- **Placement verification + backlink monitoring:** weekly backlink check per placed link — lost-link, nofollow-flip, and anchor-change alerts (the BuzzStream pattern, built in-house).

### O2 — Digital PR (query aggregation + drafting + tracking; humans send)

Do not build auto-sending, automated follow-up emailing, or media-database licensing in v1. The 2026 consensus — including Muck Rack's own Media List Agent — is *agent proposes, human approves*.

- **Opportunity feed:** ingest HARO/Connectively digests (HARO relaunched April 2025 under Featured; Connectively revived May 2026 — 100K users, 2,500 publishers), Qwoted, Source of Sources, Help a B2B Writer, #JournoRequest monitoring. De-dupe across sources, keyword-match against the client's expertise profile (from the Business Graph inputs / onboarding), deadline triage with same-day urgency flags. Note the quality context: revived HARO has AI-generated-response flooding — Marketr's matching and pitch-quality bar must sit *above* the platform average or placements won't convert; the trust gap is the opportunity.
- **Draft workspace:** per opportunity — journalist research brief (recent articles, beat, what they've already covered), pitch-the-gap analysis, quote skeleton (structured, not send-ready), pre-send checklist (guidelines checked, audience fit referenced, no attachments — paste text, link a Drive kit; subject ≤49 chars).
- **Humanize/de-AI pass:** journalists run AI detectors and are hypersensitive to AI signals (em-dash density, formulaic structure). Every draft gets a de-AI rewrite pass before it reaches the human.
- **Relationship CRM-lite:** per-journalist history, declination reasons, 90-day re-engagement windows, max-2-follow-up enforcement, exclusive/embargo flagging (embargoes are never automated — BCC = embargo-break risk; individual sends only).
- **Coverage attribution:** submitted → placed → visibility impact; placements feed the AEO source-impact scorer (a placed expert quote is a citable source).

### L1 — Listings/citations (honest three-tier)

**Tier 1 — API-real (build direct):**
- **Google Business Profile:** full management — locations, hours (regular/special/category-specific), attributes, categories, photo upload, local posts (Offers/Events/Updates; Recurrence Info supported since April 7, 2026), review replies (see R1). Design constraints: API access requires application (Marketr's own verified GBP active 60+ days + website — apply now, it gates everything); quota 0 QPM until approved, 300 QPM after; **hard 10 edits/min per profile cap** (un-raisable — queue edits accordingly). Verification (postcard/video) is owner-performed; the API only initiates/completes the flow. Q&A API discontinued Nov 2025 — do not build against it.
- **Bing Places:** trusted-partner application (email partneronbp@microsoft.com, sandbox first, then production) — the lightest major-channel gate. Free GBP import exists (rebuilt Oct 2025). Bulk NAP/hours/photo sync via API once approved.

**Tier 2 — Programmatic breadth (evaluate, prototype behind feature flag):**
- **Local Data Exchange:** API-first listings + reviews backend, ~$0.008/call, sandbox available, 50+ publishers day one, "under 30 days to first integration" — the closest thing to a plug-in citation backend for a small platform. v1: prototype behind a feature flag; promote to default only after sandbox validation of sync accuracy [APPROVED 2026-09-25 — §12.1].

**Tier 3 — Guided + brief (honest, no fake automation):**
- **Apple Business Connect:** guided "claim your free listing" walkthrough — the API is partner-only (~5 large platforms have access; Apple folded Business Connect into the wider Apple Business platform April 2026). No self-serve path; do not imply automation.
- **Citation brief product (the long-tail play):** competitor-gap analysis (the Whitespark trick — show exactly which directories the top-3 local competitors are listed on and the client isn't), pre-filled per-directory NAP payloads, tracked manual-submission checklist with a verification sweep. Priced as done-for-you or DIY — never as "automatic." The industry consensus: aggregator distribution for breadth + manual for high-value niche (TripAdvisor, Healthgrades, Avvo, Houzz, BBB) — ~20–40 hours for a 40–60-directory manual pass, which is exactly what the brief product organizes.
- **UI honesty rule:** every channel carries its true tier label — `API-synced` / `aggregator-distributed` / `manual submission` / `guided claim`. The differentiator is gap analysis, tracking, and owning listings — not fake automation.

### A1 — AEO agent (track + act)

**Track (the methodology, 2026-converged):**
- **Prompt sets:** versioned per client, 20–50 "money prompts" (buyer-intent comparisons, "best for…", troubleshooting — sourced from sales calls/support tickets), run verbatim on cadence. **Weekly default** (daily available at ~4.3× cost).
- **Engines, official APIs only:** GPT-5-mini/nano, Anthropic Haiku 4.5, Gemini 3.8 Flash, Perplexity Sonar (returns citations natively). **No consumer-chat-UI scraping** — violates Anthropic Consumer ToS §3(7) and OpenAI ToU 2(c)(iv); Reddit v. Anthropic (Sept 2026) gave ToS claims real litigation teeth. API-based tracking is a **proxy** of consumer surfaces (UI ≠ API completions) — disclose per-engine spread, never claim exact consumer-surface fidelity.
- **Repetition:** N=3 reps per prompt per engine; report mention *rate* (2/3 = 67%), not binary flags (the Lumora pattern).
- **Parsing:** native citations where available (Sonar, Claude web_search, Gemini grounding, OpenAI Responses web_search); otherwise **LLM-as-judge** on nano-class models extracting `{mentioned, position, sentiment, competitors, cited_sources}` as JSON — ~$0.00007/call. Judge routing: nano API default behind an abstracted judge interface [APPROVED 2026-09-25 — §12.3].
- **Cost:** ≈ **$1–5/mo per brand** (budget models; 30 prompts × 4 engines × 3 reps ≈ 360 generations + 360 judge calls); ≈ $15–40/mo with flagships. Token cost is trivial — vendors charge €89+/mo for regional infra and ops.
- **Scoring (per-engine only — no composite scores):** mention rate, Answer Share of Voice = (brand appearances ÷ total responses) × 100, recommendation rate, sentiment distribution, entity accuracy, source citation frequency by domain. The 89% cross-engine citation divergence (Profound, 100k prompts) makes composite scores un-actionable — per-engine reporting is mandatory.
- **AIO coverage route:** BYO DataForSEO SERP API (consistent with Marketr's self-hosted data strategy) vs. organic-rankings approximation (76.1% of AIO-cited URLs rank top-10 organic) with the gap labeled honestly [APPROVED 2026-09-25 — §12.2].

**Source-impact analysis (the "which sources matter" engine):**
1. **Citation frequency ranking:** aggregate cited domains/URLs across the prompt set; citation efficiency = citations per URL. (2026 benchmarks: listicles 1.89, YouTube 1.83, review platforms 1.23, Reddit 0.73.)
2. **Co-occurrence lift (the defensible impact metric):** P(brand recommended | source X cited) − P(brand recommended | source X not cited), per engine, over run history. High-lift domains are where effort pays.
3. **Page-level citability features** (GEO16 framework): Metadata & Freshness (r=0.68, +47% citation impact), Semantic HTML (r=0.65, +42%), Structured Data (r=0.63, +39%) — the concrete fix list for the act leg.

**Act (Tico's directive — agents find the highest-impact sources, then act or plan):**
- **Owned-domain sources** (client's own site/pages appearing — or failing to appear — in citations): generate specific content fixes from the GEO16 pillars (metadata/freshness, semantic HTML, structured data, query-matching headings — retrieval position is the #1 citation predictor: 58% at position 1 vs 14% at position 10; DA/backlinks show no positive correlation). Fixes flow through the existing **supervised fix-agent ladder**: propose → human approves → apply. Never autonomous.
- **Third-party sources** (Reddit threads, listicles, review sites, YouTube): Marketr cannot edit these — generate a **concrete user action plan** per source: the exact thread/entry to engage, the suggested contribution angle, the expected lift attached, and a deadline. ("Answer this Reddit thread," "claim/update this listicle entry," "earn a review on G2" — with the co-occurrence lift number next to each.)
- **Approval gates on all publishing.** The act leg proposes; the human approves. Same exit gate as everything else in this phase.

### R1 — Maps/review-site agent

**GBP review replies (API-real, approval-queue only in v1):**
- AI-drafted replies land in an approval queue — the human approves or edits; Marketr posts via the v4 `accounts.locations.reviews.updateReply` endpoint (reviews live on the legacy v4 API, never migrated to v1).
- **ReviewReplyState polling (load-bearing):** since April 2026, every reply is pre-publication moderated: `PENDING → APPROVED/REJECTED` (v4.9). ~12,000 replies were observed rejected in one ecosystem, with false positives (reviewer's legal name, exclamation marks). A REJECTED reply is silently blocked — the agent **queries reply state, not just submit**: poll to APPROVED; on REJECTED, auto-sanitize (strip likely triggers) and re-draft for human re-approval, escalating after 2 rejections.
- **Sentiment routing:** positives get instant drafts in-queue; negatives flagged urgent for human eyes first.
- **Pre-draft guardrails (hard blocks):** no staff names (banned April 17, 2026), no PII, no incentives language ("fake engagement, strictly prohibited" — formalized Dec 31, 2025), no keyword-stuffed templates, no review gating/filtering (routing unhappy customers away from Google is banned — frame sentiment funnels as "feedback triage," never suppression). Enforcement ladder is real: silent removal → "fake reviews removed" banner → restriction/suspension (2025: 292M reviews blocked/removed).
- **v2 (explicit per-business opt-in only):** configurable auto-post for 4–5★ reviews, mirroring Birdeye — **not in v1** [APPROVED 2026-09-25 — §12.5]. v1 is approval queue for everything, matching the no-autonomous-publishing exit gate.

**Listing upkeep (GBP API):** hours, attributes, categories, photo upload, local posts including recurring Events/Offers; review-media objects (customer review images, live since April 20, 2026) as a brand-intelligence surface; Pub/Sub new-review notifications → instant draft in the queue.

**Review velocity (2026-compliant):** builds on Phase 3's QR pages and triggers. CRM/PMS/POS transaction webhooks → SMS/email request at "smart timing" (inside an existing conversation thread — the highest-converting channel, within Google's four documented channels: receipts, thank-you emails, end-of-chat, in-store QR). NFC tap stands / location-specific QR codes. Sentiment-split funnels allowed only as feedback triage.

**Apple / Bing (monitor + sync, replies manual):** Apple Business Connect — listing sync + read/monitor; **review replies are NOT programmable** (the API returns an informative error — Apple Maps reviews aggregate from partner sources like Yelp; respond there). Bing Places — NAP/hours/photo sync via API; **no native review system at all** — reviews aggregate from TripAdvisor/Yelp/ThreeBestRated/Facebook; the agent redirects to the source platform.

### I1 — Onboarding Intelligence Report (full, day one)

**Connect:** website, GBP, GA4, Search Console, Meta, Google Ads, CRM, email platform, Shopify, social accounts — OAuth where available, using the credential-vault pattern from Phase 5. Missing connections degrade gracefully: the report labels each audit's data completeness (full / partial / unavailable) instead of faking it.

**The twelve audits → data-source map** (most inputs already exist from Phases 0–5):

| # | Audit | Primary data source (existing unless noted) |
|---|---|---|
| 1 | Company intelligence | Onboarding intake + website crawl + GBP profile data |
| 2 | Market position | Competitor radar + review ratings vs. competitors (Phase 0–2) |
| 3 | Competitor map | Competitor-gap analysis, keyword overlap (M1–M11 SEO stack) |
| 4 | Website | Site audit (SEO stack), page-speed, mobile, CRO heuristics (new: conversion-focused heuristics layer) |
| 5 | Brand | Creative Studio assets (Phase 4), messaging consistency analysis across site/ads/social (new: brand-consistency scorer) |
| 6 | SEO | Keyword research, rankings, content decay engine, AI visibility tracking (M1–M11) |
| 7 | Paid-media | Phase 5 buying data: pools, spend, attribution, lift dashboards (new: paid-efficiency audit pack) |
| 8 | Reputation | Review config/requests (Phase 3), ratings, velocity, sentiment distribution |
| 9 | Conversion | CRM pipeline data, stage conversion rates, lead scoring (Phase 1) (new: funnel-leak analysis) |
| 10 | CRM | Pipeline health, nurture sequence coverage, speed-to-lead (Phases 1, 3) |
| 11 | Content | Content engine output inventory, decay/refresh status, gap vs. competitor map |
| 12 | Technology | Stack detection via crawl (CMS, analytics, pixels, schema), integrations inventory (new: tech-audit crawler) |

**Report compiler:** twelve audits + revenue opportunities → one prioritized **90-day Growth Plan**, ranked by expected impact × effort, each initiative mapped to the Marketr module that executes it (a Phase 8/9 orchestrator input later). Output: dashboard view + PDF export. **This is the wedge demo — it is the most polished surface in the phase**, designed to be shown to a prospect in the first onboarding session.

---

## 3. Key flows

### F1 — Outreach campaign (ladder-gated)
1. User creates campaign, picks depth (1/2/3); depth 3 runs the enablement checklist — any failure blocks activation with the specific missing item.
2. Prospecting runs (depths 1–3): discovery → scoring → qualified prospect list for human review.
3. Depth 2: AI drafts per prospect → human edits/sends (drafts expire after 14 days).
4. Depth 3: sequences send via Smartlead/Instantly within caps; replies stop sequences; bounces trip circuit-breakers; placements verified weekly.
5. Every send at every depth links to its approval record (depth 2: per-send human click; depth 3: campaign-level approval + rail enforcement).

### F2 — Review reply (R1)
1. Pub/Sub new-review notification → sentiment classification → draft generated (guardrails applied pre-draft).
2. Draft lands in approval queue (positives: standard; negatives: urgent flag).
3. Human approves/edits → Marketr posts via v4 API → polls ReviewReplyState to APPROVED.
4. REJECTED → auto-sanitize + re-draft → human re-approves; 2nd rejection → human-only escalation.

### F3 — AEO act (A1)
1. Weekly run completes → per-engine scores + source-impact ranking (citation frequency + co-occurrence lift).
2. Owned-domain gaps → GEO16 fix proposals → supervised fix-agent ladder (propose → approve → apply).
3. Third-party opportunities → user action plans with expected lift + deadlines → tracked to completion.
4. Trend deltas week-over-week; regressions trigger investigation prompts.

### F4 — Intelligence Report (I1)
1. User connects stack (OAuth/vault) → per-audit data pull with completeness labels.
2. Twelve audits compile → revenue opportunities ranked → 90-day Growth Plan generated.
3. Human reviews, adjusts priorities → dashboard + PDF export. The plan becomes the client's operating baseline; deltas re-run monthly.

---

## 4. Data model (new tables)

- `outreach_campaigns` — workspace_id, name, depth (1|2|3), status, sending_domain_id, daily_cap, warmup_verified_at, auth_status_json, suppression_list_id, approval_id (depth 3), created_by
- `sending_domains` — workspace_id, domain, is_primary (bool; primary = never cold-send), spf_ok, dkim_ok, dmarc_policy, warmup_started_at, warmup_stage, tracking_cname_ok, status
- `outreach_prospects` — workspace_id, campaign_id, domain, url, contact_name, email, email_verified, quality_score, relevance_score, status (new|qualified|contacted|replied|placed|bounced|suppressed|declined)
- `outreach_sequences` — workspace_id, campaign_id, prospect_id, depth, steps_json, status, sent_count, reply_id, stopped_at
- `outreach_events` — sequence_id, ts, event (sent|opened|clicked|replied|bounced|unsubscribed|placement_verified), payload_hash (append-only)
- `suppression_lists` — workspace_id, kind (global|campaign), entries (hashed emails), source, ts
- `pr_opportunities` — workspace_id, source (haro|connectively|qwoted|sos|hab2bw|journo_request), journalist, outlet, query_text, deadline, match_score, expertise_tags[], status (new|matched|drafting|submitted|placed|declined|expired)
- `pr_drafts` — workspace_id, opportunity_id, research_brief_json, quote_skeleton, checklist_json, de_ai_passed (bool), status (draft|human_approved|sent)
- `pr_relationships` — workspace_id, journalist, outlet, history_json, declination_reasons[], reengagement_eligible_at
- `pr_placements` — workspace_id, opportunity_id, url, outlet, publish_date, visibility_impact_json
- `listing_channels` — workspace_id, channel (gbp|bing|apple|yelp|...), tier (api_synced|aggregator|manual|guided_claim), status, last_sync_at, last_verified_at, sync_errors_json
- `listing_profiles` — workspace_id, channel, location_ref, nap_json, hours_json, attributes_json, photos_json, verification_status
- `citation_briefs` — workspace_id, competitor_gap_json, directories_json (directory, prefilled_nap, status, verified_at), checklist_status
- `review_queue` — workspace_id, location_ref, review_id, source (gbp|apple|...), rating, sentiment, draft_reply, guardrail_flags[], status (pending|approved|posted|rejected|escalated), reply_state (per Google moderation), posted_at
- `review_velocity` — workspace_id, location_ref, requests_sent, reviews_received, velocity_7d, velocity_30d, funnel_json
- `aeo_prompt_sets` — workspace_id, version, prompts[] (20–50), created_by, active
- `aeo_runs` — workspace_id, prompt_set_version, engine, started_at, completed_at, reps (3), status
- `aeo_mentions` — run_id, prompt_idx, rep, mentioned (bool), position, sentiment, competitors[], cited_sources[], judge_model, judge_confidence
- `aeo_source_impact` — workspace_id, engine, domain, citation_frequency, citation_efficiency, cooccurrence_lift, computed_at
- `aeo_actions` — workspace_id, kind (owned_fix|third_party_plan), source_ref, geo16_pillars[], fix_proposal_json | action_plan_json, expected_lift, status (proposed|approved|applied|done|dismissed), approval_id
- `intelligence_reports` — workspace_id, version, audit_completeness_json, audits_json (12), opportunities_json, plan_90d_json, pdf_url, generated_at, generated_by

All tables workspace-isolated with battery-proven cross-workspace denials. No email content from prospects stored beyond reply classification. No reviewer PII beyond what the platform APIs return.

---

## 5. API routes

All under `app/api/authority/*` (the authority & relevance namespace).

**O1 — Outreach:**
- `POST /api/authority/outreach/campaigns` · `GET /api/authority/outreach/campaigns/:id` · `POST /api/authority/outreach/campaigns/:id/activate` (runs the depth-3 enablement checklist; any failure blocks with the specific missing item)
- `POST /api/authority/outreach/campaigns/:id/prospects/discover` · `GET /api/authority/outreach/prospects` · `POST /api/authority/outreach/prospects/:id/qualify`
- `POST /api/authority/outreach/sequences/:id/draft` (depth 2) · `POST /api/authority/outreach/sequences/:id/send` (human click at depth 2; rail-checked dispatch at depth 3)
- `GET /api/authority/outreach/deliverability` (Postmaster reputation, spam rate, bounce rate, warmup stage per domain)
- `POST /api/authority/webhooks/smartlead` · `POST /api/authority/webhooks/instantly` (reply/bounce/open events; signature-verified, idempotent, stop-on-reply enforced)

**O2 — Digital PR:**
- `POST /api/authority/pr/opportunities/ingest` (digest parsing + monitoring) · `GET /api/authority/pr/opportunities` (matched, deadline-triaged)
- `POST /api/authority/pr/opportunities/:id/draft` (research brief + pitch-the-gap + quote skeleton + checklist + de-AI pass)
- `POST /api/authority/pr/drafts/:id/approve` (human; drafts never send themselves)
- `GET/POST /api/authority/pr/relationships` · `POST /api/authority/pr/placements`

**L1 — Listings:**
- `POST /api/authority/listings/channels/:channel/connect` (OAuth: GBP `business.manage`, Bing partner) · `GET /api/authority/listings/channels` (tier labels, sync status)
- `POST /api/authority/listings/profiles/:id/sync` (queued, respecting the 10-edits/min GBP cap) · `GET /api/authority/listings/profiles/:id/verify`
- `POST /api/authority/listings/lde/evaluate` (feature-flagged sandbox probe) [§12.1]
- `POST /api/authority/listings/briefs` (competitor-gap → pre-filled NAP → tracked checklist) · `POST /api/authority/listings/briefs/:id/verify-sweep`

**R1 — Reviews:**
- `GET /api/authority/reviews/queue` · `POST /api/authority/reviews/:id/approve` · `POST /api/authority/reviews/:id/post` (approval-bound; then polls ReviewReplyState)
- `GET /api/authority/reviews/:id/reply-state` (PENDING/APPROVED/REJECTED)
- `POST /api/authority/webhooks/gbp` (Pub/Sub new-review notifications; signature-verified, idempotent)
- `POST /api/authority/reviews/velocity/trigger` (CRM/POS webhook → smart-timing request)

**A1 — AEO:**
- `POST /api/authority/aeo/prompt-sets` (versioned) · `POST /api/authority/aeo/prompt-sets/:id/activate`
- `POST /api/authority/aeo/runs` (weekly scheduler + on-demand) · `GET /api/authority/aeo/runs/:id` (per-engine scores, never composite)
- `GET /api/authority/aeo/source-impact` (citation frequency + co-occurrence lift, per engine)
- `POST /api/authority/aeo/actions` (owned-fix proposals → ladder; third-party plans) · `POST /api/authority/aeo/actions/:id/approve`

**I1 — Intelligence Report:**
- `POST /api/authority/intelligence/connect` (stack OAuth/vault) · `GET /api/authority/intelligence/completeness`
- `POST /api/authority/intelligence/reports` (compile 12 audits → opportunities → 90-day plan) · `GET /api/authority/intelligence/reports/:id` · `GET /api/authority/intelligence/reports/:id/pdf`

---

## 6. UI routes

- `/dashboard/authority` — command center: outreach health, PR pipeline, listing sync status, AEO per-engine trend, review queue depth, report status
- `/dashboard/authority/outreach` — campaigns list + ladder-depth config per campaign; the depth-3 enablement checklist as a visible gate; deliverability dashboard (reputation, spam rate, bounce, warmup)
- `/dashboard/authority/outreach/campaigns/:id` — prospects with quality/relevance scores, sequence status, reply inbox, placement verification
- `/dashboard/authority/pr` — opportunity feed (deadline-triaged, same-day urgency flags), draft workspace, relationship CRM-lite, placements with coverage attribution
- `/dashboard/authority/listings` — channels with true tier labels (`API-synced` / `aggregator-distributed` / `manual submission` / `guided claim`), sync/verification status, citation-brief builder
- `/dashboard/authority/aeo` — per-engine dashboards (mention rate, Answer Share of Voice, sentiment — no composite scores), source-impact ranking with co-occurrence lift, action plans with expected lift
- `/dashboard/authority/reviews` — approval queue (positives standard, negatives urgent), reply-state tracking (PENDING/APPROVED/REJECTED), velocity dashboard, listing upkeep
- `/dashboard/authority/intelligence` — the report: twelve audits with completeness labels, revenue opportunities ranked, 90-day Growth Plan, PDF export
- Settings → Authority: sending domains + warmup status, Smartlead/Instantly linkage, GBP/Bing connections, AEO engine selection + prompt-set management, review reply defaults, depth-3 policy

---

## 7. MVP scope

**In:**
- O1: prospect discovery, Hunter.io email finding + verification, opportunity scoring, 3-depth ladder with the depth-3 enablement checklist hard-gated, sequence engine (follow-ups depth-3 only, max 2), Smartlead/Instantly integration for sending + warmup, MillionVerifier/ZeroBounce verification, Postmaster Tools deliverability monitoring, suppression lists (instant), bounce circuit-breakers, placement verification + backlink monitoring (lost/nofollow/anchor alerts)
- O2: multi-source opportunity ingestion + de-dupe, expertise keyword matching, deadline triage, draft workspace (research brief, pitch-the-gap, quote skeleton, pre-send checklist, de-AI pass), relationship CRM-lite (history, declinations, 90-day re-engagement, max-2-follow-up enforcement), coverage attribution; humans send everything
- L1: GBP direct management (apply for API access now; 10-edits/min queueing; owner-side verification flow), Bing trusted-partner application + sync, LDE prototype behind feature flag [§12.1], Apple guided-claim flow, citation-brief product (competitor gap, pre-filled NAP, tracked checklist, verification sweep), tier labels on every channel
- A1: versioned prompt sets (20–50), weekly scheduler, 4 engines via official APIs, N=3 reps, nano-judge parsing behind abstracted interface [§12.3], per-engine scoring (no composites), source-impact (citation frequency + co-occurrence lift), owned-domain GEO16 fixes via supervised ladder, third-party user action plans with expected lift; DataForSEO AIO route [§12.2]
- R1: GBP review-reply approval queue (v1: everything approved, no auto-post), ReviewReplyState polling with sanitize-and-redraft on REJECTED, sentiment routing, pre-draft guardrails, listing upkeep (hours/attributes/photos/recurring posts), Pub/Sub notifications, review-media intelligence surface, smart-timing velocity triggers, Apple/Bing sync + monitor (replies manual)
- I1: stack connector (OAuth/vault), twelve audits with completeness labels, revenue opportunities ranked by impact × effort, 90-day Growth Plan mapped to executing modules, dashboard + PDF export — the most polished surface in the phase
- Exit gates: deliverability safeguards battery, placement-tracking accuracy battery, no-autonomous-publishing adversarial battery

**Out (non-goals):**
- Autonomous publishing of any kind (standing — the exit gate)
- Depth-3 sending on primary domains, Gmail free accounts, or to Canada (hard-blocked, not deferred)
- Media-database licensing (Muck Rack/Cision seats are the enterprise moat; Marketr competes on matching + drafting + tracking)
- Auto-posting review replies in v1 (v2, explicit per-business opt-in only) [§12.5]
- Consumer-chat-UI scraping for AEO (ToS-violating; excluded permanently)
- Cross-engine composite AI-visibility scores (89% divergence — un-actionable by construction)
- Apple review replies via API (doesn't exist — monitor-only, honestly labeled)
- Footfall-style probabilistic attribution for listings work (directional reporting only)
- Gmail API direct sending (partner route chosen — sidesteps the security assessment) [§12.4]

---

## 8. Monetization (per master plan §4)

- **Hosted:** outreach tier (per-mailbox sending via partner passthrough + margin; depth-3 as the upsell — it requires the deliverability infrastructure); PR as agency seat add-on; listings tier (GBP/Bing management bundled; citation-brief as done-for-you product); AEO tracking per-brand (~$1–5/mo cost, tier-priced); Intelligence Report as the trial-to-paid wedge (first report free, subsequent/refresh paid or tiered).
- **Self-hosted:** bring your own Smartlead/Instantly, Hunter.io, DataForSEO, LLM keys; Marketr charges nothing on send volume.
- **Metering:** new meters for outreach sends, AEO runs, report compilations ride the existing credit ledger; partner passthrough costs (Smartlead, verification APIs, LDE calls) tracked separately from Marketr margin — never mixed (MASTER-PLAN §3.3).
- The Intelligence Report is the cheapest acquisition in the phase — twelve audits from data Marketr already holds, compiled once, demoed forever.

---

## 9. Safety invariants

These are structural, not configurable. A build that violates any of them fails the phase.

1. **No autonomous publishing without approval.** Every external action — depth-3 pitch sends, review reply posts, listing edits, AEO content fixes, PR draft sends — is approval-bound or human-executed. This is the exit gate.
2. **Depth 3 is infrastructure, not a toggle.** Secondary domains only, 30+ day warmup with ramp history, SPF+DKIM+DMARC verified, daily caps enforced. The enablement checklist runs in code; any failure blocks activation with the specific missing item.
3. **Primary domains never cold-send.** Neither do Gmail free accounts. Canada cold pitching is hard-blocked (CASL). These are blocks, not warnings.
4. **Deliverability ceilings are law.** 30–50/day/mailbox (strict default 30); bounce <2% healthy, pause at 3–5%, hard stop >5%; spam complaints <0.30% (target <0.10%); one-click unsubscribe on every template; physical address on every template (CAN-SPAM: $53,088/email).
5. **Suppression is instant.** Opt-outs, hard bounces, and replies suppress within the same processing cycle — never the next batch.
6. **Review replies are moderated by Google, not just sent.** Poll ReviewReplyState to APPROVED; REJECTED triggers sanitize-and-redraft with human re-approval; double rejection escalates to human-only. Pre-draft guardrails block staff names, PII, incentives language, and keyword-stuffed templates.
7. **Journalists are never auto-pitched.** No auto-send on client identity, ever — fake-identity outreach is an active reputational hazard (2026). Max 2 follow-ups at 48h+ cadence; 1:1 sends, never BCC; no attachments; humanize/de-AI pass on every draft; pitch-the-gap against what they already covered.
8. **AEO uses official APIs only.** No consumer-chat-UI scraping — ToS-violating with litigation teeth (Reddit v. Anthropic, Sept 2026). API-based tracking is labeled as a proxy of consumer surfaces.
9. **No composite AI-visibility scores.** 89% cross-engine citation divergence makes them un-actionable; per-engine reporting is mandatory. AEO numbers are directional — the per-engine spread is itself the metric.
10. **Listings honesty is a UI rule.** Every channel carries its true tier label. Apple review replies are monitor-only (no API exists); Bing has no native reviews (redirect to source platforms). Implying otherwise is a spec violation.
11. **§3.1 red-lane rules apply.** Money and reputation actions never reach autopilot; the lighter-approval lanes from Phase 5 do not extend to publishing. Everything is workspace-isolated and audit-logged.

---

## 10. Success metrics / exit gates

1. **Deliverability safeguards battery green 3×:** skip-warmup send attempt blocked; primary-domain send attempt blocked; Canada cold-pitch attempt blocked; Gmail-free-account attempt blocked; cap-exceed attempt blocked; bounce-rate >5% trips hard stop; suppression applied same-cycle; Postmaster spam-rate alert fires.
2. **Placement-tracking accuracy battery green 3×:** placed backlink detected; lost-link / nofollow-flip / anchor-change alerts fire; PR submitted → placed → visibility attribution chain completes; listing-verification sweep detects NAP drift.
3. **No-autonomous-publishing adversarial battery green 3×:** auto-send attempt at depth 1 and depth 2 blocked; review-reply post attempt without approval blocked; AEO content-fix apply attempt without approval blocked; PR draft send attempt without approval blocked; depth-3 activation with incomplete checklist blocked (each missing item named).
4. **ReviewReplyState loop proof:** PENDING → APPROVED poll completes; simulated REJECTED triggers sanitize-and-redraft with human re-approval.
5. **AEO E2E:** versioned prompt set → weekly run (N=3, 4 engines) → per-engine scores → source-impact ranking (co-occurrence lift computed) → owned-fix proposal through the ladder + third-party action plan with expected lift. Cost per brand verified within the $1–5/mo envelope.
6. **Intelligence Report E2E:** connected stack → twelve audits with completeness labels → ranked opportunities → 90-day Growth Plan → dashboard + PDF export. Missing connections degrade to labeled partial, never fabricated.
7. **GBP edit-cap proof:** 10-edits/min/profile cap respected under burst (queue, don't drop).
8. **Tenant isolation proofs:** cross-workspace access denials on prospects, sequences, listings, prompt sets, reports.
9. Standing bar: TypeScript clean, production build green, M11 security battery green, module batteries green ×3, secret scan clean, independent verification before commit.

---

## 11. Honest limitations

- **Depth 3 sells a setup, not instant volume.** 30+ day warmup before the first production send, secondary domains to buy and warm, 30–50/day/mailbox ceilings. The product must be honest about the ramp or churn will eat it.
- **No media-database licensing play.** Muck Rack ($5K–$53K/yr, no trial) and Cision own the database moat. Marketr competes on matching, drafting, and tracking — a better workflow on rented data, not a proprietary database.
- **HARO/Connectively quality decay.** AI-generated responses are flooding the revived platforms; Marketr's matching and pitch-quality bar must exceed the platform average or placements won't convert. The trust gap is the opportunity, but it's also the risk.
- **Apple review replies don't exist as an API** — monitor-only in v1, honestly labeled. Bing has no native reviews at all.
- **AEO numbers are directional.** API completions ≠ consumer chat UI; per-engine spread is the metric. Never present a single "AI visibility score" as ground truth.
- **GBP API is gated, not open.** Marketr needs its own 60+ day verified GBP + website to apply; quota starts at 0 QPM; the 10-edits/min cap is un-raisable. Apply on day one of the build.
- **Citation aggregators are reseller-gated.** Data Axle, Localeze, and Foursquare have no self-serve reseller path; programmatic breadth comes via the LDE evaluation or the concierge brief, not direct deals.
- **AIO coverage via DataForSEO is a paid third-party route** — client queries route to a vendor; the organic-approximation fallback has an honestly labeled gap.
- **Review solicitation enforcement is real.** Google's 2026 ladder (silent removal → fake-review banner → suspension) means the velocity engine must stay inside the four documented channels and never gate unhappy customers.

---

## 12. Open questions

1. **[APPROVED 2026-09-25] Local Data Exchange: prototype in v1 behind a feature flag.** Recommendation: **yes.** $0.008/call, sandbox available, 50+ publishers day one, small-platform friendly — the fastest honest path to programmatic citation breadth without enterprise deals. Risk is low (flagged, sandbox-first); the alternative is GBP+Bing direct only with the long tail fully manual in v1.
2. **[APPROVED 2026-09-25] AIO coverage route: BYO DataForSEO.** Recommendation: **BYO DataForSEO SERP API.** Consistent with Marketr's self-hosted data strategy (self-hosted = BYO keys, hosted = bundled with margin); the organic approximation (76.1% of AIO-cited URLs rank top-10) stays as the honestly-labeled fallback for keyless setups.
3. **[APPROVED 2026-09-25] Judge-model routing: nano API default.** Recommendation: **nano-class API (e.g., GPT-5 nano) as the default, behind an abstracted judge interface.** Keeps the $1–5/mo/brand economics with zero ops burden; self-hosters can swap in Ollama for zero-egress parsing. (Note: Gemini free tier prohibits confidential data — never the default route.)
4. **[APPROVED 2026-09-25] Sending partner (Smartlead/Instantly).** Recommendation: **partner — Smartlead/Instantly.** Direct Gmail API means budgeting for Google's restricted-scope security assessment; the partner sidesteps it entirely, brings white-label-ready warmup + inbox rotation, and costs ~$39/mo unlimited mailboxes. Build the engine, rent the pipes.
5. **[APPROVED 2026-09-25] 4–5★ review auto-post: v2-only.** Recommendation: **v2-only.** v1 is approval queue for everything, matching the no-autonomous-publishing exit gate. Birdeye proves the market tolerates configurable auto-post, but Marketr earns that trust after the moderation-state loop is battery-proven in production — not before.
6. **License/module split** — still parked per standing decision; resurfaces pre-public/commercial distribution (the outreach and AEO engines are commercial-tier candidates per MASTER-PLAN §4.2).
7. **GBP API application timing** — apply on day one of the build (needs Marketr's own 60+ day verified GBP + website); the gating clock is the critical path for Tier 1 listings.
8. **Bing trusted-partner application** — apply in parallel with GBP; lightest major-channel gate, sandbox first.
