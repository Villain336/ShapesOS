# Marketr — Beyond Phase 10: Growth-Loop Brainstorm

BRAINSTORM ONLY (2026-09-26). Nothing here changes any build, plan, or spec.
Question asked: what ELSE does Marketr need to fulfill "help people build and grow their startup"?

## Thesis

Phases 0–10 make Marketr excellent at **acquisition** (SEO, content, AEO, outreach, community, paid-media safety). The startup growth loop has five stages — acquisition is one. The gaps cluster in four places:

1. **Before acquisition:** validation, waitlists, launch mechanics.
2. **Beside acquisition:** referral loops, creators, affiliates, lifecycle email — the compounding loops.
3. **After acquisition:** activation, retention, churn, expansion — the leaky bucket.
4. **Above it all:** founder-level metrics and pricing — the numbers that decide whether the startup lives.

Everything below respects the non-negotiables: zero custody of client spend, autopilot never buys media, human-signed authority on every dollar, draft-first/approval-driven for anything public-facing, AGPLv3 + commercial, locked design system.

## Priority tiers

- **Tier 1 → Phase 13 candidate ("Growth Loops"):** the ten features below, ranked.
- **Tier 2 → Phase 14+:** real but later.
- **Cut list** at the bottom: ideas considered and rejected, with reasons.

---

## TIER 1 — Phase 13 candidates (ranked)

### 1. Referral Program Engine
- **What:** In-product referral loops: double-sided rewards, referral links + attribution, fraud guardrails (caps, reversal on refund/dispute), leaderboard, viral-coefficient dashboard.
- **Why / who:** For every PLG founder (Persona A) and as an agency upsell. Referral is the cheapest acquisition channel that exists and the only one that compounds without ad spend.
- **Gap today:** Nothing in Marketr covers referrals. Closest is Dub OSS QR/pURL links (Phase 5) — plumbing, not a program.
- **2026 evidence:** Dropbox's program grew signups 60% in a year (the canonical benchmark); GrowSurf charges ~$99/mo for SaaS-specific referral tracking; B2B SaaS growth playbooks place "build the referral loop" at Stage 1 (0→$100K MRR). The loop-marketing playbook pattern (share → visit → buyer → share, with anti-abuse caps) is now standardized open knowledge.
- **Phase:** 13. Natural Growth Mission type ("Referral loop launch").

### 2. Launch Command Center
- **What:** Structured launch missions: Product Hunt / Hacker News / Reddit / BetaList / directory stack with a T-4-weeks-to-launch-day checklist, asset prep (tagline, gallery, maker comment drafts), hunter/supporter outreach sequencing, channel-stacking timeline (all channels same day, not spread across weeks), launch-day war room (comment triage), post-launch follow-up.
- **Why / who:** Every founder launching anything; agencies launching clients. Launch day is the highest-leverage 24 hours a startup gets and it's currently run from spreadsheets.
- **Gap today:** None. M8 (Phase 10) covers ongoing community participation; a structured launch-day operation is distinct.
- **2026 evidence:** 2026 PH field data: Daily #1 ≈ 3–5k visits and ~$5–15k MRR uplift; 2026 algorithm added account-age weighting (~5x veteran weight); open 47-task launch checklists exist; the "stack channels same-day" mechanic is the current best practice. Marketr's own success metrics (docs/specs/SPEC.md §12) target "Product Hunt top-5" — dogfood this on ourselves.
- **Phase:** 13. Ships as Growth Mission templates + command-bar "Do" actions.

### 3. Founder Metrics Command
- **What:** The business dashboard above the marketing dashboard: activation rate, retention cohorts (D1/D7/D30), trial-to-paid, CAC/LTV, payback period, NRR, burn multiple. Stripe read-only + product-event ingestion (PostHog/Segment/GA4). Investor-ready exports.
- **Why / who:** Founders (Persona A) live in these numbers; agencies report them to clients. "Help people grow their startup" is hollow without the numbers that decide survival.
- **Gap today:** The visibility score is marketing-only. No business metrics anywhere in the product.
- **2026 evidence:** Baremetrics ($50+/mo) and ProfitWell (free+paid) prove willingness to pay for exactly this; every 2026 growth playbook centers these metrics (trial-to-paid 10–25% healthy, NRR ≥90% to raise). Read-only Stripe access keeps the zero-custody invariant intact.
- **Phase:** 13.

### 4. Churn Prediction + Win-Back Missions
- **What:** At-risk scoring from Stripe + usage signals (engagement decay, support friction, payment failures), ranked by revenue at risk, with win-back playbooks drafted per segment (offer, timing, channel) — all draft-first, human-approved. Includes involuntary-churn (dunning) guidance.
- **Why / who:** Retention is the other half of growth; a 5% churn reduction compounds harder than a 5% acquisition lift. Agencies can sell "churn rescue" as a service line.
- **Gap today:** None. The content-decay engine watches *pages*; nothing watches *customers*.
- **2026 evidence:** Churnkey reports ~34% average save rates on cancel flows; Vitally charges $150+/mo for health scoring; churn-prediction agent skills are now commoditized open knowledge (15+ signal models, Stripe/HubSpot/GA4 integrations). The patterns are proven; nobody bundles them into a marketing OS.
- **Phase:** 13. Feeds Growth Memory like every other signal.

