# Marketr Totality Audit — Workstream 2: Architecture Map

Research-only audit. No code changed, no builds, no commits. Repo: `~/workspace/marketr`.
All counts measured with `find`/`grep` against the working tree on 2026-09-27; anything not confirmed is marked **UNVERIFIED**.

---

## 1. API Route Inventory

**Measured: 634 `route.ts` files** under `app/api` (`find app/api -name route.ts | wc -l`; first-level group sums independently re-added to 634).

| Routes | Group | Routes | Group |
|---|---|---|---|
| 66 | `studio` | 5 | `scheduler` |
| 53 | `authority` | 5 | `keywords` |
| 42 | `flywheel` | 5 | `corpus` |
| 34 | `media` | 5 | `connections` |
| 28 | `substrate` | 5 | `billing` |
| 25 | `websites` | 4 | `review-requests` |
| 25 | `cron` | 4 | `hosting` |
| 21 | `intelligence` | 4 | `gbp` |
| 19 | `integrations` | 4 | `automation` |
| 18 | `newsletter` | 3 | `webhooks` |
| 14 | `mail` | 3 | `usage` |
| 13 | `calls` | 3 | `schedules` |
| 12 | `attribution` | 3 | `e2e` |
| 11 | `nurture` | 3 | `competitors` |
| 11 | `playbooks` | 3 | `chat` |
| 11 | `crm` | 3 | `brand-kits` |
| 9 | `social` | 2 | `settings` |
| 9 | `projects` | 2 | `s` (public share) |
| 9 | `mcp` | 2 | `reviews` |
| 9 | `eddm` | 2 | `reports` |
| 8 | `programmatic` | 2 | `report-templates` |
| 8 | `autopilot` | 2 | `rankings` |
| 7 | `workspace` | 2 | `members` |
| 7 | `sites` | 2 | `files` |
| 7 | `prospects` | 2 | `experiments` |
| 7 | `messaging` | 2 | `enrichment` |
| 7 | `ads` | 2 | `documenso` |
| 6 | `workflows` | 2 | `backlinks` |
| 6 | `missions` | 2 | `alerts` |
| 6 | `local` | 2 | `alert-rules` |
| 6 | `content` | 2 | `alert-channels` |
| 6 | `connectors` | 1 | `visibility-score` |
| 5 | `skills` | 1 | `team` |

*(table continues: `serp`, `review-config`, `radar`, `orchestrator`, `mail-nurture`, `internal-links`, `decay`, `command`, `auth`, `analytics`, `ai-visibility` — 1 each. Plus the MCP server itself lives at `app/mcp/route.ts`, outside `/api`, and Payload at `app/(payload)/cms-api/[...slug]/route.ts`.)*

**Dead/duplicate routes (measured):**
- **No exact duplicate paths.** (All 634 paths de-duplicated after stripping `/route.ts` → 634 unique.)
- **No dead route dirs.** 141 intermediate dirs have no `route.ts` of their own (e.g. `api/studio/canva`, `api/websites/[id]/issues`, `api/newsletter/webhooks`), but every one of them has at least one descendant with a `route.ts`. No dir lacks both.
- **Notable collisions avoided by design:** `/api/media` is Marketr's own upload API — Payload's REST API was deliberately mounted at `/cms-api/*` (not `/api/*`) to avoid shadowing it (`payload.config.ts` header comment).

---

## 2. Substrate / Graph + Tenant Isolation

### The Graph substrate (`lib/substrate/`)
Three modules, all RLS-wrapped:
- **`lib/substrate/graph/`** — Business Graph: 20 entity types (`customer`…`form_cta`), 16 edge types (`WORKS_AT`, `SAME_AS`, `NOT_SAME`…), dedupe keys, entity resolution/merge (`resolve.ts`, `merges.ts`), bi-temporal facts (`facts.ts`), freshness labels (`freshness.ts`), connector tiers (`connectors/tierm|tierw|tiers`, deadletter, HMAC webhooks).
- **`lib/substrate/memory/`** — Growth Memory: episodes/facts/learnings, local MiniLM embeddings (`embed.ts`), hybrid retrieval (`recall.ts`).
- **`lib/substrate/campaigns/`** — campaign store + RLS.
- `lib/substrate/context.ts` — context packets handed to agents.

