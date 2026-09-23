# Physical Marketing (Billboards + OOH + Direct Mail) — Opportunity for Marketr

Companion to AGENCY-COMPARISON.md. Tico's thesis: agencies sell pipeline and revenue, not rankings — and physical marketing (billboards, direct mail, yard signs, wraps) is a core part of what local/service agencies sell that Marketr today doesn't touch. This doc maps the landscape, pricing, and what's genuinely buildable vs. what needs vendor relationships — all designed to fit Marketr's **metering-first** architecture and **trust ladder** (supervised → scheduled → autopilot).

## 1. Landscape + pricing summary

### Billboards (traditional OOH)

- **Operators:** Lamar, Clear Channel Outdoor, and OUTFRONT Media dominate US inventory; thousands of regional owners fill the rest. Buying is relationship-driven: reps, 4-week flights, negotiation, 10–20% discounts on 3–6 month commitments.
- **Static bulletins (14'×48', 100% share of voice):** rural/small markets $250–$1,500 per 4 weeks; mid-tier metros $1,500–$4,000; major metros $4,000–$15,000; top-10 DMAs $10,000–$50,000. Junior posters (small format): $200–$2,000 per 4 weeks depending on market.
- **Digital bulletins (rotating 8-second slots):** mid-tier $1,500–$9,000 per 4 weeks; major metros $8,500–$20,000; typically 20–50% more than a comparable static board. Flexibility (instant creative swaps, dayparting) is the justification.
- **Production:** vinyl print $300–$500 per bulletin; design $150 (freelancer) to $1,000+ (agency). Separate from media cost — this is where agencies take margin.
- **Who buys:** local/service businesses are heavy users (lawyers, home services, medical, car dealers, restaurants) — exactly Marketr's ICP for the agency white-label tier.

### Programmatic DOOH (the API-driven door)

