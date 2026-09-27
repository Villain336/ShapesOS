# Marketr Totality Audit

**Date:** 2026-09-27 · **Method:** research only — no code changed, built, or committed · **Nothing pushed or published**
**Scope:** the entire Marketr repo at `~/workspace/marketr`, examined phase by phase before the UI/UX pass.
**Workstreams:** 5 parallel inventory agents; scratch reports in `docs/audit/scratch/ws{1..5}-*.md`.
**Honesty rule applied throughout:** verified against code, not docs. Measured counts, not guesses. `UNVERIFIED` where unconfirmed.

---

## 0. The one-page picture

Marketr is a **real, large, working product** — not a prototype. Measured: **634 API routes**, **127 dashboard pages**, **174 components**, **248 Prisma models**, **131 enums**, **82 test files** (~1,160 test call sites), **26 dashboard sections**, **66/66 migrations applied**, zero unresolved imports, zero dead route dirs. The audit found **zero claim-only features and zero fake-success stubs** — everything documented has real code behind it.

It is also, today, **several products wearing one shell**:

- **Two design systems** are fighting: the locked stone/violet house pattern vs a vault token theme (`bg-page`/`text-ink`). 12 of 26 surfaces fully compliant, 12 drifting.
- **Two settings navs** can't see each other; `/dashboard/settings` 404s; two links point at it.
- **11 complete pages** (the whole intelligence tree + nurture + prospects) have zero inbound links — invisible unless you type the URL.
- **"powered by Canva"** is still live copy on the Studio home, and the Canva Connect tab is still a working product surface.
- **10 overlaps** where two+ systems do the same job (two Canva integrations, two social systems, six template systems, four page builders, messaging sprawl).
- **White-label is schema-ready but operationally single-tenant**: workspace switching disabled, white-label fields write-dead (DB-only).
- **No onboarding, no help center, no plans page.** The commercial model is literally "DECISION DEFERRED" in `docs/open-core-options.md`.
- The 5-minute value test **passes but is fragile**: a keyless user can reach real value (mock keyword research → fully working Studio → share link), but the signposts are broken.

The UI/UX pass is not a polish job. It is a **coherence job**: one nav, one design system, one settings, merged duplicates, honest empty states. §6 sequences it.

---

## 1. Feature inventory by phase (code-verified)

Full table: `docs/audit/scratch/ws1-features.md`. Statuses: **SHIPPED+TESTED** (real code + tests), **SHIPPED-THIN** (real code, no/few tests), **STUB**, **CLAIM-ONLY**, **UNVERIFIED**.

### M1–M11 core — all shipped, test coverage uneven

| Feature | Status | Evidence |
|---|---|---|
| Keyword research | SHIPPED+TESTED | `app/api/keywords/` ×5 routes; `components/KeywordResearch.tsx`; provider tests |
| Competitor gap | SHIPPED-THIN | `app/api/competitors/gap/route.ts`; `components/CompetitorGap.tsx` |
| Content engine | SHIPPED+TESTED | `app/api/content/{brief,draft,ghost,publish,repurpose,save}`; `lib/content/__tests__` |
| Business Graph | SHIPPED-THIN | `app/api/substrate/` ×28 routes; `lib/substrate/graph/`; 14 substrate pages |
| Campaign object | SHIPPED-THIN | `app/api/substrate/campaigns`; `lib/substrate/campaigns/` |
| Growth Memory | SHIPPED-THIN | `app/api/substrate/memory`; `lib/substrate/memory/` (pgvector-backed) |
| Orchestrator / Chief Strategy Agent | SHIPPED+TESTED | `lib/orchestrator/` + tests; killswitch, audit, executors |
| Command bar | SHIPPED+TESTED | `components/command-bar/CommandBar.tsx` (765 LOC ⌘K) + tests |
| Missions | SHIPPED+TESTED | `app/api/missions/` ×6; `lib/missions/__tests__` |
| Playbooks | SHIPPED+TESTED | `app/api/playbooks/` ×11; `lib/playbooks/__tests__` |
| Fix agent | SHIPPED-THIN | `app/api/cron/fix-agent/route.ts`; `components/FixAgentManager.tsx` |
| WordPress | SHIPPED-THIN | `lib/connectors/wordpress.ts` (wp-json, app-password auth) |
| CRM | SHIPPED-THIN | `app/api/crm/` ×11 routes (1,162 LOC) |
| Mail | SHIPPED-THIN | `app/api/mail/` ×15 + `app/api/mail-nurture/` ×13 |
| Calls | SHIPPED-THIN | `app/api/calls/` ×14 (DNI, bookings, numbers, webhooks) |
| Ads | SHIPPED-THIN | `app/api/ads/` ×7 |
| Flywheel | SHIPPED-THIN | `app/api/flywheel/` ×42 routes (2,652 LOC) |
| Reviews | SHIPPED-THIN | **Thinnest core module: 2 routes** |
| Prospects | SHIPPED-THIN | `app/api/prospects/` ×7 (607 LOC) |
| Projects | SHIPPED-THIN | `app/api/projects/` ×9; 34 project pages |
| Files | SHIPPED-THIN | `app/api/files/` ×2; `components/FileManager.tsx` |
| Media | SHIPPED-THIN | `app/api/media/` ×34 routes (2,636 LOC) |
| Authority | SHIPPED-THIN | `app/api/authority/` ×53 routes (3,271 LOC — largest domain) |
| Attribution | SHIPPED-THIN | `app/api/attribution/` ×13 |
| Alerts | SHIPPED-THIN | `app/api/alerts/` + rules + channels |

