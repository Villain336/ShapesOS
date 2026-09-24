# Programmatic DOOH Buying — Scope for Marketr

Tico's ask: what would it take for Marketr — with the user's stored payment method and explicit per-purchase approval — to buy digital billboard placements programmatically, the way an agent can buy things online with permission.

Companion docs: `PHYSICAL-MARKETING.md` (OOH landscape baseline), `AGENCY-COMPARISON.md` (R1–R5: Lead CRM, attribution, nurture, reviews, call tracking).

**The one-line answer:** a true self-serve billboard-buying API exists in exactly one place — AdQuick's partner API (programmatic + guaranteed, with a hosted MCP server). Everything else is either DSP-seat infrastructure (Vistar, Place Exchange, Broadsign), a self-serve web platform with no API (Blip, Blindspot, Fliphound), or relationship-driven (Lamar static bulletins). So the strategy is: **AdQuick partnership for the programmatic path, browser-agent concierge for Blip/Blindspot, DSP seat only when volume justifies it.**

---

## 1. Access-path decision

### Path A — AdQuick partner API ⭐ RECOMMENDED FIRST

**What it is:** AdQuick is an OOH intelligence + marketplace platform: 1,500+ media owners, "close to 100% of US OOH supply," and itself a DSP transacting programmatically across every major SSP (Vistar, Broadsign Reach, Place Exchange, Hivestack, VIOOH). OUTFRONT Media invested up to $20M (Feb 2026) for a 3-year sales-cloud license; the marketplace stays open.

