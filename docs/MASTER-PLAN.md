# Marketr Master Plan — The Agentic Marketing Ecosystem

> Planning document (2026-09-23). No code, no commits, no purchases.
> Companion docs: `VISION.md` (press-ready vision), `AGENCY-COMPARISON.md` (R1–R5),
> `PHYSICAL-MARKETING.md` (P1–P4), `PROGRAMMATIC-DOOH-SCOPE.md` (media-buying paths).
> This plan cites those docs rather than re-deriving them.
>
> Note: `app/api/programmatic/*` in the repo today is **programmatic SEO**
> (generated pages/sitemaps) — unrelated to programmatic *media buying*.
> The media-buying scope must not collide with that namespace.

---

## 0. Where we stand (built and verified, local-only)

The foundation is real. Do not rebuild it; build on it.

| System | Status |
|---|---|
| Usage metering ledger (append-only, idempotent, per workspace/project/key) | ✅ shipped, batteries green |
| Stripe billing: top-up Checkout ($50→5k, $200→22k credits), signature-first webhooks | ✅ shipped |
| Overage invoicing: card-on-file gate, $0.012/credit, monthly cron, $5 minimum, replay-safe, `invoice.paid`/`payment_failed` webhooks, Settings → Usage UI | ✅ shipped (commit `688fcb3`) |
| Spend caps (hard-cap default, auto-overage opt-in), pre-execution blocking | ✅ shipped |
| SEO core: keyword research, SERP analysis, competitor gaps, rank tracking + visibility score, site audits + fix agent, content engine (brief→draft→editor→WP), decay engine, AI-search visibility | ✅ shipped |
| Fix agent on trust ladder (supervised → scheduled → autopilot, snapshot + rollback) | ✅ shipped — **the pattern every agentic module copies** |
| White-label: client workspaces, branded reports, scheduled PDFs, custom domain | ✅ shipped |
| MCP server (10 tools), scoped expiring revocable API keys, OAuth 2.1 + PKCE | ✅ shipped |
| Scheduler, workspace filesystem, connector health, alerting | ✅ shipped |
| Phase D LLM routing (copy → haiku-4-5, bulk → gpt-5-nano) | ✅ shipped |
| `api/ads`: campaign/creative factory (creative exists; **live spend management unproven**) | 🟡 partial |
| `api/social`, `api/newsletter`: posting/broadcast primitives, no lifecycle automation | 🟡 partial |
| `api/local/reviews`: review monitoring + sentiment, **no outbound requests** | 🟡 partial |
| No Lead object. No attribution. No SMS. No call tracking. No direct mail. No media buying. | ❌ missing |

**The single architectural fact the whole plan rests on:** everything below hangs
off the metering ledger, the trust ladder, and the billing rails. Every new
module must arrive with (a) a meter, (b) a ladder rung assignment, and (c) an
approval/audit story — or it doesn't ship.

---

## 1. Full scope

### Connective tissue (build first — everything depends on these)

**C1. Lead Pipeline CRM** — *pure software.*
What: `Lead` model (contact, source, stage, score, project/client linkage),
per-client pipeline Kanban, capture forms writing to it, dedupe, activity
timeline, lead scoring rules (source + engagement + fit). The central object of
the ecosystem: every channel feeds it. Meter: per active contact/lead (new
meter alongside keywords/AI-words/seats). Depends on: nothing new. Enables:
everything. *(AGENCY-COMPARISON §3.1)*

**C2. Revenue Attribution Dashboard** — *pure software, read-only.*
What: first-touch / last-touch / multi-touch attribution on the Lead model;
UTM + form-source + call-source tracking; per-channel CPL, CAC, ROAS; "revenue
influenced" per content piece and per campaign, digital and physical. This is
the retention moat (the WebFX/MarketingCloudFX lesson) and what justifies
performance pricing. Meter: none new — attribution quality is the tier upsell.
Depends on: C1. Enables: media buying, CRO, revenue-share pricing.
*(AGENCY-COMPARISON §3.2)*

