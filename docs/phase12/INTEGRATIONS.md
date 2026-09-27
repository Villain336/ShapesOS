# Marketr Phase 12 — Integration Guide

**Date:** 2026-09-27 · **Status:** shipped, local-only commit · **Nothing pushed or published**

Tico approved deep-integrating 5 tools, embedding 7 modules, reconsidering
Penpot / Plane / OpenNotebook, and adopting 5 Agency-Agents personas.
Spec-first was skipped per his explicit "build it" directive (noted in the
task-sentry ledger). License bible: `integration-survey.md` — its red lines
were obeyed throughout (see §6).

Every integration degrades to an **honest no-key / no-sidecar state** — no
fabricated data anywhere. All sidecars are optional compose profiles; the core
app boots and runs without any of them.

---

## 1. Deep integrations (the 5)

### 1a. Activepieces — automation backbone (MIT community)
- **Shape:** consume, don't fork. Pieces as npm packages
  (`@activepieces/pieces-framework` + 13 curated marketing pieces) + engine
  sidecar via REST.
- **What's wired:** typed client `lib/integrations/activepieces/` (flows, webhook
  trigger, run polling, 5 marketing recipes); 7 API routes under
  `app/api/integrations/activepieces/`; MCP tools `automation_trigger_flow` /
  `automation_flow_status`; metering entries (0 credits — user's own sidecar);
  Chief Strategy Agent tools (flow trigger is `spend`-kind → confirm-gated);
  **Missions:** "Run automation" action (`POST /api/missions/[id]/automations`,
  flow picker, run-status polling, `PlanStepKind += "automation"`);
  **Playbooks:** `stepType: "task" | "automation"` (additive JSON, no migration);
  **Settings → Providers** card (engine URL + API key).
- **Sidecar:** `docker/integrations/activepieces.yml` (`--profile activepieces`,
  MIT community only — no `ee/`).
- **Keys:** `ACTIVEPIECES_URL`, `ACTIVEPIECES_API_KEY` (+ `AP_ENCRYPTION_KEY`,
  `AP_JWT_SECRET`, `AP_POSTGRES_PASSWORD` for the sidecar).
- **Honest limits:** only published flows with a "Catch Webhook" trigger can fire
  externally; schedule/piece triggers get an explicit refusal.

### 1b. Listmonk — email engine (AGPL-3.0)
- **Shape:** sidecar only, talked to over raw REST. Never forked, never linked.
- **What's wired:** `lib/integrations/listmonk.ts`; API routes
  `app/api/integrations/{listmonk}/lists|subscribers|campaigns|status`;
  **Nurture → Broadcasts** tab (`BroadcastsTab.tsx`); Providers card
  (`LISTMONK_URL`, `LISTMONK_USER`, `LISTMONK_TOKEN`).
- **Sidecar:** `docker/integrations/listmonk.yml` (single Go binary + its own DB).
- **Why Listmonk over Mautic:** single binary + Postgres vs PHP + cron — the
  right ops shape for a self-hosted SaaS.

### 1c. Postiz — social publishing (AGPL-3.0)
- **Shape:** sidecar only, **raw fetch/REST only — the AGPL `@postiz/node` SDK
  is never installed or imported** (license red line).
- **What's wired:** `lib/integrations/postiz.ts`; API routes
  `app/api/integrations/postiz/{channels,posts,status}`; **Social** app
  (`app/dashboard/social/`); Providers card.
- **Sidecar:** `docker/integrations/postiz.yml`.
- **Keys:** `POSTIZ_URL`, `POSTIZ_API_KEY`.

### 1d. GrapesJS — Pages surface (BSD-3)
- **Shape:** npm dependency (`grapesjs` + `grapesjs-preset-newsletter`), mounted
  client-side inside Studio. Complementary to the Konva Canvas: Canvas = PNG/SVG
  assets, **Pages = responsive HTML landing pages + email templates**.
- **What's wired:** new **Studio → Pages** tab (dense table, filter toolbar, New-page
  modal with kind sub-tabs, template gallery); full-bleed editor route
  (`GrapesEditor.tsx`: device switcher, preview toggle, Export HTML download +
  copy, email CSS-inlining via the newsletter preset, dirty/saved indicator);
  `PageDraft` model + migration `20260927160000_phase12_page_drafts`;
  tenant-scoped API (`app/api/studio/pages/`); brand-token substitution at load
  (colors/fonts from the workspace brand kit).
