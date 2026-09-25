# Phase 5 Research — Media Buying v1

**Research date:** 2026-09-24 (all tracks). Source dates noted per item. Web research only — no vendor was contacted; AdQuick outreach remains parked per the user's explicit decision.

**Locked decisions (not re-litigated here):**
- **Client-driven spend.** Marketr never holds client funds. Spend flows from the client's own accounts/cards; Marketr is planner + executor with approvals, never custodian.
- **Buying path order:** DOOH planner + Blip/Blindspot concierge first, then radio/newspaper/magazine concierge. AdQuick API buying is PARKED (no BD outreach, no AdQuick code).
- **Approval model:** per-buy approval by default; optional pre-approved budget pools/caps enabling lighter approval within the cap. Autopilot never buys media.
- **Attribution lean:** per-placement QR/pURL (extends the existing physical-attribution kit) with campaign rollup.

---

## Track 1 — DOOH buying landscape

### Blip (blipbillboards.com)
- **Model:** self-serve per-play ("per blip") marketplace for US digital billboards. Blip = 7.5–10s display on a rotating board. From **$0.01/blip**, dynamic by time/location/demand; no minimums, no contracts; daily budgets from ~$20. Network: 2,700+ boards, 46 states (Blip FAQ, updated ~July 2026).
- **API:** none found for buyers. Web self-serve only. A 2019-era Watchfire integration is sell-side, not a buy-side API.
- **Agency support:** explicit free agency reseller program (no minimum spend) for managing multiple clients/markets/budgets/schedules — maps cleanly onto a planner + approval-flow tool: plan in Marketr, execute in the client's Blip account.
- Sources: https://www.blipbillboards.com (FAQ); https://www.blipbillboards.com/agencies/

### Blindspot (seeblindspot.com, TPS Engage)
- **Model:** self-serve programmatic DOOH marketplace: 3M+ screens, 50+ countries, bookable by the hour, per-play pricing from ~$0.23/play (Times Square ~$40/play). No minimums, no retainers. AI planner "Blinky" builds and books plans free; advertisers pay media only. 25,000+ advertisers claimed (June 2026).
- **API:** the published "Blindspot Pull API" is **device-facing (sell-side)** — screens pull creative and log proof-of-play (OpenAPI 3.0 at tpsengage.github.io/BlindspotPullApi). No public buy-side API. A comparison table credits "Triggers … API" at the planner layer — worth a sales inquiry later, not a self-serve key today.
- Sources: https://seeblindspot.com/; https://seeblindspot.com/answers/; https://seeblindspot.com/best-dooh-platforms/ (July 2026)

### Vistar Media & Place Exchange (programmatic DOOH infrastructure)
- Both are **SSP/exchange infrastructure**, not buyer tools. Vistar = open RTB exchange + SSP + ad server (+ its own DSP); Place Exchange = pure programmatic OOH SSP. Buyers reach inventory **only through a DSP seat** (open exchange or PMP deals).
- **Small-agency access in 2026** runs through SMB-friendly DSPs: StackAdapt (self-service, "no monthly minimums" per agency marketing, published DOOH CPM $2–$15, demo-led onboarding); Basis Technologies (integrates Vistar supply); Displayce (claims self-serve, minimums unpublished); Adomni (AI self-serve "Jeen AI", Aug 2025 removed spend minimums, credit-card signup, five-minute setup). The Trade Desk / DV360 / Yahoo expose DOOH inside omnichannel plans — but **seat + enterprise relationship required; no public self-serve; no third-party API Marketr could call** without an agency trading seat.
- Sources: https://www.vistarmedia.com/blog/understand-programmatic-dooh-transactions (Sept 2026); https://www.vistarmedia.com/news/basis-technologies-and-vistar-media-automate-dooh; https://www.globenewswire.com/news-release/2025/08/19/3135628/0/en/AdOmni-Supercharges-Ads-Platform-Launching-AI-Driven-Self-Serve-Campaigns-in-Minutes.html (Aug 2025); https://streetfightmag.com/2025/08/21/for-dooh-start-with-where-the-screen-is/ (Aug 2025)

### Broadsign
- Leading DOOH ad-tech platform: SSP (Reach) + ad server + CMS/sales tooling. Reach APIs are the SSP's inventory-side API used by buying platforms — **not a public buyer login**. Buy-side accessible only through partner DSPs or marketplaces. Never directly buy-side accessible.
- Sources: https://www.media4growth.com/metrics/audience-data-measurement/broadsign-adquick-partner-to-facilitate-hyper-targeted-dooh-campaigns-4282-55442; https://www.media4growth.com/dooh/digital-network/broadsign-adform-streamline-global-programmatic-omnichannel-media-buys-4420-55699

### Pricing models & 2026 CPM ranges
- Per-play: Blip from $0.01/blip; Blindspot from ~$0.23/play.
- Programmatic CPM: StackAdapt $2–$15; Growth Channel benchmarks $2–$7 typical, blended avg $11.07 (Oct 2025); AdQuick digital CPMs $3–$15; OAAA/Place Exchange large-campaign analysis $7.49. (Denominators differ — impression-multiplier methods vary; compare with caution.)
- Traditional: 4-week flights on weekly rate cards; AdQuick campaigns typically $5K–$100K+.
- Sources: https://seeblindspot.com/dooh-cpm-benchmarks/ (July 2026); https://billboardinsider.com/dooh-delivers-10x-more-cpm-than-a-super-bowl-ad/ (2025)