**C3. Trust-Ladder Automation Framework** — *pure software (generalize existing).*
What: promote the fix agent's ladder into a platform primitive — every agentic
module declares its rung (supervised / scheduled / autopilot), its escalation
triggers, and its rollback story. Module registry + policy engine + audit log.
**Standing rule, no exceptions: media buying and money movement never reach
autopilot.** Meter: none (infrastructure). Depends on: nothing. Enables: every
agentic module below.

**C4. Metering + Billing extensions** — *pure software (extend existing).*
What: new meters (leads, messages, call minutes, mail pieces, media planning
fees), pass-through cost ledger (provider COGS tracked separately from margin),
media-wallet accounting (see §3). The ledger already handles fractional-dollar
actions. Depends on: existing ledger. Enables: all paid-execution modules.

### Pillar 1 — Digital dominance (mostly built; close the gaps)

| Module | What | Depends on | Meter | Execution |
|---|---|---|---|---|
| Paid ads management (close `api/ads` gap) | Google/Meta Ads API: live campaign management, bid/budget optimization, spend guardrails | C2 (prove ROAS) | % of managed spend or flat fee | API-driven |
| Email/SMS lifecycle engine | Drip builder, instant responder, missed-call text-back, reminders; Twilio-class provider | C1, C3 (TCPA/CAN-SPAM/quiet-hours enforcement) | Per-message credits, COGS pass-through + margin | API-driven |
| CRO / A/B testing | Experiment engine, landing-page variants, form analytics, heatmap-lite; fix-agent pattern extended to CRO | C2 (measure experiments) | Per-experiment or tier upsell | Pure software |
| Social engagement | Community management, comment triage | — (deprioritized; low revenue-link) | — | — |

### Pillar 2 — Physical marketing

| Module | What | Depends on | Meter | Execution |
|---|---|---|---|---|
| Direct-mail automation (P1) | Campaign builder → Lob/PostGrid API: templates, AI copy in approval queue, address verification/NCOA, tracking webhooks, triggered sends (welcome/win-back/review) | C1 (house lists), C3 (creative approval — mail is unrecallable), studio | Per-piece credits, pass-through + margin | **API-driven** — the only true physical API |
| Physical attribution kit (P2) | One-click measurement bundle per campaign: tracking number + QR/UTM + vanity URL + promo code + lift dashboard (calls, scans, visits, search-uplift, cost-per-response). Works with media bought anywhere | C2, call tracking | Agency-tier included or per-campaign fee | **Pure software** — cheapest build, ships before any buying |
| EDDM concierge | Carrier-route picker, creative, campaign management; fulfillment via USPS flow / EDDM print partner (no API exists) | Studio, P2 | Per-piece credits + design fee | Concierge + software |
| Fulfillment concierge (P4) | Yard signs, door hangers: templates, order management, proof approval, wholesale print vendors; wraps: installer referral network | Studio, P2 | Per-order handling fee + print pass-through w/ markup | Concierge (vendor relationships) |

### Pillar 3 — Media buying (the red lane)

| Module | What | Depends on | Meter | Execution |
|---|---|---|---|---|
| DOOH flight planner + concierge buying | Blip/Blindspot: planning UI (geo/dayparts/budget), OOH creative pipeline, per-buy approval → browser-agent execution → receipt capture | P2 attribution kit, C3, media wallet (§3) | Planning fee or % of spend; creative on AI-word meter | **Browser-agent-driven** (no public API — verified) |
| AdQuick partner API buying | Programmatic auction + guaranteed OOH (insertion orders — also solves static bulletins) via partner REST API; inventory discovery, campaign mgmt, delivery reporting | BD partnership, media wallet, C3 | % of spend or per-buy fee | **API-driven (BD-gated)** |
| Radio / newspaper / magazine | Media planning + creative adaptation + attribution kit; buying stays rep-driven (concierge: briefs, IOs, insertion tracking) | P2, C3, media wallet | Planning fee + % of spend | **Concierge/BD** — honest: no API surface, don't pretend |
| Commercials (TV/CTV) | Creative pipeline extension (storyboard → produced spot via studio + video partners), CTV buying via programmatic video (Madhive-type DSP path or AdQuick-style partner), linear TV concierge | Studio, media wallet, C3, AdQuick-scale volume | Project fee + % of spend | Concierge now; API/DSP later |

