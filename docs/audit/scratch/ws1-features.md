# WS1 — Feature Inventory by Phase (code-verified)

**Date:** 2026-09-27 · **Repo:** `~/workspace/marketr` · **Method:** research only — no builds, no test runs, no commits.
**Method:** for each claimed feature, confirmed the route/component/lib file EXISTS and spot-read files for real logic vs stubs. Statuses:
- **SHIPPED+TESTED** — real code + co-located `*.test.*` file(s) found
- **SHIPPED-THIN** — real code verified by reading, no unit tests found
- **STUB** — UI shell / route with TODO / mock data / no backend
- **CLAIM-ONLY** — documented but no code found
- **UNVERIFIED** — could not confirm either way

**Measured totals (this audit):**
- API `route.ts` files: **634**
- Test files (`*.test.ts(x)`, excl. node_modules): **82**; ~**1,160** `test(`/`it(` call sites (docs/phase12 claim 1130/1132 passing — same magnitude, not re-run)
- Dashboard `page.tsx`: **127** · components `*.tsx`: **174** · Prisma models: **248**
- E2E specs exist too (`tests/e2e/*.spec.ts`) — not counted above

**Honesty notes:** no "not implemented" throws anywhere in app/lib; all `mock`/`placeholder` grep hits are benign (demo-mode connectors, comments, anti-placeholder prompt instructions). Core modules (mail, calls, crm, attribution, authority, media, flywheel, alerts, reviews, prospects, projects, files) carry **zero** co-located lib tests — test coverage concentrates in `lib/design`, `lib/intelligence/*`, `lib/integrations`, `lib/orchestrator`, `lib/expert`, `lib/playbooks`, `lib/missions`, `components/command-bar`. I did not run tsc/tests/build or render any UI (out of scope), so "+TESTED" means tests exist, not that they currently pass.

---

## Phase M1–M11 core

