# Phase 16 — Agent Experience: "Watch the agent work"

**Status:** SPEC DRAFT — queued after Phase 15 (…→ 14 → 15 → 16).
**Decided by Tico:** 2026-09-28 — "integrate CopilotKit as deeply as possible" + "agent runs must be viewable — Playwright is the answer" (no viewable VMs exist today).
**Goal:** Two halves of one promise — the agent stops being a chat box and becomes a visible worker. (a) CopilotKit gives Marketr's agent surfaces generative UI, shared state, and in-flow human-in-the-loop. (b) Playwright makes every browser run viewable: recorded video + step-by-step DOM-snapshot replay, with an optional live "watch" mode.

---

## 1. CopilotKit integration (deep, not a wrapper)

- **What it is:** MIT-licensed SDK + the AG-UI protocol (Google/LangChain/AWS/Microsoft adopted) — generative UI, bidirectional shared state (CoAgents pattern), first-class human-in-the-loop interrupts. React-first; Marketr is Next.js/React.
- **Where it lands:** the agent backend (Chief Strategy Agent, missions, playbooks, 13B learning loop) streams over the AG-UI protocol; the frontend consumes via CopilotKit's hooks. Backend-agnostic — our existing agent code gains an AG-UI adapter, not a rewrite.
- **Generative UI:** agent output renders as live components, not chat text — approval cards, campaign plans, content calendars, lead tables, report previews. Frontend tools registered via `useComponent`; the agent emits components with structured props.
- **Shared state:** agent state ↔ UI state stay in sync — the agent edits content-calendar rows in state and the UI re-renders; the user edits a row and the agent sees it. This makes the Phase 14 Univer calendar reactive.
- **HITL wired into the Phase 14 gate:** approval interrupts render *in the agent's flow* as live approval components (plain-language summary, tier badge, approve/deny/edit), not as a separate page to visit. The gate's approve/deny/edit semantics stay authoritative — CopilotKit is the renderer, the gate is the law.

## 2. Scope of integration (as deep as possible = default)

1. CopilotSidebar/Chat as the primary agent surface shell (themed via brand vars, never CopilotKit default chrome).
2. Generative UI components for: approval cards, plan/calendar previews, report-as-sheet previews, lead/contact tables, mission progress.
3. CoAgents shared state for: content calendar, active mission, approval queue state.
4. AG-UI adapter on the agent backend; streaming events typed and logged.
5. Custom HITL interrupt types mapped 1:1 to gate actions (propose → approve/deny/edit/execute).

## 3. Viewable agent runs — Playwright (b)

- **No viewable VMs exist today.** Playwright (Apache-2.0, Microsoft, ~70k★) is the answer for both replay and live view.
- **Every agent browser run records:** video (webm) + Playwright trace (DOM snapshots per step, network, console). The trace viewer is the "friction timeline" — step back through exactly what the agent saw and did. Same substrate the customer-simulator ("Dress Rehearsal") spec needs.
- **Optional live "watch" mode:** run the browser headed and stream the view from the dashboard. Transport per decision (b).
- **Where the viewer lives:** a run-detail view — timeline of steps (each step = DOM snapshot + action + screenshot), video player, trace download. Linked from missions, agent activity, and the approval queue (watch the run that proposed this action).
- **Storage & retention:** recordings live in host-owned storage (`AgentRunRecording`: workspaceId, runId, videoPath, tracePath, createdAt, sizeBytes). Default retention per decision (c); oversized runs summarized (keep trace, drop video) rather than deleted silently.

## 4. Data model

- `AgentRun` — workspaceId, kind (mission | playbook | browser | follow-up), status, startedBy, agentState (CoAgents snapshot), createdAt/endedAt.
- `AgentRunRecording` — runId, videoPath, tracePath, stepCount, sizeBytes, retentionUntil.
- `AgentRunEvent` — runId, seq, type (agui | gate | browser | note), payload summary. Feeds the timeline.
- `GenerativeComponent` registry (code, not DB): approved component set the agent may emit — allowlist only, never arbitrary JSX from the model.
- RLS battery extended to the new tables.

## 5. UI surfaces

- **Agent surfaces** (dashboard agent panels, missions, playbooks): CopilotKit shell + generative components + shared-state widgets.
- **Run viewer:** `/dashboard/runs/[runId]` — step timeline, DOM-snapshot replay, video, trace download, linked approvals.
- **Live watch:** from any running agent run — "Watch" opens the stream (transport per decision b).
- House pattern: brand vars, Lucide, dense tables. Diff new pages against `app/dashboard/studio/StudioApp.tsx` class-by-class (repo house law).

## 6. Build order

1. AG-UI adapter on the agent backend + typed streaming events.
2. CopilotKit shell in the agent surfaces (themed, brand vars).
3. Generative component registry (allowlist) — approval card first, wired to the Phase 14 gate.
4. CoAgents shared state for calendar + mission + approvals.
5. Playwright run recorder: video + trace on every agent browser run; `AgentRun`/`AgentRunRecording`/`AgentRunEvent` persistence.
6. Run viewer page (timeline + replay + video).
7. Live watch mode (transport per decision b).
8. Retention policy + storage accounting.
9. Evals: generative-component allowlist enforcement (model cannot emit unregistered components), HITL interrupt → gate decision round-trip tests, trace fidelity tests.

## 7. Verification (definition of done)

- tsc clean (heap flag), production build green, tests green (new suites: AG-UI adapter events, component allowlist negatives, HITL→gate round-trip, trace capture fidelity, retention sweep).
- Acceptance: an agent run renders an approval as a live component in-flow; approving it there executes through the gate with an audit entry; a browser run produces a replayable timeline + video; live watch shows the run in progress.
- Secret scan clean. Screenshots: generative approval card, run viewer, live watch. Local-only commit.

## 8. Cost & license reality check

- **CopilotKit:** MIT — safe to adopt and ship; premium observability/Inspector is paywalled but we don't need it (we have our own audit). Multi-user/RBAC is "you build it" — we already have workspace scoping.
- **Playwright:** Apache-2.0 — safe. Recording cost is storage, not licenses; browser runs are CPU-heavy on the 8GB box — cap concurrent headed runs and queue the rest.
- **No VM infrastructure needed:** the decision explicitly rejects building viewable VMs — Playwright recording + streaming covers it.

---

## DECISIONS — LOCKED by Tico 2026-09-28

- **(a) Approvals only.** Generative UI lands on the approval queue first; missions and everything else stay chat until v2.
- **(b) Real-time stream.** True watch-it-work headed-browser stream to the dashboard.
- **(c) 30 days, then summarize** (default — Tico didn't pick: traces kept, videos dropped after 30 days unless pinned).

---

## OPEN DECISIONS (resolved 2026-09-28; unpicked items use the safe defaults above)

**(a) Which agent surfaces get generative UI first?**
*Option 1 — Approvals + missions first (recommended):* the highest-trust surfaces get live components; everything else stays chat until v2.
*Option 2 — All agent surfaces at once:* CopilotKit shell everywhere from day one. Bigger bang, bigger eval surface.

**(b) Live-view transport.**
*Option 1 — Stream:* real-time headed-browser stream to the dashboard. True "watch it work," heavier on the box.
*Option 2 — Polling screenshots:* the dashboard polls fresh screenshots every few seconds. Lighter, slightly delayed — usually enough.

**(c) Recording retention default.**
*Option 1 — 30 days, then summarize:* traces kept, videos dropped after 30 days unless pinned.
*Option 2 — 90 days full:* keep everything 90 days. More storage, simpler story.