### The RLS pattern (measured in DB + code)
- `lib/substrate/graph/rls.ts::withWorkspaceScope(workspaceId, fn)` — wraps `fn` in a Prisma transaction, `SET LOCAL app.workspace_id = $1` (parameterized). Comment states the contract: every graph table has **FORCE ROW LEVEL SECURITY** with a tenant policy on the `app.workspace_id` GUC; a session without the GUC sees **zero rows (fail-closed)**. Application `where: { workspaceId }` filters remain as defense in depth.
- **DB-verified:** `pg_tables.rowsecurity = true` on `graph_nodes`, `graph_edges`, `graph_facts`, `graph_connectors`, `graph_sync_jobs`, `graph_er_queue` (durable PG16, port 5433).
- Same `withWorkspaceScope` pattern duplicated in `lib/substrate/memory/rls.ts` and `lib/substrate/campaigns/rls.ts`. 70 files reference it (`grep -rl`).

### How API routes enforce tenant isolation (sampled)
| Route | Pattern |
|---|---|
| `app/api/keywords/saved/route.ts` | `requireUser()` → project lookup via `accessibleWorkspaceWhere(user.id)` (owner-or-member OR clause) → 404 if foreign |
| `app/api/alerts/route.ts` | `requireUser()` → `getOrCreateWorkspace()` → every query `where: { workspaceId: workspace.id }` |
| `app/api/missions/_lib.ts` (guard for all mission routes) | `missionsGuard(min)` — session → workspace; mutations need `editor+`; engine deps call `withWorkspaceScope` + `where: {workspaceId}` |
| `app/api/integrations/activepieces/_lib.ts` | `integrationsGuard(min)` — same session→workspace; trigger routes need `editor+` |
| `app/api/cron/fix-agent/route.ts` | `Authorization: Bearer <redacted>` shared service secret (not a user role); 31 cron/service routes use `CRON_SECRET` |
| `app/api/corpus/graph/route.ts` | `requireUser()` + `requireWorkspaceRole(viewer)`; corpus itself is workspace-agnostic by design (product asset, not tenant data), but reads are role-gated per workspace |
| `app/mcp/route.ts` | MCP JSON-RPC: Bearer <redacted> key or OAuth token; **tenant `workspaceId` derived server-side from auth, never from args** (`lib/mcp/tools.ts` T1); every handler re-checks scope + `where: { workspaceId }` |

Grep-measured guard usage (approximate — shared guards like `missionsGuard` wrap the primitives): `requireUser` in 312 routes, `requireWorkspaceRole` in 91, `requireProjectRole` in 77, `CRON_SECRET` in 31. Layered model: **session → RBAC role (owner>admin>editor>viewer, `lib/authz.ts`) → per-query workspace scoping → RLS GUC on the graph substrate.**

---

## 3. Agent Stack