| Feature | Status | Evidence |
|---|---|---|
| Keyword research | SHIPPED+TESTED | `app/api/keywords/` ×5 routes (269 LOC); `components/KeywordResearch.tsx`; `lib/intelligence/providers/` ×4 test files |
| Competitor gap | SHIPPED-THIN | `app/api/competitors/gap/route.ts` (real, guarded, DataForSEO-backed); `components/CompetitorGap.tsx`; no dedicated tests |
| Content engine | SHIPPED+TESTED | `app/api/content/{brief,draft,ghost,publish,repurpose,save}` (487 LOC); `lib/content/__tests__` |
| Business Graph | SHIPPED-THIN | `app/api/substrate/` ×28 routes (1649 LOC); `lib/substrate/graph/` (facts, merges, freshness, resolve, rls, types); `app/dashboard/substrate` ×14 pages |
| Campaign object | SHIPPED-THIN | `app/api/substrate/campaigns`; `lib/substrate/campaigns/` (store, types, rls, fragments) |
| Growth Memory | SHIPPED-THIN | `app/api/substrate/memory`; `lib/substrate/memory/` (recall, write, consolidate, embed, scrub, archive-sink, audit, rls, types) |
| Orchestrator / Chief Strategy Agent | SHIPPED+TESTED | `app/api/orchestrator/ask/route.ts` → real `lib/orchestrator/ask.ts`; `lib/orchestrator/` ×3 tests + `executors/`, `killswitch.ts`, `audit.ts` |
| Command bar | SHIPPED+TESTED | `components/command-bar/CommandBar.tsx` (765 LOC, real ⌘K palette) + `__tests__`; `app/api/command/audit` |
| Missions | SHIPPED+TESTED | `app/api/missions/` ×6 routes (316 LOC); `lib/missions/__tests__`; `app/dashboard/missions` |
| Playbooks | SHIPPED+TESTED | `app/api/playbooks/` ×11 routes; `lib/playbooks/__tests__` |
| Fix agent | SHIPPED-THIN | `app/api/cron/fix-agent/route.ts` (real apply-through-pipeline logic); `components/FixAgentManager.tsx`; no tests |
| WordPress integration | SHIPPED-THIN | Real REST connector `lib/connectors/wordpress.ts` (wp-json, app-password auth); `app/api/websites/wordpress/test/route.ts`; publish path under `app/api/websites/[id]`; demo mock is intentional |
| CRM | SHIPPED-THIN | `app/api/crm/` ×11 routes (1162 LOC, leads/pipelines/forms/forecast); `app/dashboard/crm` |
| Mail | SHIPPED-THIN | `app/api/mail/` ×15 routes (1311 LOC); `app/api/mail-nurture/` ×13 routes; `lib/mail` real (no tests) |
| Calls | SHIPPED-THIN | `app/api/calls/` ×14 routes (DNI, bookings, numbers, reminders, webhooks); `lib/calls/` (dni, booking, provider, meter) |
| Ads | SHIPPED-THIN | `app/api/ads/` ×7 routes (campaigns, creatives, settings) |
| Flywheel | SHIPPED-THIN | `app/api/flywheel/` ×42 routes (2652 LOC: ctv, dsp, launch, reallocation, recycling, tests); `components/flywheel/` |
| Reviews | SHIPPED-THIN | Only 2 routes: `app/api/reviews/incoming` + `[id]/draft-response`; `app/dashboard/reviews` — thinnest core module |
| Prospects | SHIPPED-THIN | `app/api/prospects/` ×7 routes (607 LOC) |
| Projects | SHIPPED-THIN | `app/api/projects/` ×9 routes; `app/dashboard/projects` ×34 pages |
| Files | SHIPPED-THIN | `app/api/files/` ×2 routes (297 LOC); `components/FileManager.tsx` |
| Media | SHIPPED-THIN | `app/api/media/` ×34 routes (2636 LOC: buys, dooh, io-briefs, kill-rules, reconciliation…); `app/dashboard/media` ×9 pages |
| Authority | SHIPPED-THIN | `app/api/authority/` ×53 routes (3271 LOC: aeo, listings, outreach, pr, reviews, webhooks); `app/dashboard/authority` ×8 pages |
| Attribution | SHIPPED-THIN | `app/api/attribution/` ×13 routes (touches, bundles, spend, timeline, summary); `THREAT-MODEL-ATTRIBUTION.md` |
| Alerts | SHIPPED-THIN | `app/api/alerts/` + `alert-rules` + `alert-channels`; `components/AlertManager.tsx` |

## Phase 10 — expert constitution, trace dataset, GrowthOS

| Feature | Status | Evidence |
|---|---|---|
| Expert constitution | SHIPPED+TESTED | `EXPERT-CONSTITUTION.md` (repo root); `lib/expert/constitution.ts` + `__tests__/constitution.test.ts`; consumed by `lib/chat/agent.ts` and `lib/orchestrator/executors/planner.ts` |
| Trace dataset | SHIPPED+TESTED (evals) | `training/traces/` 7 × `.jsonl` (measured: `traces-constitution-pilot.jsonl` = 200 lines, `traces-r10-pilot.jsonl` = 300 lines); `training/cards/` 7 pilot cards; `training/evals/`; `TRACE-DATASET-PLAN.md`, `TRAINING-ROADMAP.md`; gen scripts (`gen_r09_pilot.py`, `r10-generator.py`) |
| GrowthOS direction | DIRECTION-DOCUMENTED, partially embodied | Described in `docs/MASTER-PLAN.md` L192–238 and `SPEC-PHASE9.md`; no standalone GrowthOS module — embodied in orchestrator + command bar + substrate |

## Phase 11 — Canvas editor + 7 features + 10 integrations