**Coverage pattern:** tests concentrate in `lib/design`, `lib/intelligence/*`, `lib/integrations`, `lib/orchestrator`, `lib/expert`, `lib/playbooks`, `lib/missions`, command-bar. The big M1–M11 operational modules (mail, calls, crm, attribution, authority, media, flywheel, alerts, reviews, prospects, projects, files) carry **zero co-located lib tests** despite being substantial, real code. This is the test-backfill backlog.

### Phase 10 — constitution, traces, GrowthOS

| Feature | Status | Evidence |
|---|---|---|
| Expert constitution | SHIPPED+TESTED | `EXPERT-CONSTITUTION.md` + `lib/expert/constitution.ts` + tests; consumed by chat agent + planner |
| Trace dataset | SHIPPED+TESTED (evals) | `training/traces/` 7×`.jsonl` (200 + 300 line pilots measured); evals; gen scripts |
| GrowthOS direction | Direction-documented, partially embodied | No standalone module — embodied in orchestrator + command bar + substrate |

### Phase 11 — Canvas editor: all verified

Native Konva editor, AI generation (draft-first LLM + OpenAI Images, loud 503s without keys), imgly WASM background removal, and all 7 features (rich text + text-on-path, magic resize, charts + QR, SVG export, `{{variable}}` batch, collaboration with `/s/[token]` public shares, Unsplash) — **SHIPPED+TESTED**. All 10 integrations verified; two notes:

- **Template pack measured 232 entries** in `pack.json`, not 242 as briefed — doc overclaim, real either way.
- **Colormind is deliberately disabled** (`COLORMIND_ENABLED=false`, honest 503 + non-commercial-license note). Fail-closed by design, not a broken stub.

### Phase 12 — integrations: all verified

All 5 deep integrations, 7 embeds, Penpot token bridge, Plane tasks tab, Repurpose pipeline, and all 5 Agency-Agents personas (confirmed in `lib/expert/personas/index.ts` + tests) — verified in code. Two notes:

- **Activepieces has 6 route files, not 7** as INTEGRATIONS.md claims — doc overclaim.
- **Coolify is doc-only**, exactly as INTEGRATIONS.md claims. Accurate.

### Claim-only / stub verdict

**No CLAIM-ONLY features. No fake-success stubs.** Zero `throw new Error("not implemented")`, zero empty-success JSON patterns in `app/api`. All mock/placeholder hits are benign (demo-mode connectors, comments, anti-placeholder prompt text). Deliberate honest stubs: Colormind 503, E2E fixtures (env-gated), labeled "coming soon" in CreativeWizard + AlertManager, mock SEO provider with honest banners. **UNVERIFIED (research-only scope):** current tsc/build/test-pass state, UI rendering.

## 2. Architecture map

