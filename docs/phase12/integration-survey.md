# Marketr Phase 12 — Open-Source Integration Survey

**Date:** 2026-09-27 · **Status:** research only, no code · **Nothing pushed or published**

Tico asked to evaluate 26 open-source repos for forking/modifying/integrating into Marketr
(AGPLv3 + commercial dual-license, Next.js SaaS, agency white-label), plus catalog the
"Agency-Agents" GitHub repo's agents. Four research workers verified licenses from each
repo's LICENSE file / official docs (never from memory). Anything unverifiable is marked
UNVERIFIED. Raw per-batch findings: `docs/phase12/scratch/batch-{analytics,content,marketingops,infra-agents}.md`.

---

## 1. License landscape — the traps, at a glance

| Repo | License (verified 2026) | Flag |
|---|---|---|
| Penpot | MPL-2.0 | none — AGPL-compatible via §3.3 |
| Twenty | AGPLv3 + §7 Application Exception; `/* @license Enterprise */` files commercial; SDKs MIT | EE features runtime-gated by key |
| PostHog | MIT core + proprietary `ee/` (Enterprise License) | official Docker image bundles `ee/` — white-label must build from `posthog-foss` |
| rrweb | MIT (unchanged since 2018) | none |
| Listmonk | AGPL-3.0, single clean grant | none |
| Mautic | GPL-3.0-or-later | keep across API boundary |
| Activepieces | MIT community; `packages/ee/` commercial | don't assume `ee/` is MIT |
| Postiz | AGPL-3.0 + commercial from Gitroom | never link AGPL `@postiz/node` SDK — use raw fetch |
| Dub | Open-core: 99% AGPLv3 / 1% commercial `/ee` | **affiliate/Partners features behind paid cloud ($90/mo + 5% payouts); self-hostability of Partners code UNVERIFIED** |
| Chatwoot | MIT core; `enterprise/` separately licensed | `-ce` Docker tag omits EE |
| Formbricks | AGPLv3 core + proprietary EE | **explicit no-white-label / no-editor-extraction policy** — hard blocker |
| Umami | MIT, no EE partition | none |
| GrowthBook | Open core: MIT bulk; `enterprise/` dirs commercial | SSO/encryption/scheduling are proprietary |
| Unleash | **AGPLv3 since v8.0.0 (2026)** — was Apache 2.0 | network-copyleft taxes exactly the fork-and-reskin white-label pattern |
| Jitsu | MIT | none |
| Apache Superset | Apache-2.0 | none |
| Ghost | MIT | none |
| Payload | MIT, no carve-outs | none — cleanest license in the survey |
| Strapi | Open-core: MIT Community Edition + proprietary EE (since July 2020) | RBAC/audit/SSO are EE-gated — standing legal tax on white-label |
| GrapesJS | BSD-3-Clause | none |
| Remotion | **Custom source-available license (NOT OSI)** — free ≤3 employees; Company License above; 5.0 tightens (contractors count) | **incompatible as a bundled dependency; no-resale-derivatives clause** |
| OpenNotebook | MIT | none |
| Clip Forge (sjbuilds04/clip-forge) | MIT | **prototype: 2 commits, 5 stars, created 2026-07-23** — not a project |
| Coolify | Apache-2.0 | none |
| Documenso | AGPL-3.0 core; `packages/ee/` paid (white-label embed = Enterprise feature) | white-label signing UI requires commercial license |
| Plane | AGPL-3.0, single clean grant | none |

No SSPL / Elastic License / BSL traps found in any of the 26.

---

## 2. Strategic lens verdicts

### 2a. PostHog bundles analytics + replay + flags + experiments — does it make GrowthBook/Unleash + rrweb redundant?
**Agree, with an ops-cost asterisk.** Verified: PostHog's MIT core covers product analytics, web analytics,
session replay (rrweb-lineage, now inlined in `posthog-js`), feature flags, experiments, error tracking,
surveys, CDP. Capability-redundant: yes. Ops-redundant: **no** — the self-hosted stack is ~25 services
needing 8–16GB RAM with ~100k events/mo before upstream steers you to Cloud, and white-label deploys must
build from the `posthog-foss` tree (official image bundles proprietary `ee/`). If Marketr wants
flags/experiments/replay without a 25-service fleet, GrowthBook's one-container + MongoDB or a surgical
rrweb npm embed remain the lighter answers.

### 2b. PostHog vs Umami — pick ONE
**Pick Umami.** For an agency-white-labeled marketing editor, white-label economics and stack fit beat
feature breadth: MIT with no enterprise partition (no `ee/` trap), Next.js + Postgres (same stack family —
fork-and-reskin is genuinely feasible), ~100MB idle vs PostHog's 8–16GB fleet, cookieless (no
consent-banner friction for agency clients), multi-site from one dashboard. PostHog's extras (replay,
flags, experiments, CDP) aren't load-bearing today; each can be added later at a fraction of the cost
(rrweb embed, GrowthBook). **Revisit trigger for PostHog:** the day experiments/flags/CDP become native
product features, not before.