### The stack, top to bottom
1. **Constitution** — `EXPERT-CONSTITUTION.md` (v1, 2026-09-26) → runtime twin `lib/expert/constitution.ts` (`CONSTITUTION_VERSION = "1"`, verbatim transcription). 4 roles: `chief-strategy`, `mission-planner`, `playbook-generator`, `content-brief`. Global hard rules (zero custody, autopilot never buys, propose/execute separation, honest labeling, no invented proof, voice restraint) prepended to **every** prompt via `constitutionSystemPrompt(role)`; `groundedPrompt()` assembles constitution → M9 retrieval → task. 12 SFT exemplars (`EXPERT_EXEMPLARS`) double as fine-tune seed rows.
2. **Persona seeds** — `lib/expert/personas/` (5, distilled from msitarzewski/agency-agents, MIT, rewritten): `business-strategist`, `agents-orchestrator`, `multi-agent-systems-architect`, `workflow-architect`, `studio-producer`. Approved wiring map in `index.ts`: playbooks → multi-agent-systems-architect | workflow-architect (`lib/playbooks/store.ts`), missions → studio-producer (`planner.ts MISSION_PLANNING_PERSONAS`), CSA/chat → business-strategist | agents-orchestrator (`lib/chat/agent.ts CSA_ADVISOR_PERSONAS`). Prompt contract: persona prompt sits **behind** the global hard rules.
3. **Chief Strategy Agent** — `lib/orchestrator/orchestrator.ts`: one orchestrator per workspace; routes, sequences, verifies — never does the work. Determinism at the seams: `ROUTING_TABLE` (task kind → executor), 20-hop circuit breaker, per-mission caps (40 steps, 10 min timeout, $100 cost budget, 3 consecutive failures), novel-task default = escalate to human. Executors in `lib/orchestrator/executors/`: `researcher`, `planner`, `drafter`, `analyst`, `scheduler`. Audit log (`audit.ts`), kill switch (`killswitch.ts`), approvals authority (`authority.ts`).
4. **Missions** — `lib/missions/` (`engine.ts`, `prisma-store.ts`, `templates.ts`): hash-chained event log, approval gates, pause/resume. Mission models live in Prisma (`Mission`, `MissionEvent`, `MissionApproval`, `MissionApprovalEvent`, `MissionPlaneLink`).
5. **Playbooks** — `lib/playbooks/store.ts` + Prisma `Playbook`/`PlaybookVersion`/`PlaybookLearning`.
6. **MCP tools** — `lib/mcp/` (`protocol.ts`, `tools.ts`, `scopes.ts`, `auth.ts`, `oauth.ts`, `metering.ts`, `rateLimit.ts`, `audit.ts`): 10 task-oriented tools (not REST mirrors); `/* INTEGRATION:activepieces */` block imports `triggerFlow`, `getFlowRun`, `latestFlowRun` from `lib/integrations/activepieces`. Vendor-backed tools return honestly-labeled mock data when live is unavailable.
7. **Activepieces client** — `lib/integrations/activepieces/` (`client.ts`, `config.ts`, `pieces.ts`, `types.ts`): API-key client against the self-hosted engine.

### End-to-end trace: a Mission triggering an Activepieces flow
1. Human clicks "Run automation" in the Mission UI → `POST /api/missions/:id/automations` (`app/api/missions/[id]/automations/route.ts`).
2. `missionsGuard("editor")` — session → workspace, editor+ required.
3. Honest-config check: `isActivepiecesConfigured()` (needs `ACTIVEPIECES_URL` + `ACTIVEPIECES_API_KEY`); if absent → **503 "not connected"**, nothing fires.
4. Preflight (same as the integrations API): only published flows with a "Catch Webhook" trigger can be fired; payload capped at 256 KB; key material never returned.
5. `triggerFlow(flowId, payload)` in `lib/integrations/activepieces` → POSTs the webhook URL; the trigger is **not awaited** — returns `{ accepted: true, runId }`; poll via `/api/integrations/activepieces/runs/:runId`.
6. Outcome is recorded in the mission's hash-chained event log via `appendStepEvent` from `lib/missions/engine.ts` (the M4 engine twin).
7. Direct API path also exists: `POST /api/integrations/activepieces/flows/:flowId/trigger` (editor+, same preflight) — and MCP clients get the same capability through the Activepieces block in `lib/mcp/tools.ts`.
8. **Retrieval wiring along the way:** `executors/researcher.ts` injects `retrieveExpertContext` (M9 corpus, cosine over chunk embeddings, per-workspace usage logged); `planner.ts` wraps plans with `groundedPrompt()`; `analyst.ts` calls Growth Memory `recall(workspaceId, …)`.