Full detail: `docs/audit/scratch/ws2-architecture.md`.

### API route inventory (measured: 634 route.ts, 634 unique paths, zero dead dirs)

Top groups: `studio` 66 · `authority` 53 · `flywheel` 42 · `media` 34 · `substrate` 28 · `websites` 25 · `cron` 25 · `intelligence` 21 · `integrations` 19 · `newsletter` 18 · `mail` 14 · `calls` 13 · `attribution` 12 · `nurture`/`playbooks`/`crm` 11 · `social`/`projects`/`mcp` 9 · …down to single-route groups. 141 intermediate dirs have no `route.ts` but all have descendants with one — no dead dirs. Payload's REST API was deliberately mounted at `/cms-api/*` (not `/api/*`) to avoid shadowing Marketr's own `/api/media`.

### Tenant isolation — 4 layers, DB-verified

1. Session via `requireUser()` (312 routes). 2. RBAC `requireWorkspaceRole`/`requireProjectRole` (91/77; owner>admin>editor>viewer). 3. Per-query `where: {workspaceId}` (46 use `accessibleWorkspaceWhere`). 4. **DB-enforced FORCE RLS** on `graph_*` tables via `withWorkspaceScope()` pinning the `app.workspace_id` GUC — verified live (`rowsecurity=true`); a session without the GUC sees zero rows (fail-closed). Cron/service routes use `CRON_SECRET` Bearer (31). MCP derives `workspaceId` server-side from auth, never from args.

### Agent stack — traced end to end

Constitution (`lib/expert/constitution.ts`, v1, 4 roles, global hard rules prepended to every prompt) → 5 persona seeds (`lib/expert/personas/`, approved wiring map: 2 → Playbooks, 1 → Missions, 2 → Chief Strategy Agent; persona prompts sit *behind* the hard rules) → Chief Strategy Agent (`lib/orchestrator/orchestrator.ts`: routing table, 20-hop circuit breaker, per-mission caps, escalate-by-default) → executors (researcher/planner/drafter/analyst/scheduler) → MCP tools (`lib/mcp/tools.ts`, 10 task-oriented tools incl. Activepieces block) → `lib/integrations/activepieces`.

**Traced:** Mission "Run automation" → `POST /api/missions/:id/automations` → `missionsGuard("editor")` → honest-config check (503 if unconfigured) → preflight (published webhook-trigger flows only, 256KB cap) → async `triggerFlow()` → outcome into the mission's hash-chained event log. Live wiring; the preview exercises only the honest-503 path because `ACTIVEPIECES_URL`/`KEY` are unset.

### Data layer

**248 Prisma models, 131 enums; 66/66 migrations applied** (fully in sync). **pgvector 0.6.2 + pg_trgm 1.6 installed** on the durable DB — `vector(384)` columns on Growth Memory tables (local MiniLM embeddings), hybrid retrieval (tsvector/trgm + pgvector HNSW → fusion → cross-encoder rerank → MMR + recency decay). **No Redis in core app code** — queues are DB-backed (`GraphErQueue`, mission event chain, scheduler tables). Scheduler: DB-backed tick + 25 `CRON_SECRET`-gated `/api/cron/*` routes. **UNVERIFIED:** whether external cron actually fires against the preview.

### Corpus / RAG / Knowledge Brain

Manifest **measured and verified: v9, 339 sources, 5,924 chunks** (updated 2026-09-27T03:13Z). Retrieval: `retrieveExpertContext()` (cosine over chunk embeddings, workspace-agnostic, per-workspace usage logged) → `groundedPrompt()` (constitution first, retrieval after) → agents. **Knowledge Brain (`app/dashboard/intelligence/corpus/brain/`) is wired to live data** via `/api/corpus/graph`.

### Payload CMS

Mounted inside the Next app via `withPayload` — admin at `/admin`, REST/GraphQL at `/cms-api/*`; 4 collections (CMSUsers, Media, Pages, Posts); separate `payload` schema on the same durable PG — **tables verified present**. Caveat: `push: true` schema sync, not migration-managed; needs `PAYLOAD_SECRET` + proper migrations before prod.

### Sidecars