### Track 1 verdict — capability table

| Vendor | Buy-side API | Self-serve web | Concierge / sales-gated |
|---|---|---|---|
| Blip | ❌ | ✅ no minimums | agency reseller program |
| Blindspot | ❌ (sell-side Pull API only) | ✅ no minimums | managed tier $10K+/city |
| Adomni | ❌ | ✅ no minimums, credit card | — |
| StackAdapt | ❌ (DSP seat only) | ⚠️ demo-led | demo gate |
| Displayce | ❌ | ⚠️ claims self-serve | minimums unpublished |
| Vistar Media | ❌ (SSP infra) | ❌ | enterprise / via DSP seat |
| Place Exchange | ❌ (SSP only) | ❌ | via DSP seat only |
| The Trade Desk / DV360 | ❌ | ❌ | seat + enterprise |
| Broadsign | ❌ (sell-side infra) | ❌ | partner-only |

**Honest bottom line: as of Sept 2026, no DOOH vendor in this set exposes a public buy-side API.** Everything purchasable today is self-serve web UI (Blip, Blindspot, Adomni) or sales/DSP-seat-gated infrastructure.

---

## Track 2 — AdQuick status check (public info only; no outreach made)

- **Product:** largest vendor-neutral US OOH marketplace — plan, price, buy, measure billboards, DOOH, transit, street furniture, place-based screens, wallscapes across ~1,500+ media owners (Lamar, OUTFRONT, Clear Channel), plus programmatic DOOH via Broadsign, Vistar, Place Exchange, VIOOH, Hivestack integrations. Also functions as a DOOH DSP ("all of DOOH live in minutes," 1.5M+ screens, 200+ publishers). Self-described "universal adapter" — one plan, one PO, Geopath-verified impressions, attribution built in.
- **API posture: real API, partner-gated.** Official API page (adquick.com/api, crawled Sept 2026) offers end-to-end campaign automation across "nearly 100% of OOH coverage in the US," but the CTA is "contact us to discuss" — **no public developer docs, no self-serve key signup** (confirmed via APITracker, ~July 2026: no docs, no sandbox, no free developer account). Third-party aggregator claims (APIs.io / API Evangelist "partner REST API" and "hosted MCP server") are **unconfirmed** — their own GitHub profile (created 2026-07-23, 0 stars) states "This is not our API… a lead awaiting the enrichment pipeline." Related but distinct: AdQuick + Circle Graphics opened an OOH **production** API (~July 2026) for creative workflow, not media buying.
- **Small-agency buying today: genuinely self-serve.** AdQuick's own guides: *"no minimum spend, and you can self-serve the entire booking process"* — neighborhood digital from ~$10/day, bus-shelter buys under $1,000/month, digital live in ~48h after creative approval. Programmatic DSP: self-serve from $1,500–$2,500 for a 30-day single-DMA test; $5K minimum for self-serve DSP, $25K for managed.
- **2026 news:** OUTFRONT Media partnership + strategic investment (Feb 25, 2026 — ~$17M/year sales-cloud license, up to $20M milestone-based investment; confirmed via OUTFRONT SEC filing / PR Newswire / Adweek). Lamar integration partnership (~July 2026 — real-time pricing/availability from 356,000+ displays). Clear Channel real-time inventory integration. US OOH hit record $9.46B in 2025 (+3.6%); Q1 2026 all-time high $2.12B (+7.1%), DOOH +12.9% (OAAA, June 3, 2026).
- **Closest competitors:** Adomni (self-serve programmatic DOOH, 60B+ monthly impressions); Blip (self-serve digital-billboard per-screen bids); Vistar Media (enterprise programmatic infra); Broadsign Ads/Reach (SSP, 187,000+ screens); Place Exchange (programmatic OOH SSP in omnichannel DSPs); OneScreen.ai (OOH marketplace, self-serve tilt).
- Sources: adquick.com/api; adquick.com/for-campaign-automation-platforms; blog.adquick.com (~July 2026); https://github.com/hulkintherapy/meta-ads-research (context); PR Newswire / Adweek / Zacks (Feb 2026); OAAA (June 3, 2026)

**Track 2 verdict:** there is no self-serve, API-real buying path with AdQuick in 2026 — **marketplace/concierge for buyers, partner-gated for integrations.** The park decision holds: any API access would require a negotiated commercial partnership (slow, gated). Near-term honest paths without BD: (a) manual/partner-track API later, (b) programmatic via an intermediary DSP with a public API, (c) **deep-linking buyers into AdQuick's self-serve platform as a referral channel** — plan in Marketr, execute on adquick.com.

---

## Track 3 — Local radio / newspaper / magazine buying in 2026