**Live vs aspirational:** the full call chain is implemented and wired. `ACTIVEPIECES_URL`/`ACTIVEPIECES_API_KEY` are **not set in the preview `.env`** (grep found zero matches), so the live preview exercises only the honest-503 path; the trigger path is tested in `lib/integrations/activepieces/__tests__`. The engine itself is an optional docker sidecar (`docker/integrations/activepieces.yml`).

---

## 4. Data Layer

- **Prisma: 248 models, 131 enums** in `prisma/schema.prisma` (measured `^model ` / `^enum `). Major models: `Workspace`, `WorkspaceMember`, `Project`, graph substrate (`GraphNode`, `GraphEdge`, `GraphFact`, `GraphConnector`, `GraphSyncJob`, `GraphErQueue`), Growth Memory (`MemoryEpisode`, `MemoryFact`, `MemoryLearning`, `MemoryConsolidationRun`), agents (`Mission`, `MissionEvent`, `MissionApproval`, `Playbook`, `PlaybookVersion`, `AutomationSetting`), scheduler (`ScheduledSkill`, `SkillRun`, `SubagentRun`), MCP (`McpApiKey`, `McpOAuthClient/…Code/…Token`), connectors (`Connector`, `ConnectorConnection`, `ConnectorCredential`), studio (`StudioCanvaAccount`, `StudioDomain`, `ProjectAsset`), CMS-adjacent Marketr models plus product domains: `Keyword`, `Ranking`, `Competitor`, `ContentItem`, `AutopilotRule`, `NewsletterBroadcast`, `SocialPost`, `AdCampaign`, `Workflow`, `AiChatThread`, `SiteAudit`, `GbpPost`, `Review`, `ProgrammaticPage`, `LocalGrid`, `VisibilityScore`, `Backlink`, `ApiMeterEntry`, `CommandAudit`, `WorkspaceFlagOverride`, …
- **Migrations: 66 applied / 66 migration dirs** — `_prisma_migrations` count (66) matches the dir count exactly (fully in sync). Latest migrations are Phase-12 (`20260927192738_phase12_embeds`, `20260927195519_phase12_flag_overrides`).
- **pgvector: installed on the durable DB — `vector` 0.6.2 + `pg_trgm` 1.6** (measured via `pg_extension`). Used in `vector(384)` columns on `MemoryEpisode`, `MemoryFact`, `MemoryLearning` (Growth Memory embeddings, local MiniLM-L6-v2, `EMBED_DIMS = 384` in `lib/substrate/memory/embed.ts`). Hybrid retrieval recipe: tsvector/pg_trgm + pgvector HNSW → fusion → local cross-encoder rerank → MMR + recency decay (`lib/substrate/memory/recall.ts`).
- **Redis/queues:** **no Redis client in core app code** (no `ioredis`/`redis` imports; no bullmq/pg-boss/graphile in `package.json`). Queues are DB-backed: `GraphErQueue`, `MissionEvent` hash chain, scheduler tables. Redis appears only as a sidecar dependency inside `docker/integrations/{activepieces,postiz}.yml` and base `docker-compose.yml` — not used by the Next app itself.
- **Cron/scheduler:** DB-backed scheduler (`lib/scheduler/`: `cron.ts` parser, `tick.ts` due-firing + missed-cron catch-up, `service.ts` firing, `guard.ts`, `outputStore.ts`, `events.ts`, `audit.ts`). Ticks arrive two ways: `/api/scheduler/tick` (session-triggered, single workspace) and 25 `/api/cron/*` routes (`alerts`, `fix-agent`, `local-grid`, `nurture`, `reports`, …) gated by `CRON_SECRET` Bearer <redacted> (meant to be driven by external cron/systemd/Vercel Cron; header comment in `fix-agent/route.ts`). `lib/cron/gate.ts` also exists. **UNVERIFIED:** whether any external cron is actually scheduled against the preview.

---

## 5. Corpus / RAG (M9)