6 compose profiles (Activepieces, Listmonk, Postiz, GrowthBook, Umami + base postgres/redis/minio) — all runnable, all optional, all with honest "not connected" fallbacks. Flags: `:latest` tags on GrowthBook/Activepieces; Payload dev-secret fallback.

---

## 3. Design system state

Full scorecard: `docs/audit/scratch/ws3-design.md`. **Law:** `AGENTS.md` locked pattern — `bg-[#FAFAF7] p-4 md:p-6` shells, `text-xl font-bold tracking-tight text-stone-900` titles, `text-[13px] text-stone-500` subtitles, violet-active sub-tabs, `bg-violet-600` primaries (never teal/green), dense tables with `hover:bg-violet-50/40`, Lucide only. Reference: `app/dashboard/studio/StudioApp.tsx`.

**Compliance: 12 of 26 surfaces fully compliant, 12 drifting, 2 special cases.** The drift is not random — **two coherent design systems are fighting**: the locked stone/violet pattern vs a `components/vault/*` token theme (`bg-page`, `text-ink`, `bg-surface`). Exemplars to copy: `approvals`, `nurture/ui.tsx` (`btnPrimary` constants), `substrate/ui.tsx` (`PageTitle` + `tableShell` + `Chip`), `social/SocialApp.tsx`.

### Punch list (visibility order)

1. **Reports** — worst rule-break: `bg-accent` primary buttons (`components/ReportsManager.tsx:212,318`), template list as cards with **orange** `border-orange-200` selected state (`:218`), zinc palette, no shell.
2. **"powered by Canva" is live** — `components/studio/StudioHero.tsx:31`, the default hero on `/dashboard/studio`. Worse: the **Canva Connect tab is still a live product surface** (`StudioApp.tsx:1169`, connect/status/export flows, `placeholder="Canva design id (DAG…)"`). If the Polotno decision retired Canva Connect, that's dead product, not just copy.
3. **The reference breaks its own law** — emerald "Mark ready" buttons (`StudioApp.tsx:395`, `CreativeWizard.tsx:488`: `bg-emerald-600`). Needs a ruling: recolor or carve out an approve/attest exception.
4. **Projects section = parallel design system** — all `projects/[id]/*` pages on vault tokens; 9 components use `✓ ✗ ✕ ⚠ ★` text glyphs instead of Lucide.
5. **Prospects on slate** (`text-slate-900`, `border-slate-200`) — the only slate surface; missing padding; `text-lg` title.
6. **Settings: 17 subpages**, all `flex flex-col gap-6` with no shell bg/padding; no `/dashboard/settings` root (404s).
7. **Reviews**: `text-[20px] font-semibold` title, `bg-violet-700` primary (one shade off), own centered shell.
8. **Attribution/Calls/CRM**: white-band header variant, no `bg-[#FAFAF7]`; `.crm-table` hover is `#fafaf9` not violet.
9. **Assistant**: token theme + pill tabs — comment cites "design-v2" but pills aren't covered; needs sanction-or-fix ruling.
10. **Alerts**: zinc palette, cards instead of tables, `✓`/`✗` glyphs, no violet anywhere.
11. **Files**: no shell + token theme (tabs are compliant).
12. **Dashboard root**: no shell, `text-ink` title.
13. **Systemic nits**: `text-[13.5px]` tabs in 11 spots (the reference itself uses 13.5px — law vs code needs alignment); `.crm-table` hover; no true emoji anywhere; no dark-mode leftovers on dashboard surfaces.

---

## 4. Gaps, overlaps, redundancies

Full detail: `docs/audit/scratch/ws4-gaps.md`. Severity: **blocks value** / tech-debt / cosmetic.

### Overlaps (10)