### Local radio: rep-driven core, self-serve at the edges
- **iHeartMedia** — hybrid. Direct sales (thousands of AEs) remains the backbone for broadcast; ~$200M in 2026 programmatic revenue (vs ~$135M in 2025), Amazon DSP integration for broadcast expected Q4 2026, plus Triton Digital/Jelli plumbing (ppc.land, Aug 2026). **iHeart AdBuilder** (powered by Jelli) is the SMB self-serve audio tool (Product Hunt listing, 2026). In Aug 2026 iHeart + Butler/Till ran what they call the industry's first *agentic* streaming-audio buy, with AI buying coming to *broadcast* by end of 2026 — streaming-first, human-set rules (Radio Ink, 2026-08-24).
- **Audacy** — rep-driven, selling digital-first (Radio Ink, 2026-05-13 / 2026-06-04).
- **Cumulus** — no public self-serve found; streaming inventory reachable via AudioGo (2026).
- **StackAdapt + iHeart (Nov 2025):** broadcast radio programmatically available inside StackAdapt's DSP — programmatic access exists, but only through agency-grade DSPs, not a small-buyer UI (RadioInsight, ~Nov 2025).
- **Bottom line:** over-the-air = RFP → proposal → signed insertion order. **No public API from any major US radio group for small-buyer broadcast buys.**
- **Costs/minimums/lead times:** AudioGo (self-serve streaming) min $250 vs. traditional radio $5,000+ (audiogo.com, 2026). Small-market 30s spots $10–150 by daypart, drive $25–150; major-market drive $200–800 (adwave.com, updated 2026-09-23; marketingltb.com, 2026). Radio production $500–2,000+. Booking 2–3 weeks; final creative/traffic 5–7 business days before launch (media.co.uk, 2026).

### Local newspaper (2026)
- **Print = rep-driven via media kits/rate cards.** Live 2026 artifacts confirm: sales-rep contact, copy deadlines days before print, agency-commissionable rates (journalnd.com 2026 rate sheet; TN local group 2026 rate card; hjclassifieds.com, Sep 2026). Small-paper minimums: $35–65 line ads; ~$90 minimum display insertion.
- **Digital = programmatic/self-serve.** Local publishers run Google Ad Manager; inventory buyable via Google Ads/DV360 and private marketplaces (e.g., Local NEWS Network built AdButler + ScrnNow programmatic infra, Newsfile, 2026-05-06). The *print* buy needs a rep; the *digital* equivalent of the same paper is self-serve.
- Classifieds are the one genuinely self-serve print-ish product (online placement forms).

### Magazines (2026)
- Still **media kit + rep + insertion order** — live 2026 artifacts: order forms, materials deadlines ~6 weeks pre-issue (ACMO; postpressmag.com: full-page $2,275 1x / $2,075 4x). **No self-serve marketplace for print magazine buying found.** Closest digital equivalent: SRDS planning database (125,000+ properties) *has an API* — for planning (rates, contacts, circulation), not transacting (srds.com, May 2026). Lead times 6–8 weeks.

### Audio/podcast adjacent — self-serve status
- **Spotify Ads Manager** (rebranded Ad Studio): self-serve, US/UK/CA/AU/DE/FR/ES/IT, podcast + audio/video/display; podcast inventory expansion July 2025; min €15/day, €250 lifetime; 33,000 active advertisers (+60% YoY) Q2 2026 (gadgets360.com, 2026-04; ppc.land, Jul 2025; Spotify Q2 2026 earnings).
- **Acast self-serve:** from $250; managed needs $10k–15k (acast.com 2026 guide).
- **AudioGo:** $250 minimum, reaches iHeart/SiriusXM/Cumulus/Audacy streaming inventory (audiogo.com, 2026).
- **Triton Digital:** programmatic SSP/infrastructure — agency/DSP route, not small-buyer self-serve.

### Track 3 verdict — per channel

| Channel | v1 architecture |
|---|---|
| Local broadcast radio | **Concierge.** Plan in Marketr (station selection via SRDS/Nielsen data, daypart mix, IO generation) → human rep executes the signature. |
| Streaming audio/podcast | **Hybrid: concierge planning + self-serve execution.** The executable leg of v1 — plan in Marketr, hand the client to Spotify Ads Manager / Acast / AudioGo with a generated brief and budget. |
| Local newspaper print | **Concierge.** Media-kit research + IO brief generation; rep signs. Digital display is programmatic — separate v1.5 API leg. |
| Magazines | **Concierge, lowest priority.** Longest lead times, heaviest rep dependence, no self-serve — limit v1 to planning/IO-brief generation only. |

**The honest-model question is CONFIRMED for broadcast/print:** concierge is the honest v1 architecture. No public buying API exists for any major US radio group or print publisher; every 2026 media kit funnels to a sales rep; the IO workflow (signed IO → traffic → proof-of-run) is unchanged.

---

## Track 4 — Non-custodial media spend controls

### How agencies handle client-direct spend today
The client-pays-platform-directly model is the industry norm: "who pays Meta directly for ad spend (usually client pays Meta; agency manages)" and "client owns all ad accounts, pages, pixels, and audiences" are standard onboarding contract addenda (agency onboarding workflow guide, crawled ~2026-09-17).