### 5. Agent-Readiness Audit (the honest version)
- **What:** Audit of how AI agents experience the user's site: robots.txt AI-crawler directives, agent accessibility (no JS walls for agent fetchers), structured data/quotability, API/MCP surface checks, llms.txt *only where it matters* (docs/devtools sites — the one place with real coding-agent consumption). Scored, with fix queue flowing into the existing fix agent.
- **Why / who:** "AEO" covers answer engines; this covers the *agentic* web — the buying assistants and research agents that will increasingly act on behalf of users. Differentiator nobody owns honestly.
- **Gap today:** A1/AEO (Phase 6) + M3 (Phase 10) cover visibility *inside* AI answers. Agent *accessibility* of the site itself is uncovered.
- **2026 evidence:** July 2026 "State of the Agentic Web" study (84 prominent sites): 36% publish llms.txt, only 26% give AI crawlers robots.txt rules, 18% block automated visitors outright. Crucially: Ahrefs found 97% of llms.txt files got zero requests — so the audit must score what agents *actually* consume (robots.txt, accessibility, structure), not llms.txt hype. Synergy: BriefNow turns businesses into AI connectors; Marketr makes them agent-ready.
- **Phase:** 13. The honesty ("we don't sell llms.txt snake oil") is the brand play.

### 6. Viral Waitlist + Pre-Launch Pages
- **What:** Hosted pre-launch pages with referral-position waitlists: position reveal, referral-link climbing, milestone rewards (queue jumps, founder pricing), confirmation + nudge email sequences, admin dashboard, embed widget.
- **Why / who:** Pre-revenue founders — the earliest point Marketr can enter a startup's life. Captures users *before* they need SEO.
- **Gap today:** None. Marketr starts at "you have a domain."
- **2026 evidence:** WaitlistKit (free→$29/mo, validation surveys + interview booking), Viral Loops ($34/mo), Waitlister ($19/mo, ships an MCP server) — the category is validated and cheap; open-source waitlist-rocket proves it's buildable in a weekend. The waitlist→launch-day pipeline ("grant access in waves starting with top referrers") is standardized playbook knowledge.
- **Phase:** 13.

### 7. Pricing & Packaging Intelligence
- **What:** Competitor pricing-page tracking (extends the M4 competitor fleet with pricing-specific parsing: plan names, prices, value metrics, "most popular" labels, change alerts), tier normalization across competitors, plus DIY research tooling: Van Westendorp surveys, MaxDiff packaging analysis, trial-to-paid conversion as a pricing signal (>40% = underpriced, <10% = too high or funnel friction).
- **Why / who:** Pricing is the highest-leverage growth decision and founders do it by gut. Agencies can productize pricing audits.
- **Gap today:** M4 (Phase 10) tracks competitor *page changes*; pricing-specific intelligence with research methodology is distinct.
- **2026 evidence:** Tierly (free tier, AI tier-scoring for SaaS), Klue/Crayon at $15–30K/yr (enterprise CI proving the budget exists), and standardized heuristics (price at 10–20% of documented value; usage-based pricing as a growth lever per Datadog/MongoDB/Snowflake). Nobody serves this at Marketr's price point.
- **Phase:** 13.

### 8. UGC Engine (pillar — Tico directive 2026-09-26)
- **What:** a first-class user-generated-content loop with three stages. **Collect:** NPS/review-triggered capture of testimonials, ratings, photos, and video from real customers — permission-first, with usage rights tracked per asset. **Create:** creator discovery and outreach plus AI-generated UGC briefs (hooks, scripts, shot lists) in the Okara pattern — draft-first, humans send. **Deploy:** UGC → ad-creative pipeline feeding the Phase 12 creative editor (testimonial cuts, review overlays, before/after formats), proof blocks for landing pages, and review-site seeding (G2/Capterra/AlternativeTo).
- **Why / who:** UGC is the highest-converting creative class in paid social and the scarcest asset for small brands — collection is the bottleneck, and agencies can productize "UGC programs" as a retainer line. Tico's MANNA TikTok operation is the internal case study.
- **Gap today:** R1 (Phase 6) handles review *replies*; collection + creator briefs + creative repurposing is the gap. Absorbs the former standalone "Testimonial / Social-Proof Engine" and "Creator/Influencer Outreach" proposals into one loop.
- **2026 evidence:** The "proof/UGC trust loop" (buyer → proof submission → public proof → new visitor) is standard 2026 playbook; Okara ships UGC briefs as a core agent; creator-marketplace rates make in-house UGC programs the cost-efficient alternative for SMBs.
- **Phase:** 13. Rights tracking per asset is load-bearing — never deploy a customer asset without recorded permission.