| Feature | Status | Evidence |
|---|---|---|
| Native Canvas editor (Konva) | SHIPPED+TESTED | `konva ^10.7.0` + `react-konva ^19.3.0` in package.json; `app/dashboard/studio/designs/editor/` (CanvasEditor, DesignCanvas, Toolbar, factory, panels/); `lib/design/` ×24 test files |
| AI generation (design drafts) | SHIPPED+TESTED | `app/api/studio/designs/generate/route.ts` (draft-first LLM, schema-validated, loud 503 no key); `app/api/studio/designs/generate-image/route.ts` (real OpenAI Images BYO call, never fake); `lib/design/__tests__/ai.test.ts` |
| Background removal | SHIPPED+TESTED | `lib/design/background-removal.ts` (real `@imgly/background-removal` WASM/ONNX, client-side, non-destructive) + test |
| (1) Rich text + text-on-path | SHIPPED+TESTED | `lib/design/rich-text.ts` + `rich-text.test.ts`; Konva TextPath usage in `DesignCanvas.tsx` |
| (2) Magic resize | SHIPPED+TESTED | `lib/design/magic-resize.ts` + `magic-resize.test.ts` |
| (3) Charts + QR | SHIPPED+TESTED | `ChartNode.tsx`, `QrNode.tsx`, `lib/design/chart-math.ts`, `qr.ts` + `chart-qr.test.ts` |
| (4) SVG export | SHIPPED+TESTED | `lib/design/export-svg.ts` + `export-svg.test.ts` |
| (5) `{{variable}}` batch | SHIPPED+TESTED | `BatchModal.tsx` (manual/CSV/AI fill) + `lib/design/__tests__/variables.test.ts` |
| (6) Collaboration (share/comments/approvals) | SHIPPED+TESTED | `app/api/studio/designs/[id]/{comments,approval,shares}`; `app/s/[token]/page.tsx` (real token-hash lookup, 404-oracle-safe, server-rendered SVG previews); `ShareModal.tsx`; `sharing.test.ts` |
| (7) Unsplash | SHIPPED+TESTED | `app/api/studio/unsplash/route.ts` + `unsplash.test.ts` (BYO key) |
| Brandfetch | SHIPPED+TESTED | `app/api/studio/brandfetch/{lookup,status}` + `brandfetch.test.ts` |
| Server render API (JSON→PNG) | SHIPPED+TESTED | `app/api/studio/designs/render/route.ts` (tenant-scoped, rate-limited, real renderer) + `render-server.test.ts` |
| Iconify | SHIPPED+TESTED | `lib/design/iconify.ts` (api.iconify.design, license allowlist) + `iconify.test.ts` |
| Fonts registry | SHIPPED-THIN | `lib/design/fonts.ts` (Google Fonts + Fontsource); no fonts test file found |
| Template pack | SHIPPED+TESTED — **count discrepancy** | `lib/design/template-data/pack.json` measured **232** entries (not 242 as briefed); `scripts/generate-template-pack.ts` + `scripts/template-pack/`; `template-pack.test.ts`, `templates.test.ts` |
| Pexels / Pixabay | SHIPPED+TESTED | `app/api/studio/{pexels,pixabay}` + `stock-providers.test.ts` |
| Cloudinary | SHIPPED+TESTED | `app/api/studio/cloudinary` + `cloudinary.test.ts` (signed uploads, BYO) |
| Poly Haven stickers | SHIPPED+TESTED | `app/api/studio/polyhaven` + `polyhaven.test.ts` (pre-rendered PNGs, angle selector) |
| Mockup frames | SHIPPED+TESTED | `lib/design/mockup-frames.ts` + `mockup-frames.test.ts` (20 SVG frames) |
| Palettes / textures | SHIPPED-THIN + **Colormind DISABLED-BY-DESIGN** | `lib/design/textures.ts` (ambientCG CC0, bundled locally); `lib/design/colormind.ts` — implemented but hard `COLORMIND_ENABLED=false`, route returns 503, honest non-commercial-license note. Deliberate fail-closed, not a broken stub. |

## Phase 12 — integrations, personas, embeds