**PubMatic's agentic governance framework (announced 2026-08-05, "AgenticOS")** — built for exactly this problem (agents spending client money). Five layers: (1) dual-tier guardrails (platform-wide + buyer-configured: budget thresholds, creative approval requirements, inventory allowlists, audience restrictions); (2) inherited business rules as starting state; (3) pre-approved asset libraries (inventory, creative, audiences already cleared); (4) **authenticated approval workflows using one-time passcodes** creating a cryptographically verified approval record when an agent's decision exceeds authority, with backup approvers designated in advance; (5) audit trails with drift detection. Independent transaction check for AdCP buyers. 100K+ sites, 80+ autonomous campaigns, 4,000+ direct deals at announcement; agency Rise (Quad) piloting.
- Sources: https://ppc.land/pubmatic-guardrails-block-ai-agents-from-unapproved-ad-inventory/ (2026-08-05); https://www.stocktitan.net/news/PUBM/pub-matic-launches-governance-architecture-for-agentic-advertising-9xc0n5qie5g4.html (~2026-08-04); https://ppc.land/ai-agents-now-buy-media-so-agencies-are-metering-them-by-the-token/ (~2026-09-04)

**IAB Tech Lab's open-source buyer-agent (active 2026):** `Brief → Budget Allocation → Research → (optional Negotiation) → Human Approval → Book → Delivery`, with campaign state machine (`awaiting_approval`), approve-all or selective approve by product ID, and an event bus logging every quote, negotiation round, booking, and budget allocation for audit.
- Source: https://github.com/iabtechlab/buyer-agent/blob/HEAD/docs/guides/overview.md (crawled ~2026-09-17)

### Corporate-card patterns that transfer (Ramp, Brex, Float)

