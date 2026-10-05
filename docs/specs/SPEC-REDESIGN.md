# Marketr — Redesign Spec: Light Theme + Orange, Automation Canvas, Chat

**Status:** APPROVED by Tico on 2026-09-22 — build in progress
**Date:** 2026-09-22
**Decisions from Tico:** light mode + orange (full replacement, no dark toggle);
automation canvas = node-graph builder for automations (not a board);
chat = BOTH AI assistant chat and team chat.

Component constraint (standing): RareUI, BeautifulUI, shadcn-registry components
per `~/workspace/design-vault/library/COMPONENT-MANIFEST.json`, Lucide icons only,
no emoji UI. UI polish per `better-ui` and `emil-design-eng` skills.

---

## 1. Light theme + orange

### Approach
The current UI hardcodes dark surfaces (~40 component files use
`bg-zinc-900/950` etc., zero `dark:` variants). Conversion strategy:

1. Introduce theme tokens in `app/globals.css`: `--surface`, `--surface-raised`,
   `--border`, `--text`, `--text-muted`, plus an orange accent scale anchored on
   `orange-600` (#ea580c) for primary actions, active nav, highlights, focus rings.
2. Sweep hardcoded dark classes → light equivalents (`bg-white`,
   `bg-zinc-50/100`, `border-zinc-200`, `text-zinc-900/500`). Mechanical, file by file.
3. Orange usage rules: primary buttons, active nav item, key CTAs, approval/
   publish actions, focus rings, AI accents. Never orange body text on white;
   never orange-on-orange. Destructive stays red, success stays green.
4. Charts/graphs: re-palette to light backgrounds with orange data series.

### Verification
- `tsc` + production build clean.
- Screenshot tour re-captured in light mode; spot-check contrast on every page.

---

## 2. Automation canvas ("Automations")

A node-graph canvas for building automations, per project, new sidebar nav item
"Automations". Built on `@xyflow/react` (React Flow v12 — graph library, not a
UI component, so outside the component constraint).

### Node types (v1)
- **Triggers:** Schedule (cron), Keyword rank drop, Competitor publishes,
  Content decay detected, Webhook, Manual.
- **Actions:** Generate content draft, Run SEO audit, Apply internal-link
  suggestions, Send alert / email, Generate report, Publish approved item.
  Actions reuse existing server capabilities (content engine, fix-agent,
  autopilot items, reports, alerts).
- **Approvals:** Human approval gate — pauses the run and pushes to the existing
  approval queue (`/api/autopilot/items/[id]/approve|reject`); run resumes on
  decision. This wires the canvas into the approval workflow Tico asked about.
- **Logic:** Condition branch (if/else on run data), Delay.

### Execution model (v1)
- Manual "Run now" + scheduled runs (schedule trigger) via the existing
  editor-gated cron session infrastructure.
- Run history per workflow with per-node status (pending / running / waiting
  approval / succeeded / failed) and full audit logging.
- Failure semantics: fail-closed, audit-logged, no partial publishes.

### Data model (new Prisma models)
`Workflow`, `WorkflowNode`, `WorkflowEdge`, `WorkflowRun`, `WorkflowRunStep`.
All scoped to project + workspace; role-gated (editor+ to edit, viewer read-only).

### Out of scope (v2)
Workflow templates/marketplace, versioning/diff, parallel-branch merging UI,
webhook signature verification UI.

---

## 3. Chat

### 3a. AI chat — LLM-style command center (per Tico 2026-09-22: NOT a floating copilot)
- Dedicated full-page chat, ChatGPT/Claude-style: conversation threads in a
  left rail, messages center, composer bottom. New sidebar nav item "Chat".
- Built to **execute everything**: keyword research, competitor gaps, content
  drafts, rank lookups, audits, autopilot queue management, report generation,
  site changes — all performed through the existing audited server APIs, never
  around them.
- Project-aware: scoped to the current project, with its keywords, rankings,
  content, alerts, and workflows as working context.
- Wired to the existing assistant pattern (`/api/sites/[id]/assist`,
  `/api/websites/[id]/assist`) generalized to a project-scoped assistant
  endpoint with tool-calling over Marketr's internal actions.
- Destructive, publish, and spend actions require explicit user confirmation
  in chat before executing. Every executed action is audit-logged.

### 3b. Team chat
- Per-project channel (workspace members on the project).
- New Prisma models: `ChatChannel` (one per project v1), `ChatMessage`.
- Polling-based v1 (5s refresh); no websocket infra in v1.
- Role-gated by existing project membership. @mentions in v2.

---

## 4. Build order
1. Theme tokens + light-mode sweep (all pages).
2. Automation canvas (models, API, canvas UI, execution, approval-gate wiring).
3. AI assistant chat (endpoint + panel + page).
4. Team chat (models, API, UI).
5. Full build + light-mode screenshot tour of new + changed surfaces.

## 5. Explicitly not in scope
No dark-mode toggle, no publishing/deploying, no new paid services,
no changes to the GitHub integration gaps (still unauthorized).