- **Vistar Media** (now part of T-Mobile Advertising Solutions): the leading DOOH DSP/SSP — hundreds of thousands of screens, automated bidding, order-management API. Access is via DSP seat or enterprise partnership, not a self-serve developer signup.
- **Place Exchange:** the programmatic inventory layer DSPs (Trade Desk, DV360, Basis) plug into — supply-side, not a direct booking API for SaaS.
- **Blindspot:** direct per-screen hourly scheduling with per-play pricing (no DSP seat needed); publishes measured outcomes ($0.82 per incremental store visit, $5.75 per incremental purchase vs. control groups) — the most "performance-marketer-shaped" DOOH product.
- **Blip Billboards:** the true self-serve entry — "Google Ads of billboards." Daily budgets from $10–$20, pay-per-play real-time auctions every 10 minutes, 8-second blips, no contracts, launches in 1–3 days. Thousands of US digital boards. **No public developer API** — it's a self-serve web platform, not an integration target.
- **AdQuick:** the closest to an OOH marketplace for software to partner with — 1,700+ media owners, live inventory map with photos/traffic/pricing, fixed-price digital booking, 48-hour "campaign request" for offline static inventory, proof-of-performance photos, and campaign analytics (search-lift, social-lift, pre/post surveys). Integration path is partnership, not a public API.
- **Fliphound:** self-serve DOOH with daypart buying (coarser than Blindspot's hourly).

**Bottom line:** there is no Stripe-like public API for booking billboards today. The automation-ready paths are (a) self-serve platforms you refer/concierge through (Blip, AdQuick), and (b) enterprise DSP partnerships (Vistar) — which is a business-development motion, not a weekend integration.

### Direct mail (the most API-ready physical channel)

- **Lob (lob.com):** the print-to-mail API. HTML/templates in, printed+mailed+tracked pieces out. Developer plan free (500 mailings/mo); postcards from $0.81/piece all-in (dev tier) down to ~$0.52 at scale; letters $0.94 → $0.74; Startup plan $260/mo (3,000 mailings), Growth $550/mo (6,000). 11,000+ businesses. In-transit tracking webhooks, address verification, analytics. **This is the API integration.**
- **PostGrid:** REST-API competitor to Lob with simpler pricing (rated 10/10 vs. Lob's 8.6 on TrustRadius comparison) — worth evaluating as the integration target; potentially better unit economics for an agency-white-label play.
- **Click2Mail:** print-to-mail with API, $0.39/item base (print+postage varies) — cheaper but less developer-polished.
- **EDDM (Every Door Direct Mail):** the killer local play — USPS Retail lets any business mail to every address on selected carrier routes with **no mailing list and no permit**, postage ~$0.18–$0.21/piece. All-in with print: ~$0.35–$0.45/piece. Design is one-time ($200–$500, then reusable). A 5,000-piece neighborhood saturation costs roughly $1,750–$2,250 all-in. **Caveat:** EDDM Retail is a USPS web tool, not an API — Marketr can design the creative, pick routes via the USPS mapping data, and manage the campaign, but fulfillment goes through the USPS flow or an EDDM print shop. Lob does *addressed* mail, not EDDM.
- **List economics:** purchased/rented lists $0.10–$0.40/contact; house lists (the client's own customers — reactivation campaigns) cost $0 and convert best.
- **Agency model:** full-service direct-mail shops (e.g. PostcardMania) bundle design + print + mail + list with markup; agencies typically charge a management fee or fold it into retainers. Software-only plays (Lob) leave the margin on the table for whoever owns the client relationship.

### Adjacent physical (concierge, not API)

- **Yard signs:** 18"×24" corrugated plastic $2.54–$3.14 each at 50–100 qty (wholesale as low as $2.99 with stakes). Real estate, contractors, political — reorder-heavy.
- **Door hangers:** print $0.27–$0.42/piece at 1,000+ (4.25"×11", two-sided). Print is cheap; *distribution* is the service (labor to blanket neighborhoods) — that's the agency's margin.
- **Vehicle wraps:** full wrap $2,500–$5,500 (sedans $1,500–$2,500; trucks/vans $3,000–$5,500); partial wraps from $1,800; spot graphics $800+. One-time, 5–7 year lifespan — enormous impression volume per dollar, and agencies sell it as a project with 30–50%+ markup over installer cost.

## 2. Attribution for physical — and the synergy with R2/R5

How the industry measures OOH today, honest assessment included:

- **Dedicated phone numbers** → this is R5 (call tracking). A unique Twilio number on a billboard/mailer ties calls directly to the placement. The highest-signal attribution for phone-first local businesses.
- **QR codes + vanity URLs + promo codes** → feed R2 (attribution dashboard). Realistic expectations: QR scan rates on billboards are low (~0.5% of impressions in one published case study) — they work on mailers and yard signs far better than on highway bulletins. One agency's blunt take: "unless you're giving away free iPads, don't expect QR codes to work" on billboards.
- **Dedicated landing pages** per campaign/placement — Marketr already hosts pages; trivial to add and the cleanest digital bridge.
- **Search-lift + traffic monitoring** — Google Trends and site-traffic uplift during flight windows (AdQuick bakes this into its analytics). Marketr's rank/search tooling can do this natively.
- **Foot-traffic attribution** via anonymized mobile location data (Vistar, Spotzi/JCDecaux geofencing) — enterprise-grade, available through DSP partners, not something to build in-house.
- **Geo-lift / matched-market studies** — the gold standard for larger budgets; overkill for a $2,000 local flight.

**The synergy is the point:** R5 (call tracking) + R2 (attribution) make Marketr the only SEO platform that can put a billboard, a mailer, and a Google ranking on the same CPL/CAC dashboard. Agencies today sell OOH on impressions and vibes — Marketr can sell it on measured response, which is exactly the "prove dollars, not rankings" thesis.

## 3. Opportunity matrix

| Physical channel | What agencies charge | Marketr today | What Marketr could do | Metering fit | Build scope |
|---|---|---|---|---|---|
| Addressed direct mail (postcards/letters) | Bundled design+print+mail with markup; mgmt fees or retainer | Nothing | Campaign builder → Lob/PostGrid API: templates, AI copy (trust ladder), address verification, tracking webhooks | Per-piece credits (pass-through + margin, DataForSEO-style) | **API integration** — cleanest build |
| EDDM saturation | $0.35–$0.45/piece all-in sold at markup; design fees | Nothing | Route picker, creative design (studio), campaign management; fulfillment via USPS flow or EDDM print partner | Per-piece credits + design fee | **Concierge + software** (no EDDM API exists) |
| Digital billboards (self-serve) | Marked-up media + creative fees | Nothing | Flight planner (budget/geo/daypart), creative via studio module, booking via Blip/AdQuick referral or concierge | % of media spend or flat planning fee; creative as AI-word meter | **Referral/concierge now, API partnership later** |
| Static bulletins | 10–20% of media spend or retainer-bundled | Nothing | Media planning + creative + **attribution kit** (the measurable part); buying stays relationship-driven | Planning fee + attribution as tier upsell | **Do NOT build booking** — plan, design, measure only |
| Yard signs / door hangers | 50–100% markup on print + distribution labor | Nothing | Template design, order management, QR/number attribution; fulfill via wholesale vendor | Per-order handling fee + print pass-through | **Concierge** (vendor relationships) |
| Vehicle wraps | $2,500–$5,500 project with 30–50% markup | Nothing | Design via studio, installer referral network, QR/number attribution | Project fee / referral | **Referral only** — lowest priority |
| OOH attribution kit (numbers, QR, vanity URLs, lift dashboard) | Sold as "reporting" or not at all | R2/R5 planned | Bundle generator for any physical campaign regardless of who bought the media | Included in agency tier / per-campaign fee | **Pure software** — cheapest to build |

## 4. Ranked recommendations

### P1. Direct-mail automation via print API (metered per piece)

**Why first:** the only physical channel with a true developer API. Lob (or PostGrid — evaluate both on unit economics) turns "send 5,000 postcards" into an API call with tracking webhooks. Local/service clients already buy this from agencies at 2–3× the API cost — the margin is the product.

**Scope:** campaign builder (postcard/letter templates in the studio module), AI-drafted copy into an approval queue (trust ladder — mail is expensive and unrecallable), address verification + NCOA, house-list upload + purchased-list guidance, in-transit tracking via webhooks, QR/vanity-URL/promo attribution feeding R2, dedicated reply numbers feeding R5. Triggered sends (new-customer welcome, win-back, review-request mailers) compose with R3's nurture engine — the same lifecycle, physical edition.

**Metering fit:** per-piece credits at pass-through cost + margin, exactly the DataForSEO model. A $0.81 postcard = 81 credits (1 credit = $0.01) — the ledger already handles fractional-dollar actions; or bill physical media through the Stripe invoicing being built. **Trust-ladder fit:** creative approval mandatory (you can't unsend mail); repeat campaigns go autopilot.

**Honest note:** EDDM — the cheapest local saturation play — is *not* API-addressable. Marketr should still support it as a concierge flow (route selection + design + print-partner handoff) because it's the best value in local marketing, but the API build is addressed mail via Lob/PostGrid.

### P2. Physical attribution kit (pure software — the differentiator)

**Why second:** cheapest to build, works with *any* media buy (even one the client bought offline from a Lamar rep), and it's the thing agencies can't do — turning OOH from "impressions and vibes" into measured response. It also makes every other physical recommendation more valuable.

**Scope:** for any physical campaign, one-click generation of the measurement bundle — dedicated tracking number (R5), QR code with UTM (R2), vanity URL/landing page (existing hosting), promo code — plus a lift dashboard: calls, scans, landing visits, search-uplift, and cost-per-response against the media spend the user enters. Works for billboards, mailers, yard signs, wraps, door hangers.

**Metering fit:** included in agency tier or a per-campaign fee; tracking numbers/minutes already metered under R5. **Trust-ladder fit:** n/a (read-only measurement).

### P3. DOOH flight planner + creative (referral/concierge now, API partnership later)

**Why third:** real demand from local businesses (Blip's $10/day minimums prove the long tail exists), and Marketr's studio module already does creative. But there is no public booking API — so don't pretend to build one.

**Scope (Phase 1):** in-platform flight planner — budget, geography, dayparts, estimated impressions/CPMs from published rate data; billboard creative designed in the studio module (correct aspect ratios, 7-words-or-less OOH creative rules enforced by template); booking executed via Blip/AdQuick referral link or white-glove concierge, with Marketr taking an affiliate cut or planning fee. Phase 2: pursue a Vistar or AdQuick partnership for API booking once volume justifies the BD motion.

**Metering fit:** planning fee or % of media spend (billed via Stripe invoicing); creative generation under the existing AI-word meter. **Trust-ladder fit:** spend approval gates — no autopilot media buying without explicit budget authorization (this is real money leaving the account).

### P4. Physical fulfillment concierge (yard signs, door hangers, wraps)

**Why last:** genuine agency revenue (50–100% print markup, distribution labor, wrap project fees) but it's a vendor-relationship business, not a software business. Worth offering because the agency white-label tier should be able to sell "the full local stack" — but build it as order management, not infrastructure.

**Scope:** design templates in the studio module, order management UI (quantities, proofs, delivery tracking), wholesale vendor relationships for print (signs, hangers) and installer referrals (wraps), QR/number attribution from P2 on every piece. Marketr never touches a printing press.

**Metering fit:** per-order handling fee + print pass-through with markup. **Trust-ladder fit:** proof approval before any print order — misprints are expensive.

**Explicitly deferred:** static bulletin media-buying (relationship-driven, zero API surface — plan, design, and measure it via P2/P3, never try to intermediate the buy itself), and foot-traffic attribution via mobile location data (enterprise DSP territory).

## 5. What software should vs. shouldn't do here

- **Automate:** mail campaign execution (API), creative generation with approval gates, attribution measurement, route/geo planning, order management, reporting.
- **Concierge/partner:** EDDM fulfillment, DOOH booking (until a partnership lands), print fulfillment, wrap installation.
- **Keep human:** media-buy negotiation and budget politics (same line as AGENCY-COMPARISON §5), OOH creative *taste* (templates + rules, not "AI creative director"), and the client's actual spend authorization — autopilot never buys media on its own.

## Sources

- Billboard pricing by market tier (4-week flights, 2026 averages): https://www.plugtalk.media/post/how-much-does-billboard-cost · https://legalclarity.org/how-much-does-billboard-advertising-cost-rates-and-cpm/
- AdQuick marketplace (1,700+ media owners, live inventory map, campaign analytics): https://www.adquick.com/billboard-cost/lenexa-city-kansas · https://martech.org/adquick-launches-first-platform-online-booking-billboard-ads/
- Blip self-serve DOOH ($10–$20/day, pay-per-play auctions): https://help.blipbillboards.com/get-started-with-blip · https://help.blipbillboards.com/how-much-does-advertising-with-blip-cost · https://www.blipbillboards.com/self-serve/
- Programmatic DOOH landscape (Vistar/T-Mobile, Place Exchange, Basis, Blindspot per-play measurement): http://seeblindspot.com/best-dooh-platforms/ · https://www.vistarmedia.com/news/basis-technologies-and-vistar-media-automate-dooh?hs_amp=true · http://www.digitalsignagetoday.com/news/fattail-vistar-media-partner-to-integrate-dooh-booking/
- pDOOH foot-traffic measurement (VIOOH/Arla 2026 study): https://adtechtoday.com/viooh-and-arla-foods-reveal-how-programmatic-dooh-drove-real-world-performance-across-outdoor-campaigns-in-new-study/
- Lob API pricing (postcards ~$0.52–$0.81/piece all-in by tier; plans $260–$550/mo): https://www.lob.com/blog/how-to-send-postcards-as-effortlessly-as-email · https://www.saasworthy.com/product/lob-address-verification/pricing · https://www.lob.com/blog/how-to-calculate-your-direct-mail-campaign-costs
- Lob vs PostGrid vs Click2Mail: https://www.TrustRadius.com/compare-products/lob-vs-postgrid-print-mail · https://Sourceforge.net/software/compare/Click2Mail-vs-Lob/
- EDDM economics ($0.18–$0.21 postage, ~$0.35–$0.45 all-in): https://medium.com/@info_71668/what-eddm-actually-costs-and-why-most-quotes-hide-the-real-numbers-ed254986de82 · https://www.PSPrint.com/resources/what-is-eddm-every-door-direct-mail/ · http://about.usps.com/news/national-releases/2013/pr13_025.htm
- Yard sign / door hanger / vehicle wrap pricing: https://www.signsonthecheap.com/Pricing · https://uzmarketing.com/en/custom-yard-signs/?meta=new_audience · https://medium.com/@signonllc/how-much-does-a-vehicle-wrap-cost-in-florida-2026-pricing-guide-for-businesses-87aa643bb226 · https://www.sunrisesigns.com/fleet-branding/pricing
- OOH attribution methods (dedicated numbers, QR, lift studies; QR skepticism): https://mediafinch.net/how-to-measure-billboard-advertising-effectiveness/ · http://oneday.agency/blog/how-to-measure-out-of-home-advertising · https://deliberatedirections.com/ooh-advertising-roi-guide-business-owners/
- Agency pricing context: https://ddiy.co/marketing-agency-pricing/