| Corporate-card pattern | Media-buying transfer | Implementation |
|---|---|---|
| Pre-approved budget | **Budget pool** per client/period/campaign | Software object + platform-native ceilings (Meta account spending limit; Google campaign budgets) |
| Per-transaction limit | **Per-buy cap** within a pool | Pool config + executor pre-flight check |
| Vendor lock | **Platform/vendor allowlist** | Approved-platform list per pool |
| Virtual card per campaign | **Virtual card per pool** (client's card, limit = pool cap) | Brex/Ramp virtual card per pool or per approved buy — the hard money-layer backstop; card decline survives software bugs |
| Real-time blocks | **Real-time spend anomaly blocks** | Sweeper polling spend via platform APIs; auto-pause on breach |
| Request→approve→issue | **Per-buy approval → executor unlock** | Approval object gates the executor |

- **Ramp model** (ramp.com/blog, ~2026-08-18; ramp.com/procurement, ~2026-09-23): multi-step approvals by amount; on approval, **a virtual card is issued for that purchase** (or a PO for invoice-matching). Key pattern: *the instrument is created by the approval.*
- **Brex model** (brex.com/industry/marketing-advertising, ~2026-09-12): unlimited virtual cards per client/campaign budget, card-level limits restricted to budgets/vendors/time periods, real-time threshold notifications.
- **Ad-team payment SOP** (Medium/@Vmcard, 2026-06-24): separate card groups per platform, keep card limits in step with budget approvals, change records for reconciliation. The **virtual-card-per-pool is the most important transfer** — a second enforcement layer at the money level that works even if Marketr's own caps fail.

### Per-buy approval binding — prior art
- **Insertion Orders are the direct ancestor.** IAB/AAAA standard terms (v3.0, still the industry template): an IO must bind (a) deliverables, (b) prices, (c) **maximum amount to be spent**, (d) start/end dates, (e) third-party ad server identity. Both-party written confirmation for changes; publisher must notify within 2 business days if inventory is unavailable (GroupM publisher terms, 2024-03; Eskimi, ~2026-09-03).
- **The agentic-binding gap (2026-08):** AdCP's Brian O'Kelley — the binding signed record of an agentic transaction: "Exist yes. Work yes. Active in production at scale — not yet." IAB Tech Lab's Shailley Singh: "An agentic transaction cannot simply rely on a model saying that a transaction occurred. The architecture needs a **deterministic, auditable record** of what was proposed, approved, and executed." (adotat, ~2026-08-25) → Marketr's approval object should not depend on external protocol adoption for v1.
- **Two-person rules:** PubMatic designates backup approvers in advance; top agencies use peer review for launches; Ramp routes high amounts to multiple approvers. No formal four-eyes legal standard for media buying — but escalation thresholds are established practice.

### Executor re-verification at checkout — prior art
- **IAB buyer-agent "quote-then-book":** a quote is explicitly *non-binding*, locks pricing for a limited window, carries `expires_at`, and booking references the `quote_id`. Expired quote → re-quote before booking. Immutable status-transition log (proposed → active / rejected / expired / completed).
- Source: https://github.com/IABTechLab/buyer-agent/blob/d4e8e98281fb0943347b4f7567e9b5c1bf26faf6/docs/guides/deal-booking.md
- **Why drift matters:** Meta converted ad-set spend limits from hard caps to "average" limits (~7-day average, up to ~25% single-day overspend, up to ~75% with campaign budget sharing); Google can spend up to **2× average daily budget on any day** (you don't pay the overage — monthly reconciliation covers it — but the spend happens). So re-verification in self-serve isn't about price locks; it's about binding budget caps, bid caps (hard ceilings on Meta), creative hashes, and account spending limits.

### Kill switches — what's practical for v1
- **Platform-native rules (zero code, default alongside v1):** Meta automated rules (pause ad set if CPA > X; raise budget if ROAS > Y); agency canonical rules: stop-loss (pause if CPA > 1.5× target and spend > $100), test-cap kill, creative-fatigue kill, spend-anomaly alert (daily spend > 80% of budget before noon → alert). Meta Marketing API supports ad rules programmatically (`adrules_library`) and `bulk_pause` (500 entities/call, 200 calls/hr/account). Meta account spending limits settable via API.
- Sources: https://github.com/hulkintherapy/meta-ads-research/blob/HEAD/workflow-mapping/10-optimization-monitoring.md (~2026-09-17); https://www.lilachbullock.com/facebook-ad-software-options-2026/ (~2026-09-22)
- **Third-party rule engines (clone the model, don't buy):** Revealbot (rebranded **Birch** in 2026) — if-then rules across Meta/Google/TikTok/Snapchat, fully auditable paper trail, $49/mo entry. The property agencies value: **every action traces back to a rule a human set.**
- **Google Ads:** automated rules in UI; Google Ads Scripts run free in-account. For v1, poll via Google Ads API and pause via API — Marketr's own sweeper, so rules live in one place.
- **Cautionary tale (2026-04):** an automation bug compounded a 25% hourly budget increase to €7,937/day in 4 days with no hard cap — state didn't persist, no account-level ceiling existed. The exact failure class Marketr's guardrails must prevent.

### Small-agency fraud/overspend guardrails
- **One Business Manager per client** (not one BM for all clients) — prevents cross-client spend contamination and ban blast radius.
- Account-level spending limit on Meta as the hard ceiling (bulk-settable via API). **Google has no true account-level monthly cap** — its controls are campaign daily budgets (2× single-day flex) plus overdelivery credits; the hard ceiling on Google must come from the virtual-card limit + the sweeper.
- Daily pacing checks with real-time alerts; cap unproven tests (pause at > $25 spend with zero conversions); the 20% rule (never raise daily budget > 20% per change); standardized naming so automated checks can map spend → client → approval.

### Track 4 verdict — recommended v1 control architecture

**A. Approval object schema** (status machine: `draft → pending → approved → executed | expired | revoked`):
- Binding (immutable once approved): platform, client's own ad account id, deal type (auction / PD / PG / PA), line items (inventory, pricing model + max allowed, flight dates, targeting snapshot, creative ids + **sha256 creative hashes** — executor recomputes; mismatch = halt), max total spend, currency, quote_id + quote_expires_at for direct deals, drift tolerance (default 10% price / 5% spend), cancel terms.
- Authority: approvers (user, decided_at, method: sso|otp|signed-link), `two_person_satisfied` (creator ≠ approver always; second approver above pool auto-approve threshold or > $1K default — threshold is a product decision for Tico), approvals_expires_at (execute within window, default 72h), revoked_at/by.
- Audit: append-only event log (`ts, actor, action, payload_hash`) — the IAB event-bus pattern.
- For high-value buys: TOTP/OTP confirmation creating a cryptographically verified record (PubMatic pattern).

**B. Budget-pool model** (the "pre-approved" lane): id, client, name, period (monthly/campaign/one_time), cap_amount, remaining, encumbered (reserved by approved-but-unexecuted buys), platform allowlist (Brex pattern), auto_approve_threshold (default disabled/0), utilization alerts at 50/75/90%, virtual_card_ref (client's card via Brex/Ramp API, limit = cap — the hard backstop), status (active/frozen/exhausted).
- Rules: approval **encumbers** max_total_spend at approval time; execution converts encumbrance → spend; expiry/revocation releases it. Pool can never encumber beyond remaining — the IO "maximum amount to be spent" made programmatic.
- Dual enforcement: software pool cap + virtual card with matching limit. Card declines are the defense-in-depth backstop.
- A per-buy approval is *always required*; the lighter pool path means the cap was human-approved once, and draws within cap + under auto_approve_threshold skip a fresh human click — but still pass full re-verification.

**C. Executor re-verification flow (EXECUTE):** assert approved + unexpired + not revoked; assert two-person provenance; for direct deals: re-fetch quote, not expired, price within drift tolerance (else HALT → back to pending with diff); for auction: re-hash creatives, diff launch config vs approved targeting snapshot, assert platform ∈ allowlist, **assert/set account spending limit (Meta) before launch**, assert pool remaining, assert creative review status approved, assert billing profile valid; execute; write platform-native guardrails at approved values; register buy with the kill-switch sweeper; append events. On any HALT: status stays approved-not-executed, approver + requester notified with diff; re-approval only for what changed.

**D. Kill-switch design (two layers):**
1. **Marketr sweeper** (scheduled job, 5–15 min for critical rules; hourly for trend rules) — Birch-style rule engine: `{ name, scope, condition, window, action (pause | reduce_budget | alert), cooldown }`. Default v1 rule pack: stop-loss pause, test-cap kill, spend-anomaly alert, pool-exhausted → pause all pool entities, creative-fatigue kill. Execution via platform APIs (Meta `bulk_pause`; Google Ads campaign PAUSED). All actions logged to the approval's event log.
2. **Platform-native rules as backup** — provision Meta automated rules / Google Ads scripts at campaign creation so protection survives a Marketr outage. Native rules are the seatbelt; the sweeper is the airbag.
3. **Emergency stop ("client-level kill"):** one action pauses every active entity for a client across platforms, revokes pending approvals, freezes all pools, and exports the audit trail. Requires approver role + reason; logged immutably.
- **v1 must NOT:** do autopilot purchasing (locked); increase budgets without re-approval (the €7,937/day bug class); rely on platform "average" spend limits as hard caps.
---

## Track 5 — Offline / OOH attribution for SMB agencies

### Per-panel / per-placement QR + pURL (OOH)
- **Best practices:** dynamic QR codes (editable destination, no reprint) with UTM baked in → fast mobile landing page mirroring the creative (qrcodedynamic.com, Sep 2026). Size rule: code width ≈ 10% of read distance. Only use QR where there's **dwell time** — transit shelters, street furniture, malls, pedestrian streets. Highway boards don't work (OAAA best practices: "consider using scan codes on OOH displays located in pedestrian-friendly areas").
- **Scan-rate honesty:** vendor blogs cite 1–5% of impressions scanned (qrcodedynamic.com — vendor claim, not an industry study); one independent agency counters: "Unless you are giving away free iPads, don't expect QR codes to work." Broader context: 52–67% of OOH viewers take *some* smartphone action after seeing an ad; 43% searched specifically for the brand (Nielsen/OAAA, Blip/Arbitron). QR scans are a thin slice of total response — branded-search lift captures the rest.
- **Self-hostable short-link / dynamic-QR infrastructure with APIs (2026):**
  - **Dub** — open-source (github.com/dubinc/dub), free tier 25 links/mo, self-hostable for unlimited; full REST API, per-link QR, UTM builder, webhooks, analytics. Memeburn (Sep 2026) ranks it best open-source option. **Most aligned with Marketr's open-source model.**
  - Bitly — free 5 links/mo, Core $10/mo; enterprise ~$1,500/mo (overkill).
  - Rebrandly — agency-friendly, growth $119/mo; strong API.
  - Short.io — $5/mo, API-first, 1,000 free links.
  - qr-code-generator.com (Bitly-owned) — API $9.99–$46.99/mo.
  - DIY/MIT options: botnick/shortlink (Cloudflare Workers, $0, REST + MCP); link-shortener-mvp (MIT, $5 VPS, per-link QR PNG/SVG, editable destinations).
- **Per-placement tactic:** one vanity short URL / QR per board (`brand.link/board-47`), roll up at campaign level via UTM `utm_content` or tags.
- Sources: https://qrcodedynamic.com/blog/qr-code-on-billboard/ (~135 days before Sep 2026 crawl); https://stg.movingwalls.com/wp-content/uploads/2026/01/Ultimate-OOH-Design-Checklist-Moving-Walls-Market.pdf (Jan 2026); https://oaaa.org/wp-content/uploads/2022/09/OAAA-Best-Practices-oct20-2021-spreads_2_.pdf; http://oneday.agency/blog/how-to-measure-out-of-home-advertising; https://memeburn.com/best-url-shorteners/ (Sep 2026); https://dev.to/0012303/dubco-has-a-free-api-heres-how-to-build-a-link-shortener-with-analytics-48hc; https://github.com/botnick/shortlink

### Geofenced footfall / visit-lift vendors (SMB accessibility, 2026)
- **Foursquare Attribution** — still exists (Q2 2026 Attribution Digital Guide, omnichannel lift dashboard) but **enterprise, contact-sales**; only Studio has a free tier (visualization only). → Not SMB-accessible.
- **Cuebiq** — still active (Sep 2026), privacy-forward SDK collection, but enterprise measurement partner — no public self-serve tier. → Enterprise only.
- **GroundTruth** — mid-market+ minimums historically. → Defer.
- **Near** — pivoted to enterprise location intelligence years ago. → Not SMB.
- **Proxi.cloud** — from **$1,000/mo**, more proximity-marketing than visit-lift. Borderline SMB, pricey.
- **Google Ads store visits** — free inside Google Ads but measures only Google Ads media; needs linked GBP + data thresholds.
- **Pragmatic SMB proxy:** Google Business Profile insights (direction requests, calls, website clicks) tracked before/during/after the flight (Billboard Buzz, Jun 2026) + geo-holdout comparisons.
- **Regulatory caveat:** location-data consent tightening (New Jersey ban on selling location data since June 2026; NAI sensitive-location standards; 2026 Supreme Court carrier-location-data ruling) — footfall panels keep shrinking; SMB reports lose precision first.
- Sources: https://ppc.land/footfall-attribution/ (Sep 2026); https://sourceForge.net/software/foot-traffic-data/for-small-business/ (Sep 2026); https://foursquare.com/wp-content/uploads/sites/2/2026/05/Foursquare-Q3-2026-Location-Based-Targeting-Guide.pdf (May 2026); https://cuebiq.com/blog/cuebiq-on-location-data-advancements-and-how-privacy-plays-a-role/

### Branded-search lift & direct-traffic lift (the industry-standard proxies)
- **Methodology:** (1) 4–6 week pre-campaign baseline of branded-query impressions/clicks in Google Search Console (SEJ, Aug 2026); (2) align exactly to flight dates, date-compare, segment by device (billboards drive mobile) and geography — board metro vs. holdout metros (Whistler Billboards, Feb 2026); (3) separate search *volume* from search *capture* (rising demand + flat CTR = AI Overviews/competitors intercepting); (4) **run a geo-holdout, not before-and-after** — the only way to credit the OOH specifically (SEJ); (5) Google Trends as the free metro-level cross-check; (6) direct traffic in GA4 aligned to flight dates (with the caveat that much is actually search/AI overflow — one 2026 analysis estimates AI-attributable sessions under-counted ~3×).
- **2026 benchmark:** OAAA + Kochava study (May 2026) — OOH median **+20% lift for in-person outcomes, +14% for digital outcomes**, roughly double CTV/broadcast. Good client-report credibility number (caveat: medians from larger campaigns).
- **New tooling:** Google Ads added "Branded Searches" as a conversion metric (30-day view-through; YouTube/PMax/Demand Gen).
- Sources: https://www.searchenginejournal.com/youtube-measures-creator-video-on-branded-search-lift-but-the-attribution-gap-still-exists/584876/ (Aug 2026); https://medium.com/@whistlerbillboards/how-to-track-branded-search-from-billboards-in-google-search-console-7282a9d994b1 (Feb 2026); https://www.theremnantagency.com/brand-search-lift-as-success-metric/; https://searchengineland.com/google-ads-branded-searches-conversion-metric-459382; https://medium.com/billboard-buzz/q1-2026-ooh-revenue-growth-shows-why-billboard-advertising-still-matters-f590194ea073 (Jun 2026)

### Audio attribution
- **Pixel-based (Podsights model → now Spotify Ad Analytics):** free, centralized dashboard, 11 markets — but requires buying through Spotify or participating publishers; a media-vendor measurement tool, not something bolted onto local radio buys (ads.spotify.com; podcastinc.io, Sep 2026).
- **SMB-practical layer:** vanity URL per station/spot, unique promo code per spot, dedicated tracking phone number per station — the classic and still recommended method (Hybrid Media Services; Hubbard Chicago; media.co.uk 2026).
- **Call-tracking vendors:** CallRail ~$45–55/mo (5 local numbers + 250 min; extra locals $3/mo; toll-free $5/mo), full API/webhooks, GA4/HubSpot integrations (softwarefinder.com, Sep 2026; G2, Sep 2026). Analytic Call Tracking is the agency-oriented alternative (full API).
- **Industry reality check (2026):** audio has "no reliable last-click attribution mechanism"; measure via media-mix/branded-search lift rather than in isolation (ppc.land, Jun 2026).

### Print attribution
- Unique QR per publication/ad; campaign landing pages with a unique URL printed only on that run (every visit guaranteed from the print piece); unique offer/coupon codes per publication or ZIP (redemption feeds ROI); dedicated phone numbers/email per campaign. Always UTM-tag the destination behind the QR and shorten the printed URL (printlord.co.uk, Sep 2026 — freshest source; perkvalleynow.com, Jun 2025).

### Track 5 verdict — build / integrate / defer for v1

| Rank | Method | Effort | Verdict |
|---|---|---|---|
| 1 | Per-placement QR + vanity short URLs (OOH/print), campaign rollup | Low — self-host Dub OSS or botnick/shortlink; API-driven per-placement link creation, UTM auto-tagging | **BUILD NATIVELY** — the Marketr wedge |
| 2 | Per-spot/per-station promo codes + vanity URLs (radio/audio) | Low — client-managed; Marketr generates + tracks | **BUILD NATIVELY** |
| 3 | Branded-search lift dashboard (GSC + Google Trends, baseline windows, geo compare) | Medium — OAuth GSC pull | **BUILD NATIVELY** — biggest "proof it worked" win |
| 4 | Direct-traffic + GBP-actions lift panels | Low–Medium | **BUILD NATIVELY** as supporting indicators |
| 5 | Dedicated tracking phone numbers | Low–Medium (CallRail API, ~$45/mo client cost) | **INTEGRATE** — highest credibility per dollar for call-driven SMBs |
| 6 | Spotify/Podsights pixel attribution | Gated by buying Spotify inventory | **DEFER** — document how-to only |
| 7 | Geofenced footfall vendors (Foursquare, Cuebiq, GroundTruth) | Enterprise contracts; statistically invalid at SMB panel sizes | **DEFER** |

**Honest statistical caveats (must ship in the v1 report card):**
1. Scan rates are tiny and selection-biased — QR measures engaged responders, not reach.
2. Attribution ≠ incrementality. Without a geo-holdout you cannot claim the OOH *caused* the response; SMB budgets can't buy enough geography for holdouts — report directional indicators, never causal claims.
3. Footfall vendors need scale — a 3-billboard flight won't produce valid visit-lift reads, and 2026 privacy regulation squeezes small samples first.
4. Branded search lift conflates all concurrent marketing; geo-segmentation helps but doesn't eliminate confounds.
5. AI search is breaking the click trail (~3× under-count in analytics; lands as "direct") — direct-traffic reads are polluted in both directions.

---

## Recommended v1 scope (shaped by the locked decisions)

### Guiding principle: the safety system ships before the first dollar moves.

**S1 — Generalized C3 trust ladder for media**
- Generalize the existing C3 ladder into approval rungs for money movement: `draft → pending → approved → executed | expired | revoked`, with two-person rules (creator ≠ approver always; second approver above a threshold — default $1K proposed, Tico decides), OTP/TOTP-verified approval records for high-value buys (PubMatic 2026 pattern), backup approvers designated in advance, execution window (default 72h) else re-approve.

**S2 — Non-custodial "media wallet" (budget pools, not custody)**
- `BudgetPool` objects per client: cap, remaining, encumbered (encumber at approval → spend at execution → release on expiry/revocation), platform allowlists, utilization alerts (50/75/90%), status (active/frozen/exhausted).
- **Dual enforcement:** software pool caps + virtual card per pool issued on the *client's* card via Brex/Ramp API with limit = cap. Card declines are the backstop that survives software bugs.
- Account separation: one ad account/Business Manager per client; platform-native ceilings set before launch (Meta account spending limits; Google campaign budgets — noting Google has no true account-level monthly cap, so the card + sweeper are the ceiling there).

**S3 — Per-buy approval binding + executor re-verification**
- Approval binds: inventory, exact spend (max_total_spend), creative hashes (sha256, recomputed at execution; mismatch = halt), flight dates, targeting snapshot, cancel terms, quote_id + expiry for direct deals, drift tolerance (default 10% price / 5% spend).
- Executor pre-flight: approval valid + unexpired + unrevoked; two-person provenance; quote fresh and within tolerance; creatives re-hashed; config diffed vs approved snapshot; platform ∈ allowlist; spending limit set; pool remaining ≥ max; creative review approved; billing profile valid. Any failure → status stays approved-not-executed, approver + requester notified with diff; re-approval only for what changed.
- Quote-then-book for direct deals (IAB pattern): quotes are explicitly non-binding with `expires_at`; booking references `quote_id`; expired quote → re-quote.

**S4 — Kill switches**
- **Marketr sweeper** (5–15 min for critical rules; hourly for trend rules): Birch-style rule engine `{ name, scope, condition, window, action, cooldown }`. Default v1 rule pack: stop-loss pause (CPA > 1.5× target + spend > $100), test-cap kill ($25 spend, 0 conversions), spend-anomaly alert (80% of daily budget before noon), pool-exhausted → pause all pool entities, creative-fatigue kill. All actions logged to the approval's event log — every action traces back to a rule a human set.
- **Platform-native rules as backup** (Meta automated rules, Google Ads rules/scripts provisioned at campaign creation) — protection that survives a Marketr outage. Seatbelt vs. airbag.
- **Client-level emergency stop:** one action pauses every active entity for a client across platforms, revokes pending approvals, freezes all pools, exports the audit trail. Approver role + reason; immutable log.
- Never: autopilot purchasing; budget increases without re-approval; relying on platform "average" limits as hard caps.

**B1 — DOOH planner + concierge (first buying path)**
- Planner UI: screens/dayparts/budgets; launch-packet generator against Blip first (no minimums, agency reseller program), Blindspot second (global, hourly/per-play), Adomni optional. Client approves in Marketr; execution happens in the client's own Blip/Blindspot/Adomni account.
- AdQuick: **no API integration** (parked) — deep-link buyers into AdQuick's self-serve platform as a referral channel (plan in Marketr, checkout on adquick.com). Revisit only if Tico authorizes BD.
- Programmatic DOOH (Vistar/Place Exchange/Broadsign inventory via DSP seat): defer execution; Marketr can *prepare* PMP-ready plans (screens, CPM guardrails, venue targeting) for clients with a DSP seat.

**B2 — Streaming audio (the executable leg)**
- Concierge planning + self-serve execution for Spotify Ads Manager, Acast ($250 min), AudioGo ($250 min): generated brief + budget → client or agency launches in their own account.

**B3 — Radio/newspaper concierge**
- Broadcast radio + newspaper print: IO-brief generator (station selection via SRDS/Nielsen data, daypart mix, IO terms), plan in Marketr → human rep executes the signature. Newspaper *digital* display = separate programmatic leg (v1.5).
- Magazines: lowest priority — planning/IO-brief generation only in v1.

**A1 — Attribution v1**
- Build natively: per-placement QR/pURL engine (self-hosted Dub OSS or botnick/shortlink — data stays in Marketr; dynamic destinations; per-board codes; UTM auto-tagging; scan analytics), promo/vanity-code generator for radio/print with redemption tracking, branded-search lift dashboard (GSC + Google Trends, baseline windows, board-metro vs. holdout views), direct-traffic + GBP lift panels.
- Integrate: CallRail API for per-station/per-publication tracking numbers.
- Defer: footfall vendors (Foursquare/Cuebiq/GroundTruth), Spotify Ad Analytics pixel.
- Ship the honest caveats in the report card: directional indicators, never causal claims, at SMB scale.

### v1 exit criteria (per MASTER-PLAN)
- Adversarial buying battery: attempts to bypass approvals, exceed caps, swap creatives post-approval, stale-quote execution, and double-spend all fail closed and are logged.
- Receipt reconciliation: ledger vs. platform actuals/invoices, variance surfaced.
- Full audit trail proofs: every proposed → approved → executed transition deterministically recorded and exportable.

### Open product decisions for Tico (from research)
1. Two-person threshold default ($1K proposed?) and pool `auto_approve_threshold` default.
2. Whether Marketr builds the Brex/Ramp virtual-card integration itself in v1, or ships pool caps with card setup as a documented manual step.
3. CallRail: native integration in v1 vs. documented setup.
4. Self-hosted link infra choice: Dub OSS vs. botnick/shortlink (both fit; Dub is the more mature API).