**Media-buying law (applies to every row):** supervised always; per-buy approval
of the exact order summary (inventory, dates, spend, creative proof, terms);
approvals can't be batched or pre-granted; pending approvals expire; autopilot
never buys; kill switches on cost-per-call/lead.

### Pillar 4 — Outreach & authority

| Module | What | Depends on | Meter | Execution |
|---|---|---|---|---|
| Guest-post outreach engine | Prospecting (SERP/backlink data already in-house), contact discovery, personalized pitch sequences, placement tracking, link attribution | Content engine (exists), C1, email infra (Pillar 1) | Per-prospect or per-placement credits | Software + API (email sending) |
| Digital PR | Newsworthy-angle drafting, journalist/influencer lists, pitch tracking | Content engine, C1 | Per-campaign credits | Software + concierge |
| Review generation engine (R4) | Post-transaction SMS/email requests, QR + "review us" landing pages, Google review-link mgmt, AI-drafted responses → approval queue, rating trends | C1 (triggers), messaging infra, C3 | Per-request credits; drafts on AI-word meter | API-driven (messaging) |
| Local listings / citation mgmt | NAP consistency, listing distribution, GBP management | `api/local` (exists) | Per-location fee | API-driven (aggregators) |

### Pillar 5 — AI relevance agents

| Module | What | Depends on | Meter | Execution |
|---|---|---|---|---|
| Answer-engine optimization agent | Track brand mentions across ChatGPT/Claude/Gemini/Perplexity (exists), then *act*: citation-gap fixes, entity/schema reinforcement, content tuned for answer engines | AI visibility (exists), content engine, C3 | Tier upsell / per-optimization | Software + supervised actions |
| Maps & review-site agent | Review velocity + rating management, photo/Q&A upkeep, local listing freshness | R4, local listings | Bundled with reputation tier | Software + approval gates |
| Directory & category agent | Submissions and profile maintenance across directories that feed AI answers | C1, content engine | Per-directory or tier | Software + concierge |

### The flywheel (Phase 7)

Attribution data feeds planning → winning creative propagates across channels →
budgets shift to what converts → compounding per client. Concretely: a
cross-channel optimization agent that proposes budget reallocation (human
approves — §3.1 autopilot money rules apply), a creative-recycling pipeline
(winning mailer → billboard variant), and client-facing supervised growth
reports (proposals + results; spend changes always human-approved).
Depends on: all of C1–C4 and at least one paid channel live.

---

## 2. Phased roadmap

Multi-quarter arc. Each phase lists its exit criteria — a phase isn't done until
its gates pass (tsc, build, M11, module batteries ×3, regressions, E2E where
user-facing, secret scan, independent verification, commit).

**Phase 0 — Foundation (DONE).** Metering, billing, overage invoicing, SEO core,
fix agent + ladder, white-label, MCP, scheduler. Exit: met.

**Phase 1 — The Lead object (1 build cycle).** C1 Lead Pipeline CRM: model,
pipeline UI, capture forms, dedupe, scoring rules, activity timeline; new
lead/contact meter. *Why first: every recommendation in every doc depends on
it. Nothing else is buildable without the Lead.* Exit: 40+ assertion battery on
lead lifecycle, tenant isolation proofs, E2E on capture→score→stage flows.

