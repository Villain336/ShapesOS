# Phase 14 — Actions & Office (Composio + Univer)

**Status:** SPEC DRAFT — queued. Starts after 13D lands (queue: 13B → 13C → 13D → 14).
**Decided by Tico:** 2026-09-28 — "add them as one phase new in line."
**Goal:** Marketr's agents stop being advisors and become operators — they *do* the work in the user's real apps (Composio), and the work product lives in a native office surface the user can open, edit, and send to clients (Univer). Plan → do → deliver, inside one product.

**The combo thesis:** 13B's learning loop makes agents smart. Composio makes them *useful* — 100+ app integrations behind one API (Gmail, Slack, Sheets, HubSpot, Notion, CRMs) so agents take real-world actions instead of writing to-do lists. Univer makes the output *real* — reports as live spreadsheets, content calendars, data tables, client-facing deliverables — not screenshots of a dashboard. Without both, the agent story ends at "here's a suggestion." With both, it ends at "done — review it."

---

## 1. Composio: the universal action layer

- **What it is:** agent tool-use platform — pre-built connector library (100+ SaaS apps), managed OAuth + per-user auth (token refresh, per-account scoping), tool router for catalog search, triggers, MCP endpoints, SOC 2 Type II / ISO 27001. SDK is MIT; the hosted platform is proprietary.
- **Pricing (verified 2026-09-28, re-verify at build time):** Free $0 / 20K tool calls per month; Pro $29/mo / 200K calls (one source says 50K — confirm); $229/mo / 2M; Business $599/mo; overages per 1K calls. Billed per tool invocation.
- **Self-host:** Enterprise tier only (custom quote). There is no free/local credential mode — on standard tiers, end-user OAuth tokens live in Composio's cloud. This is the central trust-boundary fact: the vault rule says credentials stay local; Composio's cheap tiers put them on someone else's servers.
- **Auth model:** end user connects apps once via Composio's OAuth flow (BYO OAuth apps where supported, minimum scopes). Marketr stores only the Composio entity/user reference per workspace — never raw tokens.
- **Data strategy fit:** self-hosted = customer brings their own Composio key (BYO, like BYO DataForSEO); hosted Marketr = keys bundled, cost metered into the ~90% gross-margin model.

## 2. Univer: the native office surface

- **What it is:** open-source embeddable office suite — sheets, docs, slides, bases. Core license **Apache-2.0** (fits the AGPLv3 + commercial playbook). Embeds via npm (`@univerjs/*` packages), React/Vue/Web Component templates, theming, localization; headless Node support for server-side generation.
- **Maturity (verified 2026-09-28):** Sheets is the most mature surface (workbooks, formulas, formatting, filtering, validation, conditional formatting). Docs has a rich editing model. Slides is under active development.
- **The Pro line (load-bearing):** Univer sells a commercial Pro tier — **xlsx import/export, charts, pivot tables, real-time collaboration, edit history, printing** are NOT in the Apache-2.0 core. A "send the client an .xlsx" flow needs either a Pro license or an export path we build ourselves. This is decision (b) below.
- **Where it lands in Marketr:** reports as *live* spreadsheets (not PDF snapshots), the content calendar as a real sheet, analytics tables that stay queryable, client-facing deliverables opened in Docs. The host (Marketr) owns storage — Univer hands us content snapshots to persist.

## 3. The approval gate — trust ladder for actions (load-bearing)

Composio ships **no native human-in-the-loop approval** in the platform (verified: community wrappers add their own risk-classification + approval callbacks around the execute endpoint). So the gate is OURS, matching Marketr's draft-first doctrine:

- **Risk tiers on every tool:** low (read-only: list/get/search — executes, logged) → medium (writes: create/update/send/upload — requires approval) → high (destructive: delete/revoke/cancel — requires approval + second confirmation on bulk). Tier derived from the action name, with manual overrides.
- **Approve/deny queue:** medium/high actions land in a review queue (UI surface, §7). Agent shows *what will happen in plain language* — never raw JSON — with edit-before-approve. Approvals expire; denial kills the action with a reason.
- **Never silent auto-execution.** The 13C draft-first pattern is the model: the agent prepares, the human confirms. Latchkey's approve/deny workflow is the natural substrate when it lands (M2) — this phase ships its own queue first, designed to migrate onto Latchkey.
- **Audit:** every action logged — who, when, tool, inputs, approval decision, outcome. Retention and RLS per workspace.