**The integration surface (verified in AdQuick's own docs, docs.adquick.com, last modified Sept 8, 2026):**
- Partner REST API at `api.adquick.com` (X-PARTNER-TOKEN auth) covering: programmatic DOOH (forecast auction inventory, activate/manage campaigns, submit/schedule creatives, delivery reporting) and guaranteed OOH (plan campaigns, place insertion orders, submit/schedule creatives, in-flight data: booked unit locations, daily impressions).
- Reporting: impressions, spend, unit/screen details, status — for API-planned or app-planned campaigns; designed to feed CRMs and BI tools.
- Documented workflow: (1) fetch media types, (2) create advertiser record per advertiser, (3) submit campaign details → view proposed campaign, (4) submit proposal to complete the purchase, (5) create creative records, (6) reporting.
- A hosted MCP server (OAuth 2.0 + PKCE) giving AI agents natural-language access to inventory discovery, campaign management, market analytics, exports, and programmatic DSP tooling (per third-party API Evangelist profile; AdQuick's own MCP page could not be fetched — treat as partner-confirmed-before-building).

**Requirements:** partnership + partner token. API access is via `api@adquick.com` — this is a *partner* API, not open self-serve signup. Commercial terms, minimums, and resale/embedding rights are the BD conversation.

**Timeline/cost:** BD-led; unknown until the conversation happens. No public pricing for the partner tier.

**Why first:** it's the only path where software can plan, price, buy, and verify billboards without a human clicking through a web UI — and it covers both programmatic auction inventory *and* guaranteed static placements (which solves the Lamar-static-bulletin problem too, via insertion orders rather than rep relationships).

### Path B — Blip browser-agent concierge (buildable now)

**What it is:** Blip is the true self-serve entry — "Google Ads of billboards." Free account at marketplace.blipbillboards.com; pick boards on an interactive map (daily impressions + average CPM shown per board); set daily budget (campaigns from $20/day, pay-per-play from $0.01/display, no contracts, no minimum spend); upload creative to exact pixel specs (≤7 words, high contrast); schedule dates/dayparts; launch → moderation. Every ad is reviewed before it runs; approval takes 1–3 days; campaigns can be live within the week.

**No public API exists** — verified across Blip's own help docs and third-party coverage. The execution path is a browser agent driving the campaign builder.

**Requirements:** a Blip account per buying entity, stored payment method, the browser-agent executor (this is the Handle It / action-connector pattern), and a hard final-review pause before "Launch Campaign."

**Timeline/cost:** product work only — no BD. Media minimums are effectively $20/day.

### Path C — Blindspot browser-agent concierge (buildable now)

**What it is:** self-serve programmatic DOOH (operated by TPS Engage, LLC): 3M+ screens in 50+ countries, book exact screens for exact hours, per-play pricing shown before purchase (urban plays from ~$0.23; Times Square ~$40), no minimums/retainers/sales calls, campaigns from $50, live in ~48 hours. AI planner "Blinky" turns a brief into a booked screen-by-screen plan. Verified proof-of-play logs (each record ties one play to one screen, lat/long, timestamp); measured outcomes published ($0.82/incremental store visit, $5.75/incremental purchase). Creative: AI pre-check + team sanity check + screen-operator approval.

**API status:** Blindspot publishes a Pull API — but it is device-facing (screen owners pull creative and log proof-of-play), not a buyer booking API. Buyer execution is browser-agent, same as Blip.

**Requirements:** Blindspot account, stored payment method, browser-agent executor.

### Path D — Vistar / Place Exchange / Broadsign via DSP seat (later, volume-gated)

**What it is:** the actual programmatic plumbing. Vistar (now part of T-Mobile Advertising Solutions) is the SSP/DSP/ad-server backbone — infrastructure, not a storefront; access means a DSP seat + enterprise contract. Place Exchange (acquired by Broadsign Nov 2025) is supply-side; buyers reach it through DSPs (Yahoo, DV360's Programmatic Guaranteed, The Trade Desk, Basis). Broadsign Reach is the SSP; Hivestack (now "by Perion") is SSP-side. Global pDOOH was $1.339B in 2025 (WOO/PwC); 75.7% transacts as Private Marketplace; OOH-specialist DSPs hold 65.5% of spend.

**Requirements:** DSP seat (enterprise contract, trading-desk capability), which is the wrong tool for a $200/day local roofer. Relevant only when Marketr is moving serious aggregate media volume and wants auction pricing + PMP deals directly.

**Lamar note:** Lamar's programmatic FAQ states *no minimums are ever required* for programmatic campaigns; 4,600+ large-format roadside screens across 170+ DMAs; CPM floors $5/$7, PMPs from $9; proof-of-performance via webcam photos/mockups with no spend minimum (3–5 day turnaround). Access is through DSPs — so Path A (AdQuick, which transacts across every major SSP) or Path D covers Lamar digital. Static bulletins stay relationship-driven (reps, 4-week flights) — AdQuick's *guaranteed* insertion-order path is the software-shaped alternative.

### Path E — Fliphound (deprioritized)

Self-serve US digital-billboard network with slot-based pricing (¼/½/full slot per week; e.g. Durham NC 4-week ¼-slot ≈ $800). Real-time pricing on the site, dayparting, analytics. Smaller US-only footprint, basic measurement vs. Blindspot, no API. Fine as a manual option; not worth dedicated build.

### Recommendation

| Priority | Path | Type |
|---|---|---|
| 1 | AdQuick partner API | BD → build (the programmatic path) |
| 2 | Blip browser-agent concierge | Build now (self-serve, no BD) |
| 3 | Blindspot browser-agent concierge | Build now (extends beyond billboards to 3M screens) |
| 4 | Vistar/DSP seat | Later, when aggregate media volume justifies it |
| — | Fliphound | Manual option only |

---

## 2. Build scope

### (a) Inventory / planning UI
- Geo search, board/screen picker on a map, daypart selection, budget input, CPM/per-play estimates shown *before* any money moves.
- Phase 1: Blip/Blindspot data entered via the browser-agent's planning pass (scrape marketplace data into a structured plan) or manual entry; AdQuick phase: media-types + inventory discovery via partner API.
- Fits the existing studio/dashboard patterns; cost estimates are planning data, never a commitment.

### (b) Creative pipeline
- Studio module generates OOH creative to operator specs (exact pixel dimensions per board; ≤7 words; high-contrast; logo/CTA).
- Operator approval workflow: Blip (1–3 day moderation), Blindspot (AI pre-check + operator), AdQuick (submit/schedule creative records via API). Creative status tracked per campaign; a rejected creative blocks the buy, never silently retries with altered content.

### (c) Purchase execution
- **Per-buy approval flow (supervised, always):** the user sees the exact order summary — boards/screens, dates, dayparts, total spend, creative proof, payment method, operator terms — and approves *that specific buy*. Approval cannot be pre-granted, batched, or standing. Pending checkouts expire.
- **Execution:** AdQuick phase = partner API purchase call; Blip/Blindspot phase = browser agent driving the campaign builder to the final-review pause, then executing only after approval.
- **Payment:** stored payment method via the media wallet (see e), charged at purchase. Receipts stored per campaign.

### (d) Delivery verification ingestion
- Proof-of-play → attribution dashboard. Sources: Blindspot verified play logs (play ↔ screen ↔ timestamp ↔ lat/long); AdQuick in-flight delivery reporting (impressions, spend, unit/screen details, status); Lamar programmatic webcam photos/mockups; Blip performance tracking (daily impressions, average CPM, location performance).
- Feeds R2 (attribution): plays/impressions per board → calls (R5 tracking numbers) → leads (R1) → revenue. This is the "prove dollars, not vibes" loop for physical.

### (e) Wallet separation
- **Media wallet per workspace/client, separate from SaaS billing.** The Stripe customer + card on file used for Marketr subscriptions must not be co-mingled with client ad spend. Design: a distinct media-wallet instrument per client workspace; media spend is pass-through (client money in → operator out); Marketr takes a planning fee or margin, metered as its own credit action.
- White-label fit: each agency client already gets a workspace; each workspace gets a media wallet. Client funds their own wallet; the agency never fronts media on the agency's card.

### (f) Trust-ladder gates
- **Supervised, always, for media.** Media buying never reaches autopilot — not as a ladder stage, not as an exception. This is the red lane.
- **Pre-approved budget caps as product mechanics:** "spend up to $X/week on Blip in these zips" is allowed as a *planning constraint* (caps, schedules, kill switches gating *proposed* buys), not as autopilot spend. Every executed buy still carries its own approval.
- **Kill switches:** auto-pause proposals when cost-per-call or cost-per-lead exceeds the configured threshold; surface the breach, require re-approval to resume.
- **Audit:** every plan, approval, execution, receipt, and delivery report is audit-logged per workspace.

---

## 3. Phasing

**Now (product work, no BD):**
1. Physical attribution kit (P2 from PHYSICAL-MARKETING.md) — dedicated tracking numbers + QR/UTM + vanity URLs + lift dashboard. Pure software, works with media bought anywhere, feeds R2/R5. *This is the differentiator and should ship before any buying capability.*
2. Blip browser-agent concierge — planning UI → creative pipeline → per-buy approval → browser execution → receipt capture.
3. Blindspot browser-agent concierge — same pattern, broader inventory (3M screens, hourly control, verified play logs).

**Needs BD:**
4. AdQuick partnership — partner token via api@adquick.com; confirm commercial terms, minimums, resale/embedding rights, and MCP-server availability to third-party developers. This unlocks true programmatic buying (auction + guaranteed, ~100% US supply, API reporting).
5. Lamar programmatic via AdQuick's DSP/programmatic path — no separate integration needed once Path A is live.

**Later:**
6. DSP seat (Vistar/Trade Desk/DV360) when aggregate client media volume justifies auction-direct access and PMP deals.
7. Direct-mail API buying (Lob/PostGrid) as the second programmatic physical channel — P1 from PHYSICAL-MARKETING.md; genuinely API-native today.

---

## 4. Honest boundaries

- **No Stripe-like public billboard booking API exists.** AdQuick's is a *partner* API — token granted through a partnership, not open self-serve signup. Blip, Blindspot, and Fliphound have no buyer-facing public API; the published Blindspot Pull API is device-facing (screen owners), not for booking.
- **Creative approval is a human gate at every operator** (Blip: every ad reviewed, 1–3 days; Blindspot: AI + team + operator, ~48h). Marketr can prepare and submit creative; it cannot skip the review.
- **Cancellation terms per operator could not be verified** from public sources — must be captured in the BD conversation (AdQuick) and surfaced from the operator UI at purchase time (Blip/Blindspot), shown in the approval summary.
- **Autopilot never buys media.** Pre-approved budgets are caps on proposed buys, not standing spend authority. A pending approval expires; approvals are per-buy, never batched.
- **Static bulletin buying (Lamar/Clear Channel/OUTFRONT direct) stays relationship-driven** — Marketr plans the buy and drafts the media brief via AdQuick's guaranteed insertion-order path or hands off to the rep; the signature stays human.

---

## 5. Biggest unknown

**AdQuick's partner commercial terms.** Everything structural is verified — the API exists, the docs describe the full plan→buy→report workflow, the MCP server is profiled — but whether a SaaS can get a partner token, at what cost/minimums, and whether embedding/resale to white-label agency clients is permitted, is a BD conversation (api@adquick.com). If AdQuick's terms don't fit, the fallback is Path B+C (browser-agent concierge) indefinitely, which is fully buildable but doesn't scale like an API.

---

## Sources

- Lamar Advertising — Programmatic FAQ (coverage, auction types, CPM floors, no minimums, proof of performance): search result, lamar.com
- Vistar Media / Basis Technologies integration (Vistar SSP supply incl. Lamar, Clear Channel): https://www.vistarmedia.com/news/basis-technologies-and-vistar-media-automate-dooh?hs_amp=true
- FatTail AdBook × Vistar order-management API integration (July 13, 2026): http://www.digitalsignagetoday.com/news/fattail-vistar-media-partner-to-integrate-dooh-booking/
- AdQuick partner API + MCP server profile: https://providers.apievangelist.com/providers/adquick/ and https://apis.io/providers/adquick/
- AdQuick API docs — Getting Started (programmatic/guaranteed/reporting workflow; last modified Sept 8, 2026): http://docs.adquick.com
- AdQuick × OUTFRONT $20M partnership (Feb 2026): https://www.adweek.com/media/outfront-adquick-partnership/ and https://www.digitalsignagetoday.com/news/outfront-media-partners-with-adquick-for-multi-year-collaboration/
- AdQuick as DSP across SSPs (Manchester guide): https://www.adquick.com/dooh-advertising/manchester-gb
- Blip campaign flow (signup, budget, creative, moderation): https://help.blipbillboards.com/get-started-with-blip
- Blip franchise/self-serve details ($0.01/display, no minimums, 1–3 day review): https://www.blipbillboards.com/blog/digital-billboards-for-franchise-brand-consistency/
- Blip performance tracking ($20/day, pay-per-play): https://www.blipbillboards.com/blog/hyper-local-billboard-ads-roi-insights-for-small-businesses/
- Blindspot self-serve ($50 campaigns, per-play, 48h, proof-of-play, Blinky): https://seeblindspot.com/
- Blindspot measurement methodology (play/proof-of-play/reach/daypart): https://seeblindspot.com/assets/downloads/blindspot-dooh-measurement-methodology.pdf
- Blindspot Pull API (device-facing, TPS Engage): https://github.com/api-evangelist/tps-engage
- Blindspot budget planner (734 markets, per-play medians): https://seeblindspot.com/budget-recommendation/
- Fliphound pricing (slot model, Durham NC example): https://www.fliphound.com/billboard-advertising/North-Carolina/Durham
- WOO inaugural pDOOH study ($1.339B 2025, PMP 75.7%, specialist DSPs 65.5%): https://brandcom.ng/2026/09/16/global-programmatic-dooh-market-reached-1-339-billion-in-2025-inaugural-woo-study-finds/
- Place Exchange Programmatic Guaranteed in DV360 (Broadsign acquisition): https://ppc.land/place-exchange-just-made-dooh-buying-as-easy-as-display-ads/
- Broadsign acquires Place Exchange: https://www.tastyad.com/broadsign-announces-acquisition-of-place-exchange/
- Yahoo DSP × Place Exchange (Lamar/OUTFRONT/Clear Channel supply): https://www.yahooinc.com/blog/place-exchange-partnership-expands-programmatic-dooh-inventory
- Programmatic DOOH mechanics (SSP/DSP/exchange, proof-of-play): https://www.advision.digital/2026/09/01/ssp-and-dsp-programmatic-dooh/