**Phase 2 — Prove dollars (1–2 cycles).** C2 attribution dashboard (multi-touch,
CPL/CAC/ROAS, revenue-influenced content) + P2 physical attribution kit
(tracking numbers need R5's number provisioning — build the Twilio number
layer here as shared infra) + R5 call tracking & booking (numbers, DNI,
recording/transcription summaries, booking pages, reminders). *Why: attribution
is the retention moat; the kit + call tracking make every later channel
measurable on day one.* Exit: attribution correctness battery (known-touch
sequences → expected credit splits), call-tracking E2E with fake telephony,
tenant isolation on numbers.

**Phase 3 — The acquisition loop (2 cycles).** R3 nurture (email/SMS lifecycle,
speed-to-lead, missed-call text-back — TCPA/consent/quiet-hours enforced by
C3) + R4 review engine (request triggers, QR pages, approval-queue responses).
*Why: highest-ROI automations in local; pure-margin upsell; both ride the
messaging infra built once.* Exit: compliance battery (consent states,
quiet-hours, opt-out handling), 3× battery runs, adversarial messaging tests.

**Phase 4 — First paid execution (2 cycles + BD in parallel).**
Direct-mail automation via Lob/PostGrid (campaign builder, approval-gated
creative, NCOA, tracking webhooks, triggered sends) + EDDM concierge flow.
In parallel: open the AdQuick BD conversation (partner terms, resale rights,
minimums). *Why: mail is the only API-native physical channel — real
pass-through margin with no browser-agent fragility; BD takes months, so start
it while building.* Exit: mail battery against Lob sandbox/test mode, webhook
idempotency proofs, cost-accounting reconciliation (ledger vs provider invoice).

**Phase 5 — Media buying v1 (2–3 cycles).** C3 generalized ladder + media
wallet (§3) + per-buy approval flows + kill switches first (the safety system
ships before the first dollar moves). Then: DOOH planner + Blip/Blindspot
browser-agent concierge; AdQuick API buying if BD landed. Radio/newspaper/
magazine concierge (planning + briefs + attribution; reps keep the signature).
*Why: safety infra before spend; concierge paths need no BD.* Exit: adversarial
buying battery (approval-binding, expired approvals, price-change between
approval and execution, kill-switch trips), receipt reconciliation, full audit
trail proofs.

**Phase 6 — Authority & relevance (2 cycles).** Guest-post outreach engine,
digital PR, local listings/citations, answer-engine optimization agent, maps/
review-site agent. Plus the **Onboarding Intelligence Report** (adopted from
the GrowthOS direction, 2026-09-25): connect the client's stack (site, GBP,
GA4, Search Console, ads, CRM, email, social) → a full audit pack (company
intelligence, market position, competitor map, website/brand/SEO/paid-media/
reputation/conversion/CRM/content/technology audits, revenue opportunities) →
a recommended 90-day Growth Plan. *Why: compounds everything above; outreach
rides the email infra from Phase 3; the Intelligence Report is the wedge demo
that sells the platform.* Exit: deliverability safeguards, placement-tracking
accuracy, no autonomous publishing without approval.

**Phase 7 — The flywheel + public launch (ongoing).** Cross-channel budget
reallocation agent (proposes, human approves), creative recycling, CRO/A-B
testing (deferred until attribution + volume exist), CTV/commercials buying
path, DSP seat when aggregate volume justifies it. Public launch: open-source
the core, commercial-license the ecosystem (see §4).

**Phase 8 — The agentic substrate: Business Graph + Campaign object + Growth
Memory (2–3 cycles).** Adopted from the GrowthOS direction (2026-09-25). A
per-client Business Graph (customers, competitors, products, services, prices,
brand, employees, locations, historical campaigns, reviews, website, CRM,
sales performance, creative assets, keywords, content, channels — continuously
updated, so no agent call starts from zero); the Campaign as a first-class
cross-channel object (research → offer → audience → messaging → landing page →
ads → email/SMS → social → retargeting → CRM pipeline → lead scoring →
reporting under one ID — ending the fragmentation of campaigns across ten
systems); Growth Memory (every experiment and outcome recorded — what worked,
what failed, when — queryable by every agent). *Why: the orchestrator is only
as smart as its memory; this substrate is the moat.* Exit: graph-completeness
battery, campaign-object E2E across three channels, memory recall correctness
proofs.