- **Live corpus:** `data/corpus/` — `manifest.json`, `main/`, `by-sa/`, `synthesis/`, `incoming/`, `proposals/`, activity logs.
- **Manifest verified (measured, not from docs):** `corpusVersion = 9`, `updatedAt = 2026-09-27T03:13:17Z`, **339 sources, 5,924 chunks** (chunks summed per-source — matches the documented v9 totals). Docs claim "339 sources, 5,924 chunks" — **confirmed**.
- **Staging (not live):** `corpus/tier1s/` — 30 original-synthesis playbooks (marketing + design), MANIFEST.md explicitly says STAGING, not yet registered/integrated.
- **Retrieval (`lib/intelligence/corpus/`):** `retrieve.ts::retrieveExpertContext()` — query embedding (local model) vs chunk embeddings, cosine similarity, topK 1–20, source attribution, per-workspace usage logged (`activity.ts`); workspace-agnostic by design (product asset). Supporting modules: `chunker.ts`, `embed.ts`, `store.ts`, `ingest.ts`, `graph.ts` (corpus graph), `brain3d-layout.ts`, `allowlist.ts`.
- **How it feeds agents:** researcher executor (`lib/orchestrator/executors/researcher.ts:73,155`) lazy-imports `retrieveExpertContext`; planner and content draft (`lib/content/draft.ts`, `lib/chat/agent.ts`, `lib/playbooks/store.ts`) assemble prompts via `groundedPrompt()` — constitution first, M9 retrieval grounding after. Growth Memory recall runs on a separate local path (`lib/substrate/memory/recall.ts`).
- **Knowledge Brain:** lives at `app/dashboard/intelligence/corpus/brain/` (server `page.tsx` + `BrainClient.tsx` + `BrainScene3D.tsx` 3D galaxy + 2D canvas + health strip + sources table + dialogs). **Wired to live data:** `BrainClient` fetches `GET /api/corpus/graph`, which loads `data/corpus/manifest.json` live (`loadManifest()` + `buildCorpusGraph()`), layers proposed sources (`data/corpus/proposed/`) and removal flags on top — no code change needed for new entries. The 3D layout (48 cores / ~2,678 sparkles in code comments; current manifest will differ) is deterministic from real manifest chunk counts. Also exposes propose/flag/rebuild actions (`/api/corpus/propose`, `/remove`, `/rebuild`).
- **Training dir:** `training/` holds the trace-dataset pipeline (`TRACE-DATASET-PLAN.md`, `TRAINING-ROADMAP.md`, `r10-generator.py`, `evals/`, pilot traces) — **data-factory work, not yet a trained model** (aspirational: 2,730-trace pilot per alignment notes).

---

## 6. Payload CMS

- **Config:** `payload.config.ts` — `@payloadcms/next` `withPayload` (see `next.config.ts:2`), mounted **inside** the Marketr Next.js app.
- **Mount points:** admin UI at `/admin` (`app/(payload)/admin/[[...segments]]`), REST + GraphQL at `/cms-api/[...slug]` (`app/(payload)/cms-api/[...slug]/route.ts`) — deliberately not `/api/*` to avoid shadowing Marketr's own routes and the `proxy.ts` rate limiter.
- **Collections (4):** `CMSUsers`, `Media`, `Pages`, `Posts` (`payload/collections/`).
- **DB connection:** reuses the same durable Postgres 16 (`role/db marketr`, port 5433, `DATABASE_URL`) but in a **separate `payload` schema** so Payload tables never collide with Prisma's. **DB-verified:** `payload` schema exists with `cms_users`, `pages`, `media`, `posts`, `payload_locked_documents`, etc.
- **Caveat (from config comments):** `push: true` syncs schema on init — dev-friendly; switch to `payload migrate:create` before production use. I.e. Payload's schema is **not** migration-managed today.

---

## 7. External Sidecars