## 4. Data model (new Prisma models)

- `ComposioConnection` — workspaceId, appKey (e.g. `gmail`, `hubspot`), composioEntityId, status (connected | revoked | error), scopes, connectedAt. No raw tokens — only Composio references.
- `ComposioActionApproval` — workspaceId, toolName, riskTier, proposedArgs (redacted where sensitive), status (pending | approved | denied | expired), decidedBy, decidedAt, audit trail.
- `ComposioActionLog` — every execution: approvalId?, toolName, args summary, result summary, latency, cost attribution (tool calls per workspace for metering).
- `UniverDoc` — workspaceId, kind (sheet | doc | slide), title, snapshot (Univer IWorkbookData/IDocumentData JSON), version, sourceRef (e.g. which report/analytics run generated it), shareState.
- All tenant-scoped; RLS battery extended to the new tables.

## 5. Univer integration points (where the surface lives)

1. **Reports as live spreadsheets** — the Wave B analytics home (`/dashboard/analytics`) gains "Open as sheet": a report's data becomes a real Univer workbook the user can pivot, filter, annotate. Snapshot round-trips to `UniverDoc`.
2. **Content calendar** — the social/content calendar view backed by a sheet (dates, channels, status columns) instead of a bespoke grid; agents can draft rows into it for review.
3. **Data tables** — keyword research exports, competitor gap tables, lead lists: "Open in Sheets" from any dense table.
4. **Client deliverables** — agency users open a report in Docs/Sheets, polish, and export. Export path per decision (b).
5. **Agent-generated artifacts** — when an agent produces a table/plan in chat or a mission, it can materialize as a Univer doc with a review link (feeds the same approval-gate pattern as §3: agent proposes, human reviews).

## 6. Composio v1 action categories (what ships first)

- **Reads (auto, logged):** search/list/get across connected apps — e.g. "find last month's invoices in Gmail," "pull HubSpot deals," "read the content doc in Notion." No approval needed; everything logged.
- **Draft-creators (auto, reviewable):** create-as-draft actions — Gmail drafts, Notion page drafts, CRM record *proposals*. The artifact exists only as a draft the human sends/approves in the native app or the queue.
- **External writes (gated, always):** send email, post/publish, update CRM records, create calendar events — land in the approve/deny queue, no exceptions.
- **Destructive (gated + confirm):** delete, revoke, archive — approval plus explicit confirmation; bulk operations need per-item review.
- v1 app shortlist (build-time decision within the categories above): Gmail, Google Sheets, Slack, HubSpot, Notion. Each added app = new OAuth surface + new risk-tier overrides.

## 7. UI surfaces

- **Settings → Integrations → Actions:** connect/disconnect apps (Composio OAuth flow), per-app scope display, revoke, connection health.
- **Approvals queue:** pending actions with plain-language summaries, diff-style arg display, edit-before-approve, batch approve for same-tier related items, deny-with-reason. Lives wherever the Wave B inbox lands — one review surface, not a new tab maze.
- **Office viewer:** Univer embedded in the analytics home (reports-as-sheets), content calendar, and a standalone docs list per workspace. Follows the Studio UI house pattern; never hardcodes a primary color (brand vars).
- **Agent surfaces:** Chief Strategy Agent / missions / playbooks gain the Composio tool surface behind the §3 gate; "Open in Sheets/Docs" buttons on every dense table and report.

## 8. Build order