**Phase 9 — GrowthOS: the orchestrator (3+ cycles).** Adopted from the GrowthOS
direction (2026-09-25). A Chief Strategy Agent that decomposes a revenue goal
into a coordinated multi-agent plan ("Your revenue goal is $2M — here is the
audience, offer, landing page, ads, budget, email sequence, CRM pipeline, and
KPIs. Approve?") and delegates to the specialized executors; a command-bar UX
("What are we trying to accomplish?" — Linear + Ramp + Bloomberg + ChatGPT, not
HubSpot); Growth Missions as outcome products (Enter a New City, Launch a
Product, Fix Declining Growth — each an orchestrated multi-dozen-task run);
and a versioned Agent Playbooks library (new-location-launch.md,
recover-declining-seo.md, google-ads-high-cpl.md, …). Autonomy stays
ladder-governed: Copilot (AI recommends, human executes) → Approval Mode (AI
prepares, human approves, agents execute) as the default; the §3.1 autopilot
money rules are structural invariants here, not policy text — no mission or
playbook moves a dollar without a human-signed approval object. The 17-agent
roster from the vision doc collapses in implementation: one orchestrator plus a
handful of executor agents with tools, not seventeen separate agents. *Why:
this is the product the GrowthOS direction actually describes — an agentic
growth operating system, not another dashboard — built on the five verified
phases as its hands.* Exit: mission E2E (Enter a New City against fixtures),
orchestrator plan-quality review, full adversarial battery on delegated spend
(every dollar still approval-bound).

**Rough sequencing rationale:** dependency order is Lead → Attribution →
Engagement (nurture/reviews/calls) → Paid execution (mail, then media) →
Authority → Flywheel → Agentic substrate (graph, campaign object, memory) →
Orchestrator. Revenue starts in Phase 3 (review/messaging margin),
scales in Phase 4–5 (mail pass-through, media planning fees), compounds in
Phase 7, and the Phase 9 orchestrator turns the whole stack into the
retainer-replacement product. BD (AdQuick) runs parallel from Phase 4 — it must not gate Phase 5's
concierge paths.

**What's genuinely hard (no padding):**
- AdQuick resale rights for white-label sub-accounts — the BD term that can
  kill the API path; fallback (browser concierge) works but doesn't scale.
- Offline attribution is probabilistic — geo-lift, search-uplift, and
  foot-traffic are estimates, never ledger-grade; the dashboard must label
  confidence, not fake certainty.
- Radio/newspaper/magazine buying is and stays rep-driven — Marketr plans and
  measures; it doesn't intermediate. Scope discipline here.
- SMS/voice compliance (TCPA) and mail (unrecallable spend) make Phase 3–4
  the highest legal-risk builds — the ladder isn't optional there.
- Creative approval is a human gate at every media operator; "fully automated
  media buying" is not a real product, only supervised buying is.
- The connector long-pole: the GrowthOS direction assumes "access to your
  stack" — each of Google/Meta/LinkedIn/TikTok/HubSpot/Salesforce/Shopify/
  WordPress is its own OAuth, rate-limit, and gating story. Phase 9 timelines
  live or die here; sequence connectors by revenue impact.
- Cross-company intelligence (aggregate learnings across clients) stays
  opt-in only — agency clients will not accept their data training the
  commons by default. Aggregation thresholds plus explicit consent, or it
  kills the agency tier.

---

## 3. Security architecture

### 3.1 Trust ladder — per-module rung assignments

Generalize the fix agent's ladder into a platform registry: each module declares
its rung, escalation triggers, and rollback.

| Rung | Meaning | Assigned modules |
|---|---|---|
| Supervised | Agent proposes; human approves each action | All media buying, direct mail sends, SMS/voice sends (until consent history proven), review responses, guest-post pitches, creative submissions to operators, budget reallocations |
| Scheduled | Approved playbooks run on schedule; human reviews reports | Nurture drips (after N supervised cycles), review *requests* (not responses), rank checks, report generation, content refresh |
| Autopilot | Agent acts within policy bounds; human monitors | Fix agent safe-tier (existing), decay refresh briefs, attribution computation, lead scoring |

**Red-lane rule:** money movement and external reputation actions never reach
autopilot. Media buying is supervised *always* — not a ladder stage, not an
exception. Pre-approved budgets are planning constraints (caps/schedules/kill
switches gating *proposed* buys), never standing spend authority.

**Autopilot money rules (fixed 2026-09-25, non-negotiable):** autopilot NEVER
initiates, increases, decreases, reallocates, or pauses-then-restarts media
spend — any change to spend, of any size, requires a human-signed approval
(per-buy approval or pool-cap approval). The lighter-approval lane inside a
human-approved pool cap is the maximum automation allowed near money, and the
pool's auto-approve threshold defaults to disabled until dogfooding proves the
encumbrance math. No agent, mission, playbook, or orchestrator may move,
commit, or reallocate a dollar without a human-signed approval object.
"Growth autopilot" anywhere in this plan means supervised optimization
*proposals* and reporting — never autonomous spend.

### 3.2 Media-buying gates (the red lane, concretely)

1. **Per-buy approval binding:** the approval token cryptographically binds the
   exact order summary — inventory, dates, dayparts, total spend, creative
   hash, payment instrument, operator terms version. If *anything* changes
   between approval and execution (price moved, board substituted), the token
   is invalid and the buy re-enters approval. This kills TOCTOU attacks and
   "the price changed" accidents alike.
2. **Approval expiry:** pending checkouts expire (e.g. 24h); no stale approvals.
3. **Execution sandbox:** the browser-agent executor runs with least privilege —
   no access to other workspaces' budget pools, no free-form navigation beyond the
   operator's purchase flow, DOM-level confirmation of the final order summary
   before the last click, receipt capture and reconciliation against the
   approved terms.
4. **Kill switches:** auto-pause *proposals* when cost-per-call/lead exceeds
   configured thresholds; breach surfaces to the human; resume requires
   re-approval. Circuit breaker on provider errors (3 failed executions →
   freeze the channel, alert).
5. **Prompt-injection defense for browser agents:** operator pages are
   untrusted content. The executor must treat page text as data, never
   instructions; confirmation screens are parsed against the approved order,
   not obeyed. Any mismatch = halt + alert.

### 3.3 Wallet separation — three monies, never mixed

1. **SaaS billing** (existing): Stripe customer + card on file for Marketr
   subscriptions, top-ups, overage invoices. (Shipped.)
2. **Budget pools** (new, per client workspace, non-custodial): encumbrance-tracked
   spend caps against the client's own payment instruments. Client money never
   enters Marketr — the pool is an accounting and enforcement object, not a
   balance. Optionally backstopped by virtual cards issued on the client's own
   Brex/Ramp accounts (Marketr stores only card refs, never PANs).
   **Decided in Phase 5 (2026-09-25): zero custody.** Marketr never holds,
   fronts, or co-mingles client media funds — spend flows from the client's
   own accounts/cards; Marketr plans, proposes, and executes against explicit
   approvals. No money-transmitter exposure by design; the earlier open
   question is closed.
3. **Pass-through accounting** (new): provider COGS tracked separately from
   Marketr margin in the ledger; monthly reconciliation (ledger vs. provider
   invoices: Lob, Twilio, Blip, AdQuick) as a scheduled job with alerts on
   drift.

White-label fit: each agency client workspace gets its own budget pools; the
client funds their own instruments; the agency sees spend but can't silently
draw from other clients' pools.

### 3.4 Tenant isolation (white-label agencies)

- Workspace-scoped everything: leads, numbers, wallets, approvals, audit logs.
  The existing metering ledger already attributes per workspace — extend the
  same scoping to CRM records, tracking numbers, and budget pools, with
  battery-proven cross-workspace access denials.
- Sub-accounts: agency staff roles (owner / media buyer / viewer) with
  least-privilege; media-buyer role can propose but not approve; approvals
  require owner or designated approver. Separation of duties is a fraud
  control, not just UX.
- Client logins see only their workspace's branded surface — no Marketr
  branding, no sibling-client data, no platform internals.

### 3.5 Approvals, audit, credentials

- **Approvals:** typed approval objects (buy / send / publish / respond),
  bound to exact terms (see 3.2), with approver identity, timestamp, and
  expiry. Every consequential action links to its approval; actions without
  one are rejected at the service layer, not just hidden in UI.
- **Audit trail:** append-only audit log per workspace — plans, approvals,
  executions, receipts, delivery reports, failures. Same idempotency and
  replay-safety discipline as the metering ledger.
- **Credentials:** OAuth for operator/DSP integrations where available;
  workspace-scoped API keys encrypted at rest, never logged; stored payment
  methods live with Stripe (or the operator), never as raw PANs in Marketr's
  DB. Key rotation support; per-workspace revocation.

### 3.6 Abuse & fraud (a platform that buys ads is a fraud target)

- **Spend velocity limits:** per-workspace daily/weekly media caps, new-wallet
  warming (low limits until history), anomaly detection (spend spike vs.
  baseline → freeze + alert + require re-approval).
- **Identity verification for spend-enabled workspaces:** card-on-file (already
  built) plus verified business identity before media buying unlocks —
  ad platforms are money-laundering and stolen-card magnets; Marketr must not
  become the laundry.
- **Attribution fraud awareness:** tracking numbers/QRs can be gamed by
  publishers; treat self-reported delivery data as claims, reconcile against
  independent signals (call logs, landing visits) before it feeds budget
  decisions.
- **Outreach abuse:** guest-post and PR modules need rate limits and
  reputation guards — Marketr must not become a spam cannon that burns
  clients' domains.

### The 3 hardest security problems (named plainly)

1. **Approval binding under browser-agent execution.** A browser agent driving
   Blip's checkout with a stored payment method is a confused-deputy risk:
   page content is untrusted, prices change, flows get A/B tested. The
   approval must bind the exact terms and the executor must re-verify them at
   the final screen — anything less is "the agent bought something the human
   didn't approve."
2. **Client-money custody.** Media wallets holding client funds create
   reconciliation, fraud, and possibly money-transmitter exposure. The
   architecture must support the fallback (client pays operator directly)
   from day one, because counsel may require it.
3. **Cross-tenant isolation at agency scale.** White-label means one
   deployment holds many agencies' clients' leads, calls, wallets, and
   approvals. A single scoping bug leaks one client's pipeline to another.
   This needs battery-proven isolation per module, not just schema-level
   `workspaceId` fields.

---

## 4. Shipping strategy

### 4.1 Staged rollout

1. **In-house beta (Launchabl dogfooding).** Tico's agency runs client work on
   each phase before it reaches anyone else — per SPEC §4, case studies are
   the distribution engine. Every phase exits to Launchabl first; real client
   spend and real leads validate before design partners see it.
2. **Agency design partners (3–5).** Hand-picked agencies on the commercial
   license; direct feedback channel; co-build the white-label surfaces.
   Revenue starts here: $199/mo agency tier + usage margin.
3. **Public launch.** Open core + commercial ecosystem (see 4.2), Product Hunt,
   agency-partner case studies as the launch assets.

### 4.2 License split (AGPLv3 + commercial)

Current posture (SPEC §10): AGPLv3 + commercial white-label license. For the
ecosystem arc, split deliberately:

- **Open core (AGPLv3):** research, content engine, rank tracking, audits +
  fix agent, reporting, attribution *computation* (the math, not the hosted
  data pipelines). This is the "open-source marketing OS" promise and the
  top-of-funnel.
- **Commercial-only:** Lead CRM multi-tenancy, messaging execution (SMS/voice),
  direct-mail execution, media buying + wallet machinery, browser-agent
  executor, and the hosted attribution data pipelines. Rationale, stated
  plainly: (a) these are the money-moving modules — self-hosters shouldn't get
  unsupervised spend machinery without the safety infra and the abuse controls;
  (b) AGPL on the full agency-in-a-box gives competitors the whole product;
  (c) the commercial tier is what funds the open core. **This is a decision
  for Tico**, not a settled fact — the tradeoff is community trust (open
  everything) vs. defensibility (hold the money modules).

### 4.3 Revenue sequencing (which modules carry margin earliest)

| When | Module | Margin shape |
|---|---|---|
| Phase 3 | Review generation engine | Pure margin — $150–$400/mo agency add-on, near-zero COGS (AGENCY-COMPARISON §3, R4) |
| Phase 3 | SMS/voice + nurture | Per-message pass-through + margin; real COGS, DataForSEO-style economics |
| Phase 4 | Direct mail (Lob) | Per-piece pass-through + margin at 2–3× API cost; triggered sends compound with nurture |
| Phase 4–5 | Call tracking | Per-number + per-minute pass-through + margin |
| Phase 5 | Media buying | Planning fees + % of spend; the retainer-replacement pitch ("run your $3k/mo retainer delivery on a $199 platform") |
| Phase 6–7 | Outreach + AI relevance | Per-placement / tier upsell; retention value more than direct margin |
| Phase 7 | Performance pricing | 10–15% revenue share or pay-per-lead — only possible once C2 attribution is airtight; Tico's agency proves it first |
| Phase 8–9 | GrowthOS orchestrator + Missions | Per-mission fees + platform tier uplift; the retainer-replacement product — planning fees scale with managed spend, never custody |

The business-model shift, restated: from "replace your $400/mo SEO stack" to
"run your $3k/mo retainer delivery on a $199 platform" to "the growth engine
that proves its own revenue." Each step is funded by the margin of the last.

### 4.4 What "done" looks like per phase

Every phase ships only when: TypeScript clean, production build green, M11
security battery green, module battery green ×3 consecutive runs, all
regression batteries green, Playwright E2E on a fresh production server +
fresh DB where user-facing, secret scan clean, independent verification before
commit, `screenshots/` excluded. This is the standing bar — the ecosystem arc
doesn't lower it; more money movement means *more* adversarial testing, not
less. New standing batteries per phase: tenant-isolation proofs (Phase 1+),
compliance battery (Phase 3), webhook/reconciliation proofs (Phase 4),
adversarial buying battery (Phase 5).

---

## Appendix A — Decisions needed from Tico

1. **License split (§4.2):** open core + commercial money-modules, or open
   everything? Defensibility vs. community trust.
2. **Client-money posture (§3.3):** hold client funds in media wallets, or
   client-pays-operator-directly with Marketr on planning fees? Needs
   counsel's read before Phase 5 regardless.
3. **AdQuick BD:** authorize the outreach (draft exists from the scope
   conversation) — the partnership clock starts when you say go.
4. **Phase 1 approval:** spec the Lead Pipeline CRM now? Everything downstream
   waits on it.

## Appendix B — Doc map

- `VISION.md` — press-ready vision (the why)
- `AGENCY-COMPARISON.md` — R1–R5 digital recommendations (the what, digital)
- `PHYSICAL-MARKETING.md` — P1–P4 physical recommendations (the what, physical)
- `PROGRAMMATIC-DOOH-SCOPE.md` — media-buying access paths + build scope (the how, media)
- `MASTER-PLAN.md` (this doc) — full scope, phasing, security, shipping (the plan)
