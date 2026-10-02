# Marketr → Business OS: Expansion Brainstorm

**Date:** 2026-09-28
**Status:** PRE-SPEC brainstorm. Nothing here is approved or decided. This feeds the spec-first process; no in-flight builds (13B→13C→13D queue, keeper, preview) are touched by anything in this doc.

## 1. The move

Marketr graduates from "marketing & SEO workspace" to a **Marketing + Design + Business Ops agentic SaaS**. The promise: *launch, operate, and grow your business or product — one OS.*

**Why this can win (landscape, verified 2026-09-28):** the "AI business OS" wave is real and heating up from two sides —
- **Pantheon** (announced Sept 23, 2026): "agentic AI creative operating system for mobile app growth" — creative/growth loop for mobile studios. Competes with the Grow pillar only, in one niche.
- **oc8** (open-source): AI agent orchestration across ERP, CRM, Microsoft 365 via MCP, with approvals and audit trails. Closest to the Operate vision — but enterprise orchestration that assumes you already have a stack.
- **GrowERP** (Apache 2.0): "AI-agent-first ERP" for SMB, dogfoods itself, trial→paid hosted. Closest direct competitor — but ERP-first, no launch wedge, no design pillar.
- **SAP Joule / Oracle:** top-down enterprise agents. Validates the category; not a threat at SMB.

**The hole:** everybody builds for businesses that already exist. **Nobody owns LAUNCH** — idea → first revenue. Launch is the top of the funnel that feeds Operate and Grow, and it's the wedge none of the above can claim. Design as a first-class pillar (not a feature) is the second gap.

## 2. Positioning directions

**A. Solo-founder OS** — one operator + agents runs the whole company. Audience: indie hackers, creators, operators like Tico. Smallest scope, fastest to "it works."
**B. Agency OS (white-label)** — agencies run clients' marketing + ops from one shell. Fits Launchabl directly; commercial-license story already exists in the docs.
**C. Portfolio OS** — for operators running many ventures in parallel (literally Tico). Multi-entity, multi-brand, one shell. Dogfood across MANNA, faith TikTok, senior directory, BriefNow, etc.
**D. AI-native ERP from below** — outflank the QuickBooks/NetSuite/HubSpot bundle for SMB. Biggest TAM, heaviest lift; GrowERP and the incumbents are already there.

*Working recommendation: lead with A, sell B, dogfood C, defer D.* (Tico's call.)

## 3. The three pillars

### LAUNCH (new — the wedge nobody owns)
- **Offer validator:** niche research → landing page (existing LP builder) → waitlist → pre-sales. Kill bad ideas in days.
- **Brand kit generator:** logo, palette, typography (Higgsfield brandkit skill exists) → feeds the locked dynamic brand-color theming.
- **Entity setup track:** LLC/EIN checklist, bank connect (Plaid), business-credit starter track.
- **Storefront launcher:** Shopify / Amazon / TikTok Shop provisioning from the brand kit + first products listed.
- **BriefNow tie-in:** "turn this business into an AI connector" on day one — distribution built in at birth.

### OPERATE (new — the machine)
- **Money:** Plaid transactions + Stripe/Square/PayPal → cashflow, runway, and the attribution endgame ("did marketing actually make money").
- **Books:** QuickBooks MCP (official) sync, receipt capture, tax-deadline calendar.
- **Sell & fulfill:** orders from every channel in one inbox; Shippo/EasyPost shipping; inventory alerts.
- **Support:** shared inbox with AI drafts + approval queue. (Business support — distinct from the shelved *personal* messaging copilot, which stays shelved.)
- **Team:** hiring track (post → screen → offer), contractor payments.
- **Compliance:** SAM.gov watch for gov contractors, license/renewal reminders.

### GROW (existing Marketr core, reframed as pillar 3)
- Everything already built/queued: keyword + backlink vault (DataForSEO), content engine, 13B agent-learning layer, 13C clipper → Postiz, 13D voice agents, ads, community features (Okara-style, parked), affiliate.
- **Design cross-cuts all three:** Polotno clone as the creative studio (Phase 12 candidate), brand-kit enforcement everywhere, dynamic theming already locked.

## 4. MCP / connector catalog

**Doctrine:** official-first; everything else gets built in **BriefNow**; the OS consumes connectors off the shelf. Commercial actions = **draft-for-approval** (extends "autopilot never buys media" → "autopilot never publishes a commercial asset unapproved"). Read-only money data = safe lane, no approval needed.

| Pillar | Connector | Source | Notes |
|---|---|---|---|
| Launch | Shopify Admin | Official MCP | Products/collections/orders — publish from campaigns |
| Launch | TikTok Shop | Community wrap of official API | Orders, messages, reviews |
| Launch | Amazon SP-API | Wrap in BriefNow | Listings/keywords — the Marketr-shaped slice, not Brand Stores |
| Launch | SAM.gov | Official free API | Contract opportunities feed |
| Launch | Stripe | Official MCP | First payment, billing |
| Operate | Plaid Transactions | Wrap in BriefNow | Official MCP is dev-dashboard only, not end-user bank data |
| Operate | Square / PayPal | Official MCPs | POS + payments coverage |
| Operate | QuickBooks | Official MCP | Books sync |
| Operate | Ramp | Official remote MCP | Spend management |
| Operate | Shippo / EasyPost | Wrap in BriefNow | Shipping |
| Operate | Gmail / Slack / Calendar | Official | Comms + scheduling |
| Grow | DataForSEO, Postiz | Existing | Already in the stack |
| Grow | Meta Ads / TikTok Ads | Community | Reporting + GMV Max |
| — | Uline / Grainger | — | **Avoid:** no public APIs (web/EDI-only), fragile |
| — | D&B / Experian / Creditsafe | Enterprise APIs | Park unless a "business health" panel is wanted |

## 5. Repo architecture

**A. Monorepo** (`~/workspace/marketr`): `packages/os-shell`, `packages/growth` (existing app), `packages/design`, `packages/ops`, `packages/connectors` (re-exports BriefNow). Per-package license headers.
**B. Multi-repo:** `marketr-os`, `marketr-growth`, `marketr-design`, `marketr-ops`, `briefnow-connectors`. Cleanest licensing boundaries; most overhead.
**C. Shell repo:** new `os-shell` repo composing growth + design + ops as modules. Least disruption to the running build.

*Working recommendation: A.* Rationale: speed to distribution is the moat, and the "team" is agents — monorepo coordination is cheap for us, expensive for humans.

## 6. Business model sketch

- Keep **AGPLv3 core + commercial white-label** (already decided).
- Seats/workspaces: Solo $29 / Studio $79 / Agency white-label $199+ (mirrors existing tiers).
- **Connector marketplace take-rate:** this is where the BriefNow "network is the acquirable asset" thesis pays — third-party connectors, rev share.
- Ops modules (payroll, advanced books) as paid add-ons.

## 7. What changes / what doesn't

- **Doesn't change:** 13B→13C→13D queue (they're Grow-pillar modules now); zero-custody-of-spend invariant (extends to commercial actions); vault rule; design lock; in-flight builds.
- **Changes:** SPEC.md positioning needs a v2; Product Hunt narrative widens; the name question below.