| Feature | Status | Evidence |
|---|---|---|
| Activepieces | SHIPPED+TESTED — **doc overclaim** | `lib/integrations/activepieces/` (client, config, pieces, types) + `__tests__`; **`app/api/integrations/activepieces/` = 6 route.ts** (status, flows×2, runs×2, pieces) — INTEGRATIONS.md says "7 API routes" |
| Listmonk | SHIPPED+TESTED | `lib/integrations/listmonk.ts` + `__tests__/listmonk.test.ts`; `app/api/integrations/listmonk` |
| Postiz | SHIPPED+TESTED | `lib/integrations/postiz.ts` + `__tests__/postiz.test.ts`; `app/api/integrations/postiz` |
| GrapesJS Pages | SHIPPED-THIN | `lib/grapes/` (2 files); `app/dashboard/studio/pages/GrapesEditor.tsx`; `app/api/studio/pages` — no grapes tests |
| Payload CMS | SHIPPED-THIN | `payload.config.ts`; `payload/collections/`; `app/(payload)/admin`, `cms-api` — no payload tests |
| Umami | SHIPPED-THIN | `lib/integrations/umami.ts`; `app/api/analytics/umami`; `components/analytics/UmamiTracker`; `docker/profiles/umami.yml` — no umami tests |
| rrweb replay viewer | SHIPPED-THIN | `components/replay/{ReplayViewer,RrwebRecorder}.tsx`; `lib/integrations/replay.ts`; `app/s/[token]/replay/page.tsx` + `app/api/s/[token]/replay/` — no replay tests |
| Chatwoot | SHIPPED-THIN | `lib/integrations/chatwoot.ts`; `components/chat/ChatwootWidget.tsx` (off-by-default, env-gated) — no chatwoot tests |
| Ghost | SHIPPED-THIN | `lib/integrations/ghost.ts` (Admin API JWT HS256); `app/api/content/ghost` — no ghost tests |
| GrowthBook | SHIPPED-THIN | `lib/integrations/growthbook.ts` + `growthbook-overrides.ts`; `app/api/experiments/flags`; `components/experiments/{GrowthBookProvider,FlagsTable}.tsx` — no growthbook tests |
| Documenso | SHIPPED-THIN | `lib/integrations/documenso.ts`; `app/api/documenso/` — no documenso tests |
| Coolify | DOC-ONLY (as claimed) | `docs/phase12/coolify-white-label.md` — INTEGRATIONS.md explicitly says docs-only; accurate |
| Penpot token bridge | SHIPPED+TESTED | `lib/design/penpot.ts` + `penpot.test.ts` (token import via RPC/file, BETA-flagged honestly); `app/api/studio/penpot` |
| Plane tasks tab | SHIPPED-THIN | `lib/integrations/plane.ts`; `app/api/integrations/plane`; Tasks tab in `app/dashboard/missions/[id]/MissionDetail.tsx` — no plane tests |
| Repurpose pipeline | SHIPPED-THIN | `app/api/content/repurpose/route.ts` — no repurpose tests |
| 5 Agency-Agents personas | SHIPPED+TESTED | `lib/expert/personas/` — confirmed 5 in `index.ts`: `multi-agent-systems-architect`, `workflow-architect`, `studio-producer`, `business-strategist`, `agents-orchestrator` (+ `personas.test.ts`); wired into playbooks/missions/CSA per index.ts wiring map |

---

## CLAIM-ONLY / STUB list (with file refs)

1. **Colormind palette generation — disabled by design** (`lib/design/colormind.ts`, `app/api/studio/colormind/generate/route.ts`): code exists but `COLORMIND_ENABLED=false`; route returns 503 with honest non-commercial-license note. Not a broken stub — a license fail-closed. If docs present it as a working integration anywhere, that's an overclaim.
2. **Template pack count — 242 vs 232**: `lib/design/template-data/pack.json` measured as 232 list entries; task brief and memory claim 232–242. Real either way; the "242" figure has no code evidence.
3. **Activepieces "7 API routes"**: measured 6 `route.ts` under `app/api/integrations/activepieces/` (INTEGRATIONS.md §1a).
4. **No true CLAIM-ONLY features found** — everything else in the task's phase lists has code. **No STUBs** (no TODO'd routes, no `throw not implemented`, no mock-data backends; mock connectors are demo-mode only).

## UNVERIFIED
- Docs' "tsc clean / next build green / preview 200" (§7 INTEGRATIONS.md) — not re-run (research only).
- Whether the 82 test files' ~1,160 cases currently pass (doc says 1130/1132; I counted call sites, not results).
- UI rendering of any page (no browser work per task constraints).
- Depth beyond spot-reads for the biggest THIN modules (authority 53 routes, flywheel 42, media 34) — existence + sampling only.