### 2c. Fork Penpot? (we just built a native Konva Canvas)
**Don't — redundant AND insane.** Clojure/ClojureScript + Rust/WASM codebase, 4-service runtime, and it's
the wrong *kind* of editor (product-UI design tool, not a marketing-asset generator). Marketr's Konva
canvas is further along than any fork would be on day 90, in the team's language. Only touchpoint worth a
look, deferred: Penpot's MCP server / RPC API as a bridge to import client design tokens into the brand
kit.

### 2d. Twenty — redundant given our CRM modules + Tico's React CRM artifact?
**Redundant. Don't fork.** Twenty is Salesforce-class (metadata-driven objects, workflows, MCP, email sync)
as a 4-service heavyweight with enterprise features behind a commercial runtime key. Marketr's
contact/company/deal need is covered. Steal the *pattern*, not the code: AGPLv3 core + Section 7
application exception + MIT SDKs is a proven template for Marketr's own ecosystem licensing.

### 2e. GrapesJS vs our Canvas editor
**Complementary, keep both.** Konva canvas = pixel-precise design surface → PNG/SVG assets. GrapesJS =
document builder → responsive landing pages / MJML email newsletters → HTML. Zero shared code paths,
adjacent steps in one workflow (design hero in Canvas → drop into a GrapesJS page). Cheapest integration
in the survey: `npm i grapesjs`, BSD-3, zero runtime.

### 2f. Listmonk vs Mautic
**Listmonk, decisively.** Single Go binary + Postgres + clean REST API, AGPL-3.0 (same family as Marketr),
near-zero ops. Mautic is PHP/Symfony + MySQL + cron-driven — full automation depth at the price of a
second runtime and second DB technology next to a Node stack. Mautic's extras (lead scoring, drips) are
better rebuilt as thin Marketr-native logic on Listmonk's send engine.

### 2g. Coolify — "offering hosting": FOR or AGAINST?
**AGAINST as a product; FOR as the deployment plane.** Hosting commits the business to 24/7 support
burden, abuse/spam liability (SEO spam, phishing — IP reputation + takedown work), thin unit economics
competing with Vercel/Netlify/Hetzner, SOC 2 / data-residency compliance gaps, and scope creep (email,
DNS, CDN, WAF — a second business). The right shape: Coolify provisions isolated white-label Marketr
instances per agency client on infrastructure the *agency* controls — "own your stack" selling point,
near-zero marginal commitment. Apache-2.0 makes it legally clean.

### 2h. Documenso × agency white-label
**Phase-2, API-only.** Community Edition core (send/sign/templates/API) is free under AGPL and API-only
use without code modification is explicitly sanctioned by Documenso's own policy. But the white-labeled
embed experience is the paid Enterprise feature — the "invisible signing inside your client's branded
portal" dream costs a commercial quote. Defer until an agency client asks; integrate against an
unmodified CE instance.

---

## 3. Ranked tiers

### TIER 1 — deep-integrate (5)
1. **Activepieces** (MIT) — the automation backbone. 280+ integration pieces as TypeScript npm packages
   AND as MCP tools, directly consumable by the Chief Strategy Agent / missions / playbooks. The one repo
   genuinely worth forking *from*. Cost: medium (learn the pieces SDK; pieces themselves are portable).
2. **Listmonk** (AGPL-3.0) — the email engine. Single Go binary + Postgres, REST API for campaigns and
   transactional mail. Sidecar, never fork. Fit 5/5.
3. **Postiz** (AGPL-3.0) — the social-publishing layer. ~30 channels behind one OAuth surface, built-in
   MCP server (agentic-native, matches Marketr's direction), proven AGPL-compliant agency-SaaS precedent
   (Postra). Sidecar via Public API/MCP; raw fetch only — never link the AGPL `@postiz/node` SDK.
4. **GrapesJS** (BSD-3) — landing-page + email-newsletter builder. npm library, zero runtime, wire Marketr
   brand kits into its block library. Complementary to Canvas, not overlap.
5. **Payload** (MIT) — the CMS layer. Runs *inside* Marketr's Next.js app (`@payloadcms/next`, Local
   API), reuses PG 5433, zero new infra. Content-model templates, brand-kit registry, playbook/mission
   content as typed collections. Cleanest license in the survey.

### TIER 2 — embed-as-module
- **Umami** (MIT) — analytics sidecar: deploy per agency or one multi-site instance, consume its API,
  render Marketr's own dashboards. The one analytics pick.
- **rrweb** (MIT) — surgical session-replay npm embed for "see what the visitor did before bouncing"
  on client campaign pages. Lazy-load; mask PII.
- **Coolify** (Apache-2.0) — the white-label deployment plane (infra, not product).
- **Documenso** (AGPL-3.0 CE) — API-only against an unmodified instance, phase 2.
- **Chatwoot** (MIT) — live-chat widget embed for agency client support; backend stays its own service.
- **Ghost** (MIT) — Admin API publishing to client blogs; WordPress-first stays the stated direction.
- **GrowthBook** (MIT core) — when A/B testing becomes a product feature, not before.

