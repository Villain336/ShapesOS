# Marketr — SPEC-PHASE9: GrowthOS Orchestrator

**Status:** DRAFT for Tico's approval — do not build until approved.
**Research basis:** `docs/history/phase9-research-report.md` (spec-first research, 2026-09-26).
**Tico's decisions (2026-09-26):**
1. Command bar = **sidekick**, not front door.
2. Growth Missions = **templates for the most common goals per business type**.
3. Agent Playbooks = **agent learning (Growth Memory) + community**.
4. Approvals = **user-customizable automation** (per-action toggles, escalation rules).

---

## 1. What Phase 9 is

Phase 8 built the substrate: the Business Graph (what is true), the Campaign object (what we're doing), Growth Memory (what we learned). Phase 9 puts a **Chief Strategy Agent** on top of it — one orchestrator that turns business goals into executed work, with a small set of specialized executors and the user holding every meaningful approval.

The mental model: **the user sets the destination (Mission), the Chief Strategy Agent plans the route (Playbook), executors drive the legs, the user holds the brakes.**

### What Phase 9 is NOT
- Not 17 agents. Not a swarm. One orchestrator, a small executor set (5).
- Not autopilot spending money. Zero-custody and autopilot-never-buys are structural invariants carried from Phase 5/7 — Phase 9 cannot weaken them.
- Not a chatbot bolted on. The command bar is a sidekick: fast actions, quick asks, mission control — the pages remain the product.

---

## 2. Components

### P9A — Chief Strategy Agent (the orchestrator)

A single supervisor agent per workspace. It does not do the work; it routes, sequences, and verifies.

**Architecture (from research):**
- Explicit routing state: every delegation records `next_agent` + `routing_reason` (no "collaborate when useful" vagueness).
- Workers receive **clean context packets** — only their task slice, never full history (controls cost and context rot). Summaries return upstream.
- Deterministic termination: step limit, timeout, per-mission cost budget, loop detection, consecutive-failure count. Never "the LLM says it's done."
- Circuit breaker: ~20 hop recursion cap, then pause and escalate to the user.
- Routing tables over LLM judgment for known task types; LLM judgment only for novel ones.

**The 5 executors** (fixed set, each with a narrow tool allow-list):
1. **Researcher** — reads the Business Graph, runs audits, gathers facts. Read-only.
2. **Planner** — turns a Mission into a sequenced plan with checkpoints. Proposes; executes nothing.
3. **Drafter** — writes outbound artifacts (outreach copy, campaign briefs, content drafts). Draft mode only; nothing sends without approval.
4. **Analyst** — reads results, attributes outcomes, writes to Growth Memory (episodic + semantic). Feeds the learning loop.
5. **Scheduler** — manages mission timelines, reminders, checkpoint scheduling. No external side effects.

Anything that touches money, publishing, or external sends goes through the **approval executor** — a non-LLM service that only acts on human-signed authority (Phase 5 pattern, extended).

### P9B — Command bar (sidekick)

⌘K everywhere. Not the front door — a fast layer over the existing product.

**Contract (from research):**
- 0ms open/close. No animation on keyboard-initiated actions. Strip default dialog fades.
- Budgets: open→focused ≤80ms, local results ≤50ms, LLM suggestions ≤800ms (hidden if late).
- Full keyboard contract: ⌘K toggles, type immediately, ↑/↓ wrap, Enter runs, Esc closes, Backspace pops nested pages, focus returns on close.
- Frecency ranking (frequent + recent first), typo-tolerant fuzzy match, grouped sections, hotkeys shown.
- `prefers-reduced-motion` → fully instant.

**What it does:**
- **Go:** jump to any page, campaign, entity, report.
- **Do:** start a Mission from template, run a Playbook step, trigger a Phase 1–7 action (draft outreach, refresh audit, queue content).
- **Ask:** free-form question to the Chief Strategy Agent, answered with citations to the Business Graph / Memory.

**Audit:** every invocation logged — templated actions log `{template_id, rendered_prompt_hash}`, free-form asks log the full prompt. The audit log is the source of truth for what the user did via the bar.

### P9C — Growth Missions

Durable, goal-shaped work. "Get 40 booked jobs this quarter" — not "run these 12 tasks."

**Mission templates by business type** (Tico's decision). Ship with templates for the most common goals per type:
- Home services (plumbing/HVAC): booked-job growth, review velocity, slow-season fill.
- Local services: quote-request volume, Google Business visibility.
- SaaS: trial starts, trial→paid conversion, churn reduction.
- Ecommerce: repeat purchase rate, cart recovery.
- Professional services (consulting/legal/finance): consultation bookings, proposal win rate.

Each template = goal definition + default plan skeleton + relevant playbooks + success metrics + typical checkpoints. User picks a template, adjusts the goal, launches.

**Execution (from research):**
- Durable state: persist before every human wait; rehydrate on resume. A mission can pause for days and resume with full context.
- Hybrid checkpoints: after each step, before irreversible ops, at cost-budget fractions, after approvals, on error, plus a time-based safety net.
- Structured event timeline per mission (step, tool, args, observation) — visible to the user, feeds Growth Memory.
- Explicit termination conditions, checkable in code.
- Staleness handling on resume: re-verify budgets, data freshness, and assumptions before continuing (research gap — Marketr defines this).

### P9D — Agent Playbooks

Versioned procedures the Chief Strategy Agent and executors follow. Two sources (Tico's decision):

1. **Agent learning:** when the Analyst attributes a real outcome to a procedure (via Growth Memory), the system proposes promoting it to a playbook version. Human reviews before it becomes canonical.
2. **Community:** opt-in sharing. Playbooks are anonymized on export (no tenant data, no business names — the Phase 8 anonymization pattern). Import is explicit; imported playbooks run in draft/eval mode first.

**Versioning (from research):**
- Immutable versions; mutable label pointers (`production`, `staging`, `latest`).
- Rollback = pointer flip, never rewrite.
- Every run records the resolved version.
- Lifecycle: DRAFT → EVAL → REVIEW → CANARY → PRODUCTION → DEPRECATED.
- Git holds reviewable source; registry holds immutable builds.
- **Differentiator (white space):** versions are evaluated against real tenant outcomes from Growth Memory — did the playbook cause the lift? — not LLM-judge text scores. Attribution is honest about uncertainty.

### P9E — Amount-aware authorization tiers (DoA)

The one genuinely new money-safety pattern from research. Evaluated **per action, at execution time**, in code — not prompt text:

- **Tier 0 — Observe:** reads, drafts, analysis. Always allowed within the mission.
- **Tier 1 — Small actions:** user-defined threshold (e.g. <$100 or publish-to-owned-channels). Auto-allowed *only if* the user enabled that automation toggle.
- **Tier 2 — Significant:** above the small-action threshold, or anything touching external audiences / spend. Requires explicit human approval, every time.
- **Tier 3 — Never:** hard deny list (move money, sign contracts, delete data). The agent cannot do these under any toggle.

**User-customizable automation** (Tico's decision): per-action "ask for confirmation" toggles (Lindy pattern), condition-based escalation ("ask me if…"), draft modes for outbound artifacts. Defaults: everything Tier 2+ asks. Approval UX must work on mobile — a clumsy approval flow costs more time than the agent saves.

---

## 3. Safety invariants (structural, non-negotiable)

Carried from Phases 5–7, extended — these are enforced in code, not in prompts:

1. **Zero custody.** Marketr cannot hold or move client money. Phase 9 changes nothing here.
2. **Autopilot never buys.** No mission, playbook, or toggle can authorize media spend. Ever.
3. **Propose/execute separation.** The LLM drafts write-capable *requests*; only the non-LLM approval executor performs them, and only with human-signed authority.
4. **Amount-aware tiers** evaluated per action/currency at execution time (§P9E).
5. **Kill switches** remain: per-mission pause, per-workspace freeze, global halt.
6. **Audit everything:** mission timeline, command-bar invocations, playbook versions used, approvals granted/denied — append-only.
7. **Cross-tenant boundary:** community playbooks are anonymized on export; learned playbooks never carry tenant-identifying signal. (Research open question — Marketr implements the Phase 8 anonymization pattern and documents the residual risk honestly.)

---

## 4. UI (locked house style)

All new UI follows the locked references (StudioApp.tsx code, CRM tweet, better-ui + emil-design-eng):
- **Command bar:** cmdk-style palette, violet accents, instant open, dense result rows with icons + hotkeys, grouped sections, light mode.
- **Missions page:** dense table of missions (name, goal, progress, status, next checkpoint) + mission detail with event timeline and approval queue.
- **Playbooks page:** dense table (name, version, source badge [learned/community], status, outcome lift) + version history with pointer labels.
- **Automation settings:** per-action toggle table (action, tier, your setting) — dense, scannable.
- Lucide only, no emoji, no new color system.

---

## 5. Data model (new tables)

- `mission` — id, workspace, template, goal (structured), status, plan snapshot, checkpoints, budget caps, termination conditions, created_by.
- `mission_event` — append-only timeline (step, actor, tool, args, observation, cost).
- `mission_approval` — approval requests: action, tier, payload hash, status (pending/approved/denied/expired), decided_by, decided_at. (Extends the Phase 5 approval object pattern.)
- `playbook` — id, name, source (learned/community), current versions.
- `playbook_version` — immutable: version number, content hash, source ref, eval results, outcome attribution, status (draft→deprecated), label pointers.
- `automation_setting` — workspace × action → tier behavior (auto/ask/never), thresholds.
- `command_audit` — every bar invocation (template_id + prompt hash, or full prompt).

All workspace-scoped, RLS-isolated, matching Phase 8 conventions. No changes to existing tables.

---

## 6. Build order (proposed)

1. **M1 — Data + safety core:** tables, DoA tier evaluator, approval executor extension, audit logging. (Safety first — nothing acts until this exists.)
2. **M2 — Chief Strategy Agent + 5 executors:** orchestrator loop, routing state, context packets, termination, circuit breaker. Propose-only at this stage.
3. **M3 — Command bar:** sidekick palette, Go/Do/Ask, keyboard contract, audit.
4. **M4 — Missions:** templates per business type, durable execution, checkpoints, timeline UI, resume/staleness.
5. **M5 — Playbooks:** versioning, learned-playbook promotion flow, community import/export (anonymized), outcome evals.
6. **M6 — Automation settings:** per-action toggles, escalation rules, mobile approval UX.
7. **M7 — Verification battery:** orchestration tests, tier-enforcement tests (adversarial: attempt Tier 3 via prompt injection), approval-flow tests, eval-per-playbook-version, secret scan, tsc, build.

---

## 7. Open questions for build (not blocking)

- Executor count: 5 proposed — merge Drafter into Planner? Split Analyst? (Research gives no number.)
- Per-mission cost-budget methodology for marketing workloads (no standard exists).
- Playbook "golden dataset": outcome attribution methodology — honest uncertainty bars v1.
- Mission resume staleness: exact re-verification checklist per mission type.

---

## 8. Decisions — LOCKED by Z7 (Tico delegated, 2026-09-26)

- **Mission template business types:** Home Services, Local Services, SaaS, Ecommerce, Professional Services — the five client types agencies serve most; covers the self-serve founder wedge too.
- **Executors:** the 5 as specified (Researcher, Planner, Drafter, Analyst, Scheduler). Clean mapping to the mission workflow; no merge.
- **DoA default small-action threshold:** $100, user-adjustable per workspace.
- **Community playbooks:** OFF by default — explicit opt-in per workspace. Anonymized on export regardless.
- **Build order:** M1→M7 as proposed. Safety core before anything acts.