- **Seed templates:** 6 landing (hero-saas, webinar, newsletter-landing,
  product-launch, event, coming-soon) + 2 table-based 600px email templates,
  all with `{{brand.*}}` tokens.
- **No key needed.** Compromise: brand swatches not injected into GrapesJS's own
  color pickers (API churn risk); token substitution covers the seeds.

### 1e. Payload — CMS layer (MIT, cleanest license in the survey)
- **Shape:** runs **inside** the Next.js app via `@payloadcms/next` v3,
  `@payloadcms/db-postgres`, `@payloadcms/richtext-lexical`.
- **What's wired:** `payload.config.ts` (collections: Posts, Pages, Media,
  CMSUsers); admin at `/admin`; REST/GraphQL at `/cms-api/*` (deliberately NOT
  `/api/*` — Marketr's own surface, e.g. `/api/media`, would shadow it, and
  `/api/*` sits behind the proxy rate limiter); **separate `payload` Postgres
  schema** so Payload tables never collide with Prisma's; seed script.
- **Keys:** `DATABASE_URL` (shared), `PAYLOAD_SECRET` (generate:
  `openssl rand -hex 32`; dev fallback is a placeholder — set a real one).
- **No new infra.** Admin is lazy-loaded so the main bundle stays lean.

---

## 2. Embedded modules (7)

| Module | License | Shape | Keys |
|---|---|---|---|
| **Umami** | MIT | Cookieless analytics sidecar (`docker/profiles/umami.yml`); `UmamiTracker` snippet (inert unless configured); `/dashboard/analytics` panel; Providers card | `UMAMI_URL`, `UMAMI_API_KEY`, `UMAMI_WEBSITE_ID`, `UMAMI_SCRIPT_URL` |
| **rrweb** | MIT | Opt-in per share link (ShareModal checkbox, default off, `maskAllInputs`); token-bound batched ingest; replay viewer at `/s/[token]/replay` (workspace-authed) **and** dashboard route `/dashboard/studio/designs/[id]/replay/[shareId]` linked from share management ("replay · watch") — no raw token handling | none |
| **Chatwoot** | MIT core | Widget embed, **off by default even with credentials** — mounts only when `CHATWOOT_WIDGET_ENABLED=true`; dashboard-only | `CHATWOOT_BASE_URL`, `CHATWOOT_WEBSITE_TOKEN`, `CHATWOOT_WIDGET_ENABLED=true` |
| **Ghost** | MIT | Admin API JWT (HS256 via `node:crypto`); "Publish to Ghost" from ContentDetail (draft by default, optional publish, status refresh) | `GHOST_URL`, `GHOST_ADMIN_API_KEY` |
| **GrowthBook** | Open core (MIT bulk) | Sidecar (`docker/profiles/growthbook.yml`); **per-workspace flag overrides** (`WorkspaceFlagOverride`, migration `20260927195519_phase12_flag_overrides`) — GrowthBook's global default is never mutated; 2 real flags wired (`studio.compact-hero`, `content.brief-v2`); Experiments settings page | `GROWTHBOOK_API_HOST`, `GROWTHBOOK_API_KEY`, `GROWTHBOOK_CLIENT_KEY` |
| **Documenso** | AGPL CE | **API-only** (white-label embedded signing needs the commercial license — red line): create/send/refresh signing requests, PDF validation, auditable local rows, Signing settings page with explicit "no embedded signing" notice | `DOCUMENSO_URL`, `DOCUMENSO_API_KEY` |
| **Coolify** | Apache-2.0 | **Docs only** (`docs/phase12/coolify-white-label.md`): per-client isolated white-label instance provisioning, one-click template shape, env vars, agency-vs-client ownership boundaries. Explicitly NOT hosting-as-a-product (support burden, abuse liability, thin margins). | — |

---

## 3. Reconsidered trio

### Penpot — bridge, not merge (MPL-2.0)
Evaluated honestly per Tico's ask. **A code merge was rejected:** Clojure/ClojureScript
+ Rust/WASM codebase, 4-service runtime, and it's the wrong *kind* of editor
(product-UI design tool vs our marketing-asset Konva Canvas — our Canvas is
further along for the job). **What shipped instead:** a Penpot token bridge —
import design tokens (colors, typography) from a Penpot file into the Marketr
brand kit via API (`app/api/studio/penpot/`) or paste-export fallback
(`lib/design/penpot.ts`), surfaced as a section in the editor's Brand panel.
Penpot's MCP/RPC surface was the only touchpoint worth building on.