1. **Two Canva integrations, both live** — `/api/studio/creatives/canva/*` (enterprise-gated) vs `/api/studio/canva/*` (OAuth). Overlapping `autofill`/`status`/`templates` verbs; two auth models. → MERGE (tech-debt).
2. **Two social publishing systems, both live** — legacy Buffer-queue UI at `/dashboard/projects/[id]/social` vs Postiz sidecar at `/dashboard/social`. Two full UIs, two nav locations, one job. → Consolidate nav or pick a lane (product decision).
3. **Three chat entry points** (+ disabled Chatwoot) — ⌘K command bar, `/dashboard/assistant`, project chat. Boundaries defensible (command vs assistant vs project chat) → KEEP, add one-line purpose hints.
4. **Analytics split** — `/dashboard/analytics` is Umami pageviews only; money metrics (visibility score, attribution) live elsewhere. → Rename "Site analytics" or build one rollup.
5. **Six template systems** — report templates, newsletter templates, programmatic templates, Studio 232-pack, Canva brand templates, GrapesJS seeds. Engines differ legitimately; **no single Templates browser exists**. → Merge discovery.
6. **Four page builders, boundaries in code comments only** — Canvas (design assets), GrapesJS (landing pages/emails), Payload (CMS), Ghost (external publish). → One "Create" menu routing by intent.
7. **Messaging sprawl** — mail workspace, nurture sequences, newsletter builder, project newsletter, SMS/voice provider layer. Nurture Broadcasts tab vs newsletter builder are one job in two UIs. → MERGE (blocks value in a demo).
8. **Visibility-score sprawl** — three "how visible am I" answers in three places. → Merge presentation under the honest-labeling contract.
9. **Prospects ×2** — R6 prospecting workspace vs authority outreach prospects. → Unify the model.
10. **`/api/sites` vs `/api/websites`** naming collision (connections vs builder). → Cosmetic rename.

### Dead routes

**11 orphaned pages, zero inbound links** (blocks value): `/dashboard/nurture`, `/dashboard/prospects`, and 9 `/dashboard/intelligence/*` pages (ai-visibility, community, competitors, corpus, corpus/brain, data-costs, difficulty, radar, rank, repurpose) — the intelligence tree has no parent index either. Complete working features, invisible. → Wire into nav or delete. One orphaned component (`SignOutButton.tsx`, cosmetic).

### Stubs

No fake-success stubs anywhere. Deliberate honest stubs: Colormind 503, E2E fixtures, labeled "coming soon"s, mock SEO provider with banners. **Half-wired:** 9 media-buying routes 503 on a `buyingTablesReady()` guard that looks vestigial (tables exist, migration applied) — UNVERIFIED live; delete the guard or document it.

### Key-gated features (17) — all degrade honestly

The dominant pattern: **API key SET but server URL ABSENT**. Tico is one variable away on: **Cloudinary** (`CLOUDINARY_CLOUD_NAME` missing — key+secret set), **Chatwoot** (token set, no base URL, not enabled — config smell), **Umami/Ghost/Postiz/Activepieces/Listmonk/GrowthBook/Documenso/Plane** (keys set, URLs absent). DataForSEO absent → honest mock mode. Stripe absent → 503 on billing. **Plane is missing from Settings → Providers entirely** — its state is invisible. Unsplash key absent (known).

### Daemon-restart scars

No unresolved imports (0 missing `@/`), migrations 66/66. Vestigial: the `/* PROVIDER: */` marker system has no consumer. GrowthBook file split is intentional (documented).

---

## 5. Product coherence

Full detail: `docs/audit/scratch/ws5-coherence.md`.

### Navigation

5 nav surfaces: sidebar (21+3), mobile (same, good), command bar (6 "Go" + 2 "Do"), project tabs (23), authority/flywheel/settings sub-navs. All sidebar destinations resolve. But:

- **Home has three labels**: sidebar "Projects" vs command bar "Overview" vs page that's actually an attention queue.
- **A nav item literally labeled "Marketr"** (→ `/dashboard/assistant`); command bar calls it "Assistant".
- **`/dashboard/settings` 404s** — linked from command bar ⌥6 AND the dashboard's new-user "Connect data" CTA. Two broken links, one aimed at first-run users.
- **Settings is split-brained**: 16-tab `SettingsNav` island vs 3-item sidebar Settings island (alerts, brand-kits) — 17 pages, no landing, no cross-navigation.
- **The whole `/dashboard/intelligence` tree (10 pages) is nav-orphaned** — notification deep-links only. And `/dashboard/authority/intelligence` is a *different* page. Two "Intelligence" scopes, no cross-links.
- **Duplicate-scope labels**: Studio/Social/Reviews exist top-level AND project-scoped with no scope indication.