## 8. Decisions

**Locked (2026-09-28):**
- Build **all three pillars** (Launch + Operate + Grow). Tico leads.
- Target user: **solo founders and businesses looking to improve efficiency, growth, and revenue.**
- Connector doctrine: BriefNow builds, OS consumes (§4); vendors are attracted with distribution + a directory, per the Claude playbook (§10).
- Feed feature: confirmed — Bloomberg-terminal × Muse-feed combo as the OS home screen (§9).
- Timing: BriefNow build-out **deferred to a later build** (Tico 2026-09-28). Connector/NVIDIA research verdicts stand: **Nango Cloud managed (not self-hosted)** as the substrate; ELv2 legal read still needed before commit; FastMCP stays; NeMo Data Designer ranked #1. Feature specs: `docs/BUSINESS-OS-FEATURE-SPECS.md` (draft 2026-09-28, awaiting approval).

**Still open:**
1. **Name:** "OpenOS" proposed 2026-09-28 → **FAILED collision check.** Active "OpenOS/bNode" Linux distro shipping since June 2026 (openos-bnode.dev, docs, forum, Discord), plus hobby OpenOS firmware projects and an expired EU "OPEN/OS" mark. Collision screening 2026-09-28, 15 candidates, **0/15 survived**:
   - Batch 1 (all failed): VentureOS (multiple founder-OS products), LaunchOS (launch/agency/founder-OS products), OpenVenture (repo + active company + old trademark), Keel (business software, solo-practice OS, HR, trading, agent systems), Binnacle (existing business analytics platform — near-identical market), Sextant (dealer-network analytics firm acquired July 2026), Mainsail (Tideworks Terminal Operating System + MainsailOS), Freehold (freeholdsoftware.co "own your software" + crypto wallet), Ballast (infrastructure/business/compliance), Fairwind (Google's Sept 2026 "Fairwind" cyber program — 650+ orgs).
   - Batch 2 / coined (all failed): Opsiq (6+ AI projects named OpsIQ, incl. a field-service CRM and a business-diagnosis platform), Captyn (active scheduling SaaS), Logro (LogroNetwork healthcare network), Kova (KOVA OS — a live personal AI OS at kovaos.com, near-identical concept), Plinth (4 active projects, incl. a business billing engine).
   - **Lesson (the Fealty pattern):** Familiar/Steward/Holdfast/Vigil/Regent all failed the same way; the winner was the coined, ownable one. The descriptive/evocative name space is fully mined — even 5-letter coined names collide with AI-era projects. **The umbrella name must be coined: short, pronounceable, no dictionary meaning to collide with.** Next step: generate a coined shortlist (or Tico proposes candidates) → collision-check each before presenting as viable. Search screening is not legal clearance.
2. **v1 lead pillar:** Grow vs Launch? (All pillars get built; the question is order.)
3. **Repo:** monorepo A (recommended) vs multi-repo B vs shell-repo C.
4. **Dataset builder (new requirement, Tico 2026-09-28):** companies transfer their business/company into the AI and agentic world — an ingestion pipeline turning business knowledge (docs, FAQs, catalogs, processes, policies) into clean AI-ready datasets. Fills BriefNow's missing "real business-data adapters" gap; NeMo Data Designer is the candidate engine; natural home is the Launch pillar as the on-ramp (business in → AI-ready knowledge out → connector live).
5. **New features (Tico 2026-09-28):** **CAD + hardware** (physical-product design/prototyping — connects to the drone platform build); **Funding/VC with Boardy AI as a preloaded starter contact** (not the front door — Tico 2026-09-28 correction: Boardy is the first card in the tenant's contact graph, helping them get more contacts via warm intros; the feature's front door is the founder's own raise workflow); **Legal/compliance** (per-industry, per-business-model compliance — synergy with Hullcheck's "don't get sued" engine). **Build plan APPROVED 2026-09-28:** Dataset Builder → Legal → Funding/VC → CAD+Hardware.
6. **Branded Report Engine (feature #5, spec'd 2026-09-29):** cross-cutting — one engine, every pillar emits polished branded reports (Grow client reports, Operate compliance status, Launch dataset health, Funding investor updates). Brand kit in, grounded OS data in, AI-written narrative, never invented numbers, draft-for-approval before send. Template #1: open (Tico rejected the Pre Launch Panel official-report standard, 2026-09-29). Slice 1 rides with the Dataset Builder build; first full vertical is Grow client performance reports. Build-blocks research: `workspace/research/biz-os/feature-build-blocks.md` (all four features, licenses verified, 2026-09-29).

## 9. The Feed — Bloomberg terminal × Muse feed (confirmed feature)

**What:** the OS home screen. Dense, real-time, agent-written. The coffee screen — the daily habit loop that drives retention.

**Bloomberg half (data density):**
- Live tickers of *your* business vitals: revenue today, bank cash, site visitors, ad spend, orders, inventory levels.
- Watchlists: competitors, keywords, SAM.gov contracts, suppliers — with movers and alerts.
- Threshold alerts: ad-spend spike, negative review, competitor price drop, matching contract posted.
- Keyboard-first; optional terminal aesthetic theme (amber-on-black mode for the romantics).

**Muse-feed half (editorial intelligence):**
- Morning Brief, agent-written: what changed overnight, what needs you, in what order.
- Suggested tasks and Ideas & Plays ("competitor X raised prices — here are 3 responses").
- Goal progress, proactive nudges from the 13B learning layer.

**Plumbing:** Business Graph (P8) + Growth Memory + Plaid money data + DataForSEO + SAM.gov + Postiz + news APIs.

**Rules:** every item grounded — links to its source or the internal datum, no hallucinated headlines. Alerts user-configurable. Anything commercial stays draft-for-approval.

**Open:** is the Feed the default landing view? (Recommended: yes.) Which Bloomberg elements carry v1 — aesthetic, density, alerts, watchlists?

## 10. Connector playbook (how Claude does it — verified 2026-09-28)

1. **Own the standard.** Anthropic created MCP (open protocol); vendors build *to* it.
2. **Vendors build and host their own** remote MCP servers — Shopify, Stripe, Plaid, PayPal, Square, QuickBooks all ship official ones now. Distribution (millions of Claude users) is the incentive.
3. **Directory with review:** claude.ai/directory — devs submit via a portal (opened Sept 25, 2026), Anthropic safety-scans and reviews each submission, ranking is usage-based like an app store. 2,562 integrations tracked Sept 2026.
4. **First-party seeds:** Anthropic builds a few themselves (Google Workspace, GitHub, Slack) to set the quality bar.
5. **Community fills the long tail** (e.g. the TikTok Shop community server); vertical bundles attract industries (legal: 20+ connectors + 12 plugins from Box, Thomson Reuters…).

**Our copy:** BriefNow = the "build the connector" side (generator already exists) + OpenOS directory = the distribution side. Don't chase vendors 1:1 — make BriefNow the fastest API→MCP path, publish to a reviewed directory with one-click install and rev share on paid connectors. Seed the catalog with §4's list. Vendors come when the users are there: "publish once, reach every OpenOS workspace — plus Claude, ChatGPT, Meta AI" (BriefNow's multi-publish thesis).