### Plane — productivity (AGPL-3.0)
- **Shape:** sidecar + raw REST (`lib/integrations/plane.ts`, no AGPL code linked).
- **What's wired:** API routes `app/api/integrations/plane/{projects,issues,status}`;
  **Missions → Tasks tab** — live Plane issues for a chosen project (dense table,
  state/priority chips, link-out to Plane), honest not-connected state pointing
  to Settings → Providers. Read-only window; tasks stay managed in Plane.
- **Keys:** `PLANE_BASE_URL`, `PLANE_API_KEY`, `PLANE_WORKSPACE_SLUG`.
- Rejected as a fork: wrong domain to own; sidecar + sync is the right shape.

### OpenNotebook — content repurposing (MIT)
- **Shape:** **not forked** — implemented as a native pipeline over our own RAG
  (`lib/content/repurpose.ts`): `retrieveExpertContext()` grounds, the LLM
  synthesizes original copy (Tier 1S discipline — never verbatim), every asset
  carries source citations, mock (no-key) runs are labeled `mock: true`.
- **What's wired:** `POST /api/content/repurpose` (workspace-viewer+); new
  **Intelligence → Repurpose** page (format sub-tabs: brief / video script /
  social thread / newsletter; topic input; copy button; sources list).
- **No key needed** beyond the existing LLM provider key (mock-labeled without).

---

## 4. Agency-Agents personas (MIT, `msitarzewski/agency-agents`)

Five persona prompt files distilled into **original** system-prompt seeds
(ideas only, rewritten in Marketr's constitution voice — no verbatim copying;
provenance recorded in every module's `PERSONA_PROVENANCE` export):
`lib/expert/personas/` (registry + `personaSystemPrompt()`, layered BEHIND the
global hard rules — same contract as `constitutionSystemPrompt()`).

| Persona | Wired to |
|---|---|
| Multi-Agent Systems Architect | Playbooks (`PLAYBOOK_STRATEGIST_PERSONAS`) |
| Workflow Architect | Playbooks |
| Studio Producer | Missions (`MISSION_PLANNING_PERSONAS`) |
| Business Strategist | Chief Strategy Agent (`CSA_ADVISOR_PERSONAS`) |
| Agents Orchestrator | Chief Strategy Agent |

---

## 5. Compose profiles (all optional)

```
docker/integrations/activepieces.yml   --profile activepieces
docker/integrations/listmonk.yml       --profile listmonk
docker/integrations/postiz.yml         --profile postiz
docker/profiles/umami.yml              --profile umami
docker/profiles/growthbook.yml         --profile growthbook
```
Plane, Chatwoot, Ghost, Documenso, Coolify are BYO/externally-hosted — no
compose shipped (documented in each provider card).

---

## 6. License red lines obeyed

- Postiz: raw fetch only — `@postiz/node` SDK never installed/imported.
- Documenso: API-only; no embedded white-label signing UI (commercial-only).
- Activepieces: community MIT image; `packages/ee/` untouched.
- GrowthBook: MIT bulk paths only; `enterprise/` dirs untouched.
- Umami/Chatwoot/Ghost/Payload/GrapesJS/rrweb/Coolify/OpenNotebook: clean
  MIT/Apache/BSD grants, no EE partitions touched.
- **Excluded — not touched:** Formbricks (no-white-label policy), Remotion
  (source-available, no-resale-derivatives), Unleash (AGPLv3 since v8),
  PostHog (25-service fleet), Twenty (redundant), Mautic (wrong ops shape),
  Strapi (EE carve-out on RBAC/audit/SSO).

## 7. Verification (2026-09-27)

- `tsc --noEmit` (4GB heap): **clean**.
- Unit tests (`npx tsx --test`, node:test convention): **1130/1132** — the 2
  failures are pre-existing/environmental (`lib/playbooks/__tests__/store.test.ts`
  "learned promotion" needs the `pgvector` extension, absent from the test DB;
  fails identically on the pre-Phase-12 tree).
- `next build`: green.
- Preview: `/` 200, `/dashboard` 307, real static chunk 200, 0 page errors.
- Secret scan: clean. `training/` untouched and excluded from the commit.

## 8. Keys Tico may add later (all under Settings → Providers)

Activepieces · Listmonk · Postiz · Umami · Chatwoot · Ghost · GrowthBook ·
Documenso · Plane · (existing: Brandfetch, Pexels, Pixabay, Cloudinary,
Unsplash, LLM provider). Never in chat — the Providers page is the only place.