### TIER 3 — optional one-click add-on
- **Dub** — API-only for link shortening; affiliate layer needs Dub cloud (paid, 5% payout toll) or a
  separate build — do not plan self-hosted affiliate on it until the `/ee` boundary is verified.
- **Apache Superset** — client-facing BI when agency reporting becomes a revenue line; guest-token embeds.
- **Jitsu** (MIT) — CDP/event pipeline when there are destinations to feed; full self-host wants K8s.
- **Penpot** (MPL-2.0) — MCP/API bridge for design-token import only; deferred.

### SKIP with reason
- **Twenty** — redundant (CRM need covered); wrong weight class.
- **Mautic** — wrong ops shape (PHP+cron); Listmonk covers the need.
- **Unleash** — 2026 AGPL move taxes the fork-and-reskin white-label pattern; GrowthBook dominates it.
- **PostHog** — 25-service answer to a one-service question; revisit when flags/experiments/CDP are
  natively needed (see §2a).
- **Strapi** — proprietary EE carve-out on exactly the features agencies need (RBAC, audit, SSO);
  Payload wins on every axis that matters.
- **Remotion** — source-available, not OSI; Company License required above 3 employees; incompatible as
  a bundled dependency. Optional BYO plugin for power users at most.
- **OpenNotebook** — duplicates the existing corpus/RAG/Knowledge Brain; inspiration only.
- **Clip Forge** — 2-commit prototype; rebuild the clip pipeline (segment → whisper → LLM score →
  ffmpeg → caption-burn) natively if the lane matters.
- **Plane** — issue tracker, not a campaign object; commodity internal tooling, not a product feature.
- **Formbricks** — explicit no-white-label / no-editor-extraction policy; commercially adversarial to
  the agency model despite the AGPL core.

---

## 4. Agency-Agents repo

**Identity:** https://github.com/msitarzewski/agency-agents ("The Agency") — MIT licensed (single root
LICENSE, no per-agent variations found), ~155k stars. **285 agents across 18 divisions**, each a Markdown
persona file (name, description, color, emoji, vibe + identity/mission/rules/deliverables/workflow/success
metrics) plus install scripts. Native desktop app at agencyagents.app for one-click install into Claude
Code / Cursor / Copilot.

**Caveat:** these are persona *prompt* files, not executable agents. Their value is system-prompt structure
— identity, mission, rules, deliverables, workflow, success metrics — which maps cleanly onto Marketr's
EXPERT-CONSTITUTION.md prompt-layer pattern. Treat as seeds to adapt, not drop-in prompts. Quality varies
(community-contributed). Full 285-agent catalog (name + one-line purpose, grouped by division) lives in
`docs/phase12/scratch/batch-infra-agents.md`.

**Top 5 mapped to Marketr's architecture:**

| # | Agent (division) | Maps to | Why (one line) |
|---|---|---|---|
| 1 | 🕸️ Multi-Agent Systems Architect (Engineering) | **Playbooks** | Multi-agent pipeline topology, context flow, trust, failure recovery — the Playbook engine's runtime mechanics |
| 2 | 🗺️ Workflow Architect (Specialized) | **Playbooks** | Workflow discovery/mapping/specification — the authoring-time half of Playbooks |
| 3 | 🎯 Studio Producer (Project Management) | **Missions** | High-level orchestration, portfolio management, strategic alignment — the Mission runner's job description |
| 4 | 🎯 Business Strategist (Specialized) | **Chief Strategy Agent** | Management-consulting-grade competitive analysis, market entry, growth planning — the Chief's strategic reasoning template |
| 5 | 🎭 Agents Orchestrator (Specialized) | **Chief Strategy Agent** | Coordination/workflow-management pattern — the dispatch layer: fan out, supervise, aggregate specialist sub-agents |

**Secondary mining:** 🎭 Brand Guardian (Design) — on-brand enforcement, matches "the editor that keeps
clients on-brand" · 🔮 AI Citation Strategist + 🏗️ AEO Foundations Architect (Marketing) — AEO/GEO
patterns for AI-search visibility tracking · 🚀 Growth Hacker (Marketing) — experiment-loop seed for
Missions · 🧭 Chief of Staff (Specialized) — decision-routing pattern for the Chief's executive layer.

---

## 5. Uncertainties & exclusions (explicit)

- **UNVERIFIED:** whether Dub's Partners/affiliate code is present in the AGPL repo vs `/ee`-only/cloud-only — do not plan a self-hosted affiliate layer on Dub without resolving this.
- **UNVERIFIED:** Dub's self-host DB/queue backend; Remotion's current per-seat pricing; the runner-up Clip Forge candidate's license (`nitishrh07/clipping-tool`); Jitsu 2.0 console implementation language.
- PostHog `ee/` production-use terms were read via a third-party helm chart's summary, not the `ee/LICENSE` file itself — treat as directionally correct, not verbatim.
- Per-agent license text in Agency-Agents was not individually audited (based on repo structure: single root MIT).
- All 26 repo states are as of 2026-09-27; licenses can change (Unleash proved this happens). Re-verify at integration time.
- Research only — no code written, no forks created, nothing pushed or published.