| Compose file | Services (images) | Status |
|---|---|---|
| `docker-compose.yml` (base) | `postgres:16-alpine`, `redis:7-alpine`, `minio/minio:…` | Infra building blocks; core app currently uses the durable local PG (`.pgdata`, port 5433) instead |
| `docker/integrations/activepieces.yml` | `activepieces/activepieces:latest` ×2 (MAIN+WORKER), `postgres:16-alpine`, `redis:7-alpine` — profile `activepieces` | Runnable; MIT Community edition only (header explicitly avoids `AP_EDITION=ee`). Optional; app degrades to honest 503 when unconfigured |
| `docker/integrations/listmonk.yml` | `listmonk/listmonk:latest`, `postgres:16-alpine` — profile `listmonk` | Runnable; matches `app/api/integrations/listmonk` + `lib/integrations/listmonk.ts` |
| `docker/integrations/postiz.yml` | `ghcr.io/gitroomhq/postiz-app:latest`, `postgres:16-alpine`, `redis:7-alpine` — profile `postiz` | Runnable; matches `app/api/integrations/postiz` + `lib/integrations/postiz.ts` |
| `docker/profiles/growthbook.yml` | GrowthBook | Runnable; `lib/integrations/growthbook.ts` + overrides |
| `docker/profiles/umami.yml` | Umami | Runnable; `lib/integrations/umami.ts` |

All sidecars are real, runnable compose manifests (official images, community/MIT editions) — **none is docs-only**. All are optional: the core app runs without any of them, and each integration surface reports an honest "not connected" state when its env vars are absent. (Activepieces is the only one with a UI-facing trigger path — Missions — and it is unconfigured in the preview `.env`.)

---

## How a request flows (one trace)

**Editor asks the Chief Strategy Agent for a Q4 plan, which fires an Activepieces flow:**

1. `POST /api/orchestrator/ask` (or chat) → session → workspace (`getOrCreateWorkspace`), RBAC check.
2. Chief Strategy Agent (`lib/orchestrator/orchestrator.ts`) builds the system prompt: `GLOBAL_HARD_RULES` → role constitution (`chief-strategy`) → CSA persona seeds (`business-strategist`/`agents-orchestrator`) → `retrieveExpertContext()` grounds it in the 5,924-chunk M9 corpus → the task. It routes via `ROUTING_TABLE`: `plan` → **planner executor**, which adds the `studio-producer` persona lens.
3. The planner produces a mission plan; `lib/missions/engine.ts` persists the `Mission` + hash-chained `MissionEvent`s via `prisma-store.ts` — **inside `withWorkspaceScope()`** so FORCE RLS pins the tenant GUC; `where: { workspaceId }` as defense in depth.
4. The mission's automation step (or the human's "Run automation" click) → `POST /api/missions/:id/automations` → `missionsGuard("editor")` → preflight (published webhook-trigger flow only, 256 KB payload cap) → `triggerFlow()` in `lib/integrations/activepieces` → webhook POST to the sidecar engine.
5. The run is async; outcome recorded back into the mission event log (`appendStepEvent`); run status pollable at `/api/integrations/activepieces/runs/:runId`. Money rules hold throughout: the constitution's zero-custody/autopilot-never-buys rules sit in front of every agent turn, and approval gates (`MissionApproval`) stand between propose and execute.

## UNVERIFIED / honesty notes
- Whether any external cron actually invokes the 25 `/api/cron/*` routes or `/api/scheduler/tick` on the preview — no schedule source found in-repo (keeper may or may not call them).
- MCP server (`/mcp`) live path not exercised here; key material redacted by design.
- The embedding models (`@xenova/transformers`) download on first use — recall/embed paths throw honest errors if the model cache is missing; not verified as warmed on the preview.
- Payload `push: true` schema sync vs the verified `payload` schema tables: tables exist, so init has run at least once.
- Counts above are working-tree measurements; `tests/` and generated artifacts were excluded from route counts but may double-count some lib helpers referenced in multiple places.