1. Data model + migrations + RLS on the new tables.
2. Composio substrate: connection model, OAuth connect flow, entity/user mapping per workspace, tool catalog fetch + risk-tier classification with overrides.
3. Approval gate: queue model, approve/deny/edit API, expiry, audit log, UI queue.
4. Read + draft-creator actions wired into the Chief Strategy Agent (behind the gate where required).
5. External-write + destructive actions through the gate (the full trust ladder).
6. Univer substrate: embed `@univerjs` sheets, snapshot persistence (`UniverDoc`), host-owned storage, theming via brand vars.
7. Reports-as-sheets (analytics home), content-calendar sheet, "Open in Sheets" on dense tables.
8. Docs embedding (deliverables) + export path per decision (b).
9. Slides: embed only if OSS maturity allows; otherwise stub the surface for a follow-up.
10. Metering: per-workspace tool-call counts surfaced in billing/usage; cost alerts before overage tiers bite.
11. Evals: risk-tier classification accuracy on the v1 tool catalog, approval-queue UX tests, Univer snapshot round-trip fidelity, "no silent execution" negative tests (attempted bypass of the gate fails closed).

## 9. Verification (definition of done)

- tsc clean, production build green, full tests green (new suites: risk classification, approval flow incl. expiry/deny, RLS on new tables, Univer snapshot round-trip, gate-bypass negative tests).
- Acceptance: an agent reads from a connected app and drafts an email with zero human clicks *except* the approval; the approval queue shows the plain-language summary; denying kills the action with a reason; nothing executes without a log entry.
- Univer acceptance: a report opens as an editable sheet, edits persist to `UniverDoc`, and the export path (per decision b) produces a client-ready file.
- Secret scan clean. Screenshots of the Actions settings, approval queue, and a live sheet. Local-only commit, nothing pushed.

## 10. Sequencing notes

- Runs after 13D. Composio work is independent of the 13B learning loop but benefits from it — the preference profile (§13B) can pre-fill approval defaults ("this workspace auto-approves low-risk reads" is already the doctrine; per-workspace escalation thresholds come later).
- Cost: Composio free tier (20K calls/mo) covers dev + early beta; hosted Marketr meters per-workspace calls and bundles or passes through per the data strategy. Define the overage alert threshold at build time.
- The approval queue is designed to migrate onto Latchkey's approve/deny workflow (M2) when it lands — keep the interface narrow (propose → approve/deny/edit → execute → audit).

## 11. Cost & license reality check (verified 2026-09-28)

- **Composio:** free tier is genuinely usable (20K calls/mo, no card); paid starts $29/mo. The risk is not price — it's the trust boundary: standard tiers hold user OAuth tokens on Composio's cloud, and true self-host is Enterprise-quote-only. The open-core alternative (e.g. Open Connector, AGPL-3.0, free self-host) exists if the vault rule wins. Re-verify pricing and the HITL story at build time — both move fast.
- **Univer:** $0 license cost for the core (Apache-2.0). The cost is the Pro question: xlsx import/export, charts, pivots, and real-time collab are commercial. Budget for either a Pro license or building CSV/PDF export ourselves (decision b).

---

## OPEN DECISIONS — Tico, your call (spec-first: nothing builds until you pick)

**(a) Composio hosted vs. open self-hosted alternative.**
*Option 1 — Composio hosted:* fastest to value (100+ pre-built connectors, managed OAuth, free tier to start), but user OAuth tokens live on Composio's cloud and true self-host is Enterprise-quote-only — a standing vendor dependency that bends the vault rule.
*Option 2 — Open self-hosted (e.g. Open Connector, AGPL-3.0 core, free self-host):* tokens stay on our infra, matches the AGPLv3 + commercial playbook, but a smaller connector catalog and we own more maintenance.
*The spec is written for Option 1 (the approval gate and data model are identical either way — only the provider changes).*

**(b) Univer scope + the xlsx question.**
*Option 1 — Sheets only v1:* the most mature surface, covers reports/calendars/tables; docs+slides wait.
*Option 2 — Full suite (sheets+docs+slides):* bigger embed, slides OSS is still maturing.
*And separately: xlsx import/export is Univer Pro (commercial), not in the Apache-2.0 core. Either we budget a Pro license, or v1 exports via CSV/PDF we build ourselves.*

**(c) Composio v1 action categories.**
*Option 1 — Conservative (spec default):* reads + draft-creators run freely (logged); every external write and all destructive actions go through the approve/deny queue from day one.
*Option 2 — Strict:* every action, including reads, starts gated until a per-workspace trust history builds, then graduated auto-approval.