### First-run / 5-minute value test: PASS (fragile)

Login → `/dashboard` → "win this week" suggestion stack → create project → keyword research (honest mock) → Studio (fully functional key-free) → public share link. **No onboarding flow exists** (zero matches for onboard/welcome/setup-wizard). Hard walls: OAuth-only-when-configured login, sidecar dead-ends (Postiz/Listmonk/Umami nav items need extra deployments), **root `/` is a stale "Foundation scaffold is live" museum piece**, mock-data guidance says "edit `.env`" (impossible on hosted; providers page is read-only anyway).

### Settings / billing / docs / identity / white-label

- **Settings:** 18 sections exist; billing only as a drawer in Usage; **no plans page**; **no UI sets the white-label workspace fields** (write-dead: schema + public review page read them, nothing writes them).
- **Billing:** Stripe plumbing + credit metering exist, surfaced only in Settings → Usage (spend caps, chargeback CSV). No pricing/plans UI; `docs/open-core-options.md` = "DECISION DEFERRED".
- **Docs/help:** no help center, no docs links in UI, `docs/quickstart.md` unlinked. The assistant chat is the de-facto help.
- **Identity:** "Marketr" nearly everywhere; defects: the "Marketr"-labeled nav item and **"powered by Canva"** on Studio home.
- **White-label:** schema-ready (logo/domain/color fields, brand kits, public review pages read them) but **single-tenant in practice** — workspace switching rendered disabled ("not enabled"), no client-switching UI, white-label fields DB-only.

**One-line verdict:** one product, one shell — but it navigates like several. The golden path works; the signposts don't.

## 6. UI/UX pass scope recommendation

Recommendations only — Tico approves before anything starts. Sequenced so each wave is independently shippable and verifiable. Sizing is relative (S < M < L); no hour estimates — the audit didn't measure implementation cost.

### Decisions Tico must make first (these block the pass)

These are product calls, not design calls. The pass cannot start cleanly without them:

1. **Canva: retire or keep?** The Canva Connect tab + "powered by Canva" copy are still live. If the Polotno decision retired Canva Connect, the whole tab and both API surfaces get deleted (§4.1 merge becomes a deletion). If kept, it needs the house style applied and a real place in the product story.
2. **Emerald "Mark ready": recolor or amend the law?** The reference itself ships `bg-emerald-600` buttons while AGENTS.md says never-green. Either recolor to violet or carve out an approve/attest exception — but the law and the reference must agree before workers touch anything, or drift continues.
3. **Assistant chrome: sanction design-v2 or conform it?** Pill tabs + token theme are either the future chat pattern or drift. Pick one.
4. **Which system wins per surface** — stone/violet everywhere (recommended) with named exceptions, or formalize the vault token theme as a second sanctioned system. The current state (two coherent systems, no ruling) is what produced the drift.
5. **Two social systems, messaging sprawl, prospects ×2, analytics home** — merge-or-keep calls (§4.2, §4.7, §4.9, §4.4). Recommend: one social entry, one messaging home, one prospect model, one analytics home.
6. **Commercial model** — plans/pricing UI and white-label operations UI both depend on the deferred open-core decision. Recommend deferring both UIs until the model is decided.

### Wave A — Emergency coherence (S; do first, no design debate)

Broken things and wrong words. Each is a small diff, all user-visible:

- A1. Create `/dashboard/settings` landing page; unify the two settings navs (single tab strip incl. alerts + brand-kits).
- A2. Fix the two dead links: command-bar ⌥6 and dashboard "Connect data" CTA → real destinations.
- A3. Rename sidebar "Marketr" → "Assistant" (matches command bar).
- A4. Remove "powered by Canva" copy (pending decision 1); fix stale code comments.
- A5. Recolor or exception-rule the emerald "Mark ready" buttons (pending decision 2).
- A6. Replace the stale root `/` landing ("Foundation scaffold…") with a real marketing/login page.
- A7. One label for home: pick "Projects" / "Overview" / attention-queue framing and use it in sidebar, command bar, and page.
- A8. Scope-indicate duplicate labels (Studio/Social/Reviews top-level vs project-scoped) — e.g. project tabs get a "Project" prefix or the sidebar items get descriptions.

