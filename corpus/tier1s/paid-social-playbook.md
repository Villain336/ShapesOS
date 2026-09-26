<!--
  Marketr Tier 1S synthesis playbook — ORIGINAL EXPRESSION.
  Synthesized from: Meta Blueprint (learn-only; not licensed for redistribution).
  Synthesis date: 2026-09-26. Author: Marketr (original: true).
  This text is Marketr-original and carries no verbatim academy content —
  ideas and standard industry practices expressed in our own words, with
  factual attribution to the source of the knowledge.
-->

# Paid Social Campaign Playbook

*Original synthesis of knowledge learned from Meta Blueprint. Ideas are expressed in Marketr's own words; factual attribution to Meta's official curriculum.*

## The three-level account structure

Every paid-social account on Meta's platforms runs on a three-level hierarchy, and each level has exactly one job:

1. **Campaign — the objective.** This is where you declare what you want the system to optimize toward: awareness, traffic, engagement, leads, app promotion, or sales. The objective you pick decides which auction signals the delivery system weighs. Choose the objective that matches the business outcome you can actually measure — if you pick "sales" but your conversion tracking is broken, the system optimizes toward noise.
2. **Ad set — the audience, budget, and placement.** This is where targeting lives: who sees the ads, how much you spend, and where they appear (Feed, Reels, Stories, Messenger, Audience Network). One variable per ad set: if you want to test two audiences, run two ad sets. Mixing variables at the ad-set level makes results unreadable.
3. **Ad — the creative.** The image, video, headline, copy, and call-to-action button. Each ad set should carry multiple ads (aim for three to six distinct creatives) so the delivery system has room to find the winner.

Never collapse these levels. The most common beginner error is setting budget at the campaign level while running five wildly different audiences in one ad set — the delivery system will simply feed the cheapest audience and you'll learn nothing.

## Campaign Budget Optimization vs. ad-set budgets

You can put budget at the campaign level (the system distributes spend across ad sets to the best-performing ones) or at the ad-set level (fixed spend per audience). Rules of thumb from practice:

- **Use campaign-level budgets when** you have a clear winner-takes-most setup and trust the delivery system to find it — e.g., scaling a proven offer across three similar audiences.
- **Use ad-set budgets when** you need guaranteed delivery per audience for testing — e.g., comparing interest targeting against a broad audience, where you need both to spend equally to get a fair read.

## Audience strategy: broad vs. targeted

Meta's delivery system has moved heavily toward automation. The working doctrine:

- **Start broad.** A broad audience (location + age + gender only, no interest layering) gives the system the largest pool to learn from, and modern delivery models are built to find converters inside it.
- **Use interest and behavioral targeting as constraints, not crutches.** Layer interests when you need to (niche B2B, regulated categories) or when broad exhausts.
- **Retargeting is a separate campaign, not an ad set inside prospecting.** Website visitors, video viewers, and engagers get their own campaign with its own budget and creative — different message (proof, urgency, objection-handling) for a different intent stage.
- **Exclusions matter more than inclusions at scale.** Exclude past purchasers from prospecting campaigns; exclude recent engagers from cold campaigns. Budget leakage into the wrong audience is invisible until you segment results.

## Creative is the targeting

As automated targeting has improved, creative has become the dominant performance lever. Operational rules:

- **Volume beats perfection.** Creative fatigue is the #1 account killer. Plan a refresh cadence: new concepts every 2–4 weeks for active accounts, faster when frequency climbs.
- **Native beats polished.** Ads that look like organic content (UGC-style video, lo-fi creator footage) consistently outperform glossy brand spots on Reels and Stories. Hook in the first 3 seconds; brand the product by second 5.
- **One idea per ad.** Each creative should sell exactly one angle: one pain point, one benefit, one offer. An ad that says everything says nothing.
- **Iterate winners, don't redesign them.** When a creative wins, produce variants: new hook on the same body, same hook with a new visual, tighter edit of the same footage.

## Measurement: the plumbing before the spending

Before raising budgets, the measurement stack must be correct:

1. **Conversions API (server-side events) alongside the browser pixel.** iOS privacy changes mean browser-only tracking underreports; server-side events recover a meaningful share of lost signal. Deduplicate events properly (same event_id from both paths).
2. **Standard events, named correctly.** Use the platform's standard event taxonomy (ViewContent, AddToCart, InitiateCheckout, Purchase, Lead, CompleteRegistration) rather than custom names wherever possible — standard events unlock more optimization and reporting features.
3. **Attribution windows set deliberately.** Shorter windows (1-day click) show a smaller but more confident number; 7-day click shows the full assisted picture. Pick one and keep it constant across tests — changing windows mid-test invalidates comparisons.
4. **Lift studies for truth.** When spend is material, run a conversion-lift or brand-lift study (holdout-based) rather than trusting last-touch reporting. Platform-reported ROAS overstates incrementality; lift studies measure what the ads actually caused.

## Testing discipline

- **A/B test one variable at a time** with the platform's native test tool (which splits audiences to avoid overlap) rather than eyeballing two campaigns.
- **Minimum viable test:** new creative concepts weekly, audience structure tests monthly, bid/budget strategy tests quarterly.
- **Kill rules in writing, before launch.** Define in advance: after $X spend with no add-to-carts, the creative is dead. After $Y with no purchases at target CPA, the audience is dead. Emotion-driven optimization is the fastest way to burn budget.

*Attribution: strategic knowledge learned from Meta Blueprint (Meta). Playbook text is Marketr-original.*