### 9. Lifecycle Email Playbooks
- **What:** Onboarding drips, activation nudges, trial-expiry sequences, win-back series — designed in Marketr, *sent through the user's own ESP* (Resend/Loops/Customer.io). Marketr drafts, scores, and triggers; it never becomes a bulk sender.
- **Why / who:** Lifecycle email is the highest-ROI channel per dollar and the connective tissue between acquisition and retention.
- **Gap today:** Partial — Agent Playbooks already include "cart abandon email series" and "review request drip" as demos, but there's no lifecycle engine (triggers, sequencing, ESP integration).
- **2026 evidence:** Loops, Customer.io ($39–100+/mo) prove the spend; every 2026 growth playbook sequences email as the waitlist→launch→activation spine. Honest note: email marketing was an explicit MVP non-goal (docs/specs/SPEC.md §8) — this proposal respects that by integrating with ESPs rather than building a sender.
- **Phase:** 13.

### 10. Idea Validation Engine
- **What:** Pre-build demand scoring: trend analysis across GitHub/social/Product Hunt, search-demand sizing, competitor-density mapping, "gravitational pull" report — a go/no-go brief before a line of code or a dollar of marketing.
- **Why / who:** Tico's standing idea-validation preference ("validate against what people are actually gravitating toward"). Serves founders at the idea stage — earlier than even the waitlist.
- **Gap today:** None in-product; it's a standing rule, not a feature.
- **2026 evidence:** WaitlistKit bundles validation surveys + auto-booked user interviews into the waitlist flow — validation-as-a-feature is an emerging pattern. Tico's own portfolio process (10-product brainstorm with trend analysis) is the internal case study.
- **Phase:** 13. Smallest build of the ten; could ship first as the wedge into pre-launch.

---

## TIER 2 — Phase 14+ (real, but later)

11. **Creator/Influencer Outreach** — absorbed into the UGC Engine pillar (#8): creator discovery, UGC briefs, campaign tracking live there now. Distinct from O2 (journalists). Evidence: Okara's influencer matching + UGC briefs; Tico's MANNA TikTok operation validates the need firsthand.
12. **Partnership/Affiliate Manager** — partner discovery, affiliate link tracking, commission accounting with human-approved payouts (zero-custody safe). The B2B distribution channel Marketr doesn't touch.
13. **Activation/Onboarding Analytics** — funnel analysis, aha-moment identification, onboarding checklists feeding Test Lab experiments. ("Build the sticky onboarding loop" — the #1 PLG tactic in 2026 playbooks.)
14. **Expansion Revenue Engine** — usage-based upgrade triggers, upsell/cross-sell playbooks, annual-plan nudges. Human-approved; money-adjacent.
15. **NPS / Voice-of-Customer Loop** — surveys → triage → testimonial routing or support escalation; feeds M9's knowledge base with real customer language.
16. **Community-Building Playbooks** — branded community (Discord/Slack), ambassador programs. Distinct from M8 (participating in *others'* communities).
17. **Content Syndication** — distribute to Medium/LinkedIn/dev.to, cross-format repurposing. Extends F2 creative recycling outward.
18. **Deliverability Command** — inbox placement monitoring, warmup guidance, spam-score checks for O1 outreach. (Partially covered by the Phase 5/6 deliverability brainstorm.)
19. **Social Scheduling (draft-first)** — X/LinkedIn drafts queued to connected accounts via official APIs with approval. Explicitly *not* a Buffer clone; respects the MVP non-goal by staying in the draft/approve layer.
20. **International Expansion Kit** — hreflang audits, localized keyword research, translation workflows. Real need, wrong wedge order.

## Cut list (considered, rejected)

- **Hiring/ops/finance tooling** — not marketing/growth. Out of scope, no debate.
- **Investor CRM / deck builder** — fundraising ops, not growth. Cut.
- **Building a bulk email sender** — deliverability liability + the MVP non-goal. Integrate, don't build.
- **Autoposting to Reddit/HN** — violates the draft-first invariant and community norms; M8's human-posts-natively design is the correct and final answer.
- **PPC campaign management** — autopilot never buys media is structural; propose-only reallocation (F1) is the ceiling.
- **Webinar/event platform** — weak differentiation; fold event mechanics into Launch Command Center missions instead.
- **Mobile companion app** — Tico deprioritized mobile surfaces; the responsive web app suffices.
- **Multilingual content engine** — real need, but a Phase 15+ concern for the current wedge.

## Suggested sequencing

- **Phase 13 "Growth Loops"** (Tier 1, in rank order): referral engine → launch command center → founder metrics → churn/win-back → agent-readiness audit → waitlist → pricing intel → testimonial engine → lifecycle playbooks → idea validation. The first five are the revenue story; the last five widen the top of funnel into pre-launch.
- **Phase 14 "Compounding"** (Tier 2): creators, affiliates, activation analytics, expansion revenue, VoC, community building, syndication, deliverability, social scheduling.
- **Do not fold into Phase 10:** it already has 9 modules (M1–M9). Growth loops deserve their own phase with their own verification battery.