### Wave B — Navigation architecture (M)

- B1. **Resolve the 11 orphaned pages**: wire the intelligence tree into nav (new "Intelligence" sidebar section or merge into Authority), link or delete nurture/prospects orphans. Add missing parent indexes (`/dashboard/intelligence`, `/dashboard/settings` covered in A1).
- B2. Disambiguate the two "Intelligence" scopes (merge or rename `/dashboard/authority/intelligence`).
- B3. **One "Create" menu** expressing the four-builder boundary (Canvas = design assets, GrapesJS = pages/emails, Payload = CMS content, Ghost = external publish) — the boundary exists only in code comments today.
- B4. Merge the messaging entry points per decision 5; merge the two Canva surfaces per decision 1.
- B5. One Templates discovery surface across the six template systems (engines stay separate; discovery merges).

### Wave C — Design-system unification (L; the main pass)

Surface-by-surface conversion to the locked pattern, in visibility order. Suggested order: **Reports → Projects section → Settings → Alerts → Files → Prospects → Reviews → attribution/calls/CRM → dashboard root → assistant** (per decision 3). Plus:

- C1. Promote the exemplar primitives into a shared kit: `nurture/ui.tsx` (`btnPrimary`/`btnSecondary`/`btnDanger`), `substrate/ui.tsx` (`PageTitle`, `tableShell`, `Chip`) — give workers one import instead of a law document. This is the structural fix for drift.
- C2. Lucide sweep: replace all `✓ ✗ ✕ ⚠ ★` text glyphs (9 project components + AlertHistory).
- C3. Align the law with the code on `text-[13.5px]` tabs and `.crm-table` hover (`#fafaf9` → `hover:bg-violet-50/40`), or vice versa — one source of truth.
- C4. Finish the three half-configured providers (Cloudinary cloud name, Chatwoot base URL or remove token, sidecar URLs) and add Plane to Settings → Providers so its state is visible.

### Wave D — Product completeness (M; after coherence)

- D1. **Onboarding**: welcome checklist driving the existing "win this week" suggestion stack (the guidance content already exists on `/dashboard`; it needs a first-run frame, not new copy).
- D2. In-UI provider key entry (today: read-only status + `.env` instructions) — required for any hosted/SaaS story.
- D3. Help center / quickstart link in UI (`docs/quickstart.md` exists, unlinked).
- D4. Test backfill for SHIPPED-THIN core modules (mail, calls, crm, attribution, authority, media, flywheel, alerts, reviews, prospects, projects, files) — quality pass, not UI, but the audit's biggest non-UI gap.

### Explicitly deferred

- White-label operations UI (client switching, write-live white-label fields) — blocked on decision 6.
- Billing plans/pricing UI — blocked on decision 6.
- New features of any kind — the audit found no missing load-bearing features, only coherence gaps.
- Knowledge Brain polish — already deferred by Tico ("polish later").
- Knowledge-corpus expansion — parked per Tico ("add more later").

### Suggested approval shape

Tico approves: (a) the 6 decisions, (b) Wave A as a batch (it's all small, safe, and independently verifiable), (c) whether Waves B–D proceed in order or get re-sequenced. Nothing in Waves B–D starts without his sign-off per the standing rule.

---

## Appendix: audit provenance

| Workstream | Scratch report | Agent |
|---|---|---|
| 1. Feature inventory by phase | `docs/audit/scratch/ws1-features.md` | claims-vs-code table, measured totals |
| 2. Architecture map | `docs/audit/scratch/ws2-architecture.md` | 634 routes grouped, RLS verified in DB, agent-stack trace |
| 3. Design system audit | `docs/audit/scratch/ws3-design.md` | 26-surface scorecard, 15-item punch list |
| 4. Gaps / overlaps / redundancies | `docs/audit/scratch/ws4-gaps.md` | 10 overlaps, 11 orphaned pages, 17 key-gated features |
| 5. Product coherence | `docs/audit/scratch/ws5-coherence.md` | nav inventory, golden-path trace, 5-minute value test |

Research only. No code changed, no builds run, nothing committed, nothing pushed or published.
