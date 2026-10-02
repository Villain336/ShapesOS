# WS4 — Gaps, Overlaps, Redundancies (research only)

Workstream 4/5 of the Marketr Totality Audit. Repo: `~/workspace/marketr`. No code changed, nothing built or committed. All findings verified in code unless marked **UNVERIFIED**. Key-presence checks below report SET/ABSENT/EMPTY only — no values.

Severity scale: **blocks value** (user-facing value gated), **tech-debt** (works but costs maintenance), **cosmetic**.

---

## 1. OVERLAPS

### 1.1 Two Canva integrations — both live, both used by UI
- `app/api/studio/creatives/canva/*` — Phase 4 creative-centric surface: `autofill`, `design-link`, `export-pdf`, `status`, `templates` (enterprise-gated, 409 without Canva Enterprise).
- `app/api/studio/canva/*` — newer OAuth surface delegating to `_handlers.ts`: `connect`, `callback`, `disconnect`, `status`, `designs`, `folders`, `export`, `autofill`, `brand-templates`, `brand-defaults`.
- Overlapping verbs: `autofill` ×2, `status` ×2, `templates` vs `brand-templates`.
- UI usage (verified via grep): old surface used by `app/dashboard/studio/StudioApp.tsx` (lines 251–580) and `app/dashboard/studio/CreativeWizard.tsx`; new surface used by `components/StudioStudio.tsx` (used at `app/dashboard/projects/[id]/studio/page.tsx`).
- **Recommendation: MERGE (tech-debt).** Keep the newer `app/api/studio/canva/*` OAuth surface as canonical; port `design-link` and `export-pdf` semantics into it and retire `app/api/studio/creatives/canva/*`. Two auth models (enterprise-gate vs OAuth) for the same vendor is the sharpest edge.

### 1.2 Two social publishing systems — both live
- Legacy internal queue: `app/api/social/*` (`settings`, `channels`, `posts`, plus `[id]` subroutes) + `lib/social/*` (Buffer-port orchestration, milestone 20). UI: `components/SocialStudio.tsx` at `/dashboard/projects/[id]/social`.
- Postiz sidecar: `app/api/integrations/postiz/*` (`status`, `channels`, `posts`, `posts/[id]`) + `lib/integrations/postiz.ts`. UI: `app/dashboard/social/SocialApp.tsx` at `/dashboard/social`.
- **Recommendation: KEEP both only if deliberate (product decision).** They serve different tiers (self-contained queue vs BYO sidecar). But today they are two full UIs in two nav locations doing "schedule social posts" — consolidate the nav to one entry point and make the other the engine underneath, or Tico will demo both and get asked which is real.

### 1.3 Three chat/assistant entry points (+1 disabled)
- Global `CommandBar` (`components/command-bar/CommandBar.tsx`) → `POST /api/orchestrator/ask`.
- `/dashboard/assistant` (nav label "Marketr") → `components/chat/AssistantClient.tsx` (+ team chat tab).
- `/dashboard/projects/[id]/chat` → also `AssistantClient` (project-scoped).
- Chatwoot live-chat widget: wired in `app/dashboard/layout.tsx`, renders nothing unless `CHATWOOT_WIDGET_ENABLED=true` (currently absent → inactive; see §4).
- **Recommendation: KEEP.** Boundaries are real (⌘K command execution vs AI assistant vs project chat vs human live-chat). Only flag: the nav labels "Marketr" (assistant) vs the ⌘K bar overlap in user mental model — a one-line hint in each surface saying what it's for would close it.

### 1.4 Analytics: Umami page vs internal stat surfaces
- `/dashboard/analytics` + `components/analytics/AnalyticsPanel.tsx` + `app/api/analytics/umami/*` — Umami sidecar only; honest empty state without it (verified: page copy says "powered by a self-hosted Umami sidecar" and links to Providers).
- Internal stats exist separately and are NOT on this page: `/api/visibility-score`, `/api/ai-visibility`, `/dashboard/attribution`, `/dashboard/media/attribution`, `/api/attribution/summary`.
- **Recommendation: KEEP with a merge of presentation (tech-debt → blocks value if Tico expects one analytics home).** The "Analytics" nav item only shows cookieless pageviews; the money metrics (visibility score, attribution) live elsewhere. Either rename the nav item "Site analytics" or build one rollup.

### 1.5 Six template systems
1. `app/api/report-templates/*` — PDF report templates (uses `components/block-editor`, `components/TemplateEditor`).
2. `app/api/newsletter/templates/*` — newsletter templates (+ `seed`).
3. `app/api/programmatic/templates/*` — programmatic SEO templates.
4. Studio native template pack — Phase 11c, 232 templates, generator `scripts/generate-template-pack.ts` → `lib/design/template-data/pack.json`, surfaced in `TemplatesPanel.tsx`.
5. Canva brand templates — two endpoints (§1.1): `app/api/studio/canva/brand-templates` and `app/api/studio/creatives/canva/templates`.
6. GrapesJS seed templates — `lib/grapes/templates.ts` (6 landing + 2 email), used by `app/api/studio/pages`.
- **Recommendation: KEEP the engines, MERGE the discovery.** Different domains genuinely need different template kinds, but there is no single "Templates" browser anywhere; a user can't see all six. Tech-debt.

### 1.6 Four page/site builders with blurring boundaries
- Studio Canvas editor (Phase 11 Polotno clone): `app/dashboard/studio/designs/[id]` — design documents, print/social creatives.
- GrapesJS page drafts (Phase 12): `app/dashboard/studio/pages/[id]/GrapesEditor.tsx` + `app/api/studio/pages` — landing pages + emails.
- Payload CMS (Phase 12): `/admin` + `/cms-api/*`, collections Pages/Posts/Media (live in preview DB, 11 tables in `payload` schema — verified).
- Ghost: publish-only target via `app/api/content/ghost` (BYO `GHOST_URL` + admin key).
- **Recommendation: KEEP but draw the boundary in the UI (tech-debt).** Today the mental model is: Canvas = design assets, GrapesJS = landing pages/emails, Payload = CMS content, Ghost = external blog publish. That boundary exists only in code comments; the Studio nav doesn't explain it. One "Create" menu routing to the right builder by intent would fix it.

### 1.7 Messaging sprawl: five surfaces
- `/dashboard/mail` — Direct Mail workspace (`app/api/mail/*`).
- `/dashboard/nurture` — nurture sequences (SMS/email/voice/direct mail) + Broadcasts tab via Listmonk (`app/api/nurture/*`, `app/api/mail-nurture/pieces/*`, `app/api/cron/nurture`).
- `app/api/newsletter/*` — newsletter builder (also Listmonk-backed broadcasts).
- `/dashboard/projects/[id]/newsletter` — project-scoped newsletter (which engine? **UNVERIFIED** — needs a follow-up check on whether it duplicates the workspace newsletter).
- `lib/messaging/*` + `app/api/messaging/*` — SMS/voice provider layer.
- **Recommendation: MERGE (blocks value if Tico demos messaging).** Nurture sequences vs newsletter broadcasts vs direct mail are three UIs over heavily overlapping send infrastructure. At minimum the Broadcasts tab inside nurture and the newsletter builder should be one thing.

### 1.8 Visibility/intelligence score sprawl
- `/api/visibility-score` → `VisibilityScoreWidget` on project home (`app/dashboard/projects/[id]/page.tsx`).
- `/api/ai-visibility` → orphaned `/dashboard/intelligence/ai-visibility` (§2.1).
- `/dashboard/authority/*` — AEO prompt sets, runs, source impact (authority = "don't get sued"-adjacent SEO authority).
- `/dashboard/intelligence/radar`, `/rank`, `/difficulty`, `/competitors` — orphaned pages (§2.1).
- **Recommendation: MERGE presentation (tech-debt).** Three "how visible am I" answers in three places. The ai-visibility page's honest-labeling contract ("estimated range, never score") is good — apply that contract to the merged surface.

### 1.9 Prospects in two places
- `/dashboard/prospects` — R6 prospecting & enrichment workspace (**orphaned**, §2.1).
- `app/api/authority/outreach/prospects` + `/dashboard/authority/outreach` — outreach prospect lists (Instantly/Smartlead webhooks).
- **Recommendation: MERGE (tech-debt).** One prospect object, two homes. The R6 page has waterfall enrichment + CRM conversion; outreach has campaign-scoped prospects. Unify the data model or users will maintain two lists.

### 1.10 `/api/sites` vs `/api/websites` — naming collision
- `app/api/sites/*` = SFTP/site **connection** management (milestone 6).
- `app/api/websites/*` = website **builder** sites (milestone 7: github/sftp/file working copies, audits, fix-runs).
- **Recommendation: cosmetic rename (tech-debt).** `/api/sites` → `/api/site-connections`. No behavior change.

---

## 2. DEAD CODE / ROUTES

Method: grepped nav (`components/AppSidebar.tsx`), all `href=`/router links, and API consumers. 634 `route.ts` files total.

### 2.1 Orphaned pages — full UIs with zero inbound links (severity: blocks value)
| Page | Evidence |
|---|---|
| `/dashboard/nurture` (`NurtureApp`) | Zero references to `/dashboard/nurture` in `app/`, `components/`, `public/` |
| `/dashboard/prospects` (`ProspectsApp`) | Zero references to `/dashboard/prospects` anywhere |
| `/dashboard/intelligence/ai-visibility` | Only cross-links within `intelligence/*` + one cron digest link (`app/api/cron/fleet/route.ts:59` → `/dashboard/intelligence/competitors`) |
| `/dashboard/intelligence/community` | Same — no nav, no inbound links |
| `/dashboard/intelligence/competitors` | Same |
| `/dashboard/intelligence/corpus` (+ `/brain`) | Same (corpus/brain linked only from corpus page itself) |
| `/dashboard/intelligence/data-costs` | Same |
| `/dashboard/intelligence/difficulty` | Same |
| `/dashboard/intelligence/radar` | Same |
| `/dashboard/intelligence/rank` | Same |
| `/dashboard/intelligence/repurpose` | Same |

Additional: `/dashboard/intelligence/` has **no parent `page.tsx`** (no index) — the directory is a link-less archipelago. These are complete, working features (Phase 10 intelligence) invisible to any user who doesn't type the URL. Either wire them into nav/assistant or delete.

### 2.2 Orphaned component
- `components/SignOutButton.tsx` — imported nowhere; `AppSidebar` uses `signOut` from `next-auth/react` directly (`components/AppSidebar.tsx:238`). **Cosmetic.**

### 2.3 Not dead (verified alive, listing to prevent false pruning)
- `components/block-editor/*` — used by `app/dashboard/reports/page.tsx` and `components/TemplateEditor.tsx`.
- `components/crm/*` — used via relative imports by `components/crm/CrmApp.tsx`.
- `components/settings/ConnectorHealthTab.tsx`, `OverageBillingSection.tsx` — used by `ConnectorsManager.tsx`, `BillingSection.tsx`.
- `components/UmamiTracker` — used by `app/s/[token]/page.tsx` (public share tracking).
- `app/api/e2e/*` (mock-oauth, skill-fixture) — gated by `E2E_MOCK_OAUTH=1`, 404 otherwise. Intentional test fixtures, not dead.
- Zero missing `@/` imports across `app/`, `lib/`, `components/` (programmatic check: 0 unresolved). No import-level daemon scars.
- Migrations: 66/66 applied in preview DB (`_prisma_migrations` matches `prisma/migrations/`, only diff is `migration_lock.toml` which is not a migration). **Zero pending.**

---

## 3. STUBS

### 3.1 Deliberate, honest stubs (keep)
- **Colormind**: `POST /api/studio/colormind/generate` → 503 `colormind_disabled` (non-commercial license; code comment documents the kill-switch and the re-enable delta). UI shows honest no-key state. **Tech-debt only if a commercial agreement ever lands.**
- **E2E fixtures** (§2.3). **"Coming soon"** in `CreativeWizard.tsx:262` (email/social channel templates disabled in v1 — labeled, not fake) and `AlertManager.tsx:325` (non-live triggers labeled "(coming soon)"). Both honest.
- **Mock SEO provider** (`lib/providers/mock.ts`): active because `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD` are absent; every consumer checked shows an explicit "mock data" banner (e.g. `components/KeywordResearch.tsx:175`, per-idea `mock` badges at line 299). **Honest.**

### 3.2 Half-wired: media buying 503s (severity: tech-debt, UNVERIFIED live)
Nine routes return 503 `"Phase 5 buying tables are not yet migrated."` when `buyingTablesReady()` is false (`lib/media/buying-store.ts:29` — probes `SELECT 1 FROM dooh_plans LIMIT 1`):
- `app/api/media/audio/briefs/route.ts`, `app/api/media/audio/briefs/[id]/pdf/route.ts`
- `app/api/media/dooh/plans/route.ts`, `app/api/media/dooh/plans/[id]/launch-packet/route.ts`, `app/api/media/dooh/plans/[id]/launch-packet/[packetId]/pdf/route.ts`
- `app/api/media/io-briefs/route.ts`, `app/api/media/io-briefs/[id]/route.ts`, `app/api/media/io-briefs/[id]/pdf/route.ts`
- `app/api/media/receipts/route.ts`
- The tables (`dooh_plans`, `io_briefs`, `media_receipts`) **do exist** in the preview DB and migration `20260925044907_phase5_media_buying` is applied — so the guard likely passes in preview and is vestigial. **UNVERIFIED**: could not exercise with auth; on a fresh `migrate deploy` the guard should also pass. Recommend either deleting the guard or documenting why it stays.

### 3.3 No fake-success stubs found
- Grep for `return Response.json({})` / `([])` empty-success patterns in `app/api`: zero hits.
- Grep for 501/`not implemented` in `app/api`: only the unreachable Colormind 501 branch (§3.1).
- Seed scripts (`scripts/seed-demo-*.mts`) are explicitly labeled for preview/screenshots and write only to the DB they're pointed at. Not user-facing fakery.

---

## 4. KEY-GATED FEATURES

Source of truth for status: `app/dashboard/settings/providers/page.tsx` (admin-only, read-only, live). Env presence checked against preview `.env` (presence only). Degradation behavior verified in code.

| Feature | Env vars (code) | Preview state | Degrades honestly? |
|---|---|---|---|
| SEO data (DataForSEO) | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` (`lib/providers/index.ts`) | ABSENT | **Yes** — `MockSeoProvider`, "mock data" banners everywhere |
| LLM (router: copy/bulk/background) | `LLM_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY` (`lib/llm/router.ts`) | SET | Yes — `mockMode` banner in assistant when none live |
| Unsplash stock | `UNSPLASH_ACCESS_KEY` | ABSENT | **Yes** — needs Tico's key per Phase 11b notes; panel shows no-key state (markers present in `StockPhotosPanel.tsx`) |
| Pexels | `PEXELS_API_KEY` | SET | n/a (configured) |
| Pixabay | `PIXABAY_API_KEY` | SET | n/a |
| Brandfetch | `BRANDFETCH_API_KEY` | SET | n/a |
| Cloudinary signed uploads | `CLOUDINARY_CLOUD_NAME` + `CLOUDINARY_API_KEY` + `CLOUDINARY_API_SECRET` (`lib/design/cloudinary.ts:66`) | **HALF** — key+secret SET, **cloud name ABSENT** → `configured=false` | Yes (reports not-configured), but Tico should know it's one var away |
| Colormind palette | none (license kill-switch) | deliberately disabled | **Yes** — 503 + honest UI (§3.1) |
| Umami analytics | `UMAMI_URL` + `UMAMI_API_KEY` (stats); `UMAMI_WEBSITE_ID` + `UMAMI_SCRIPT_URL` (snippet) | URL/website/script ABSENT (API key SET) | **Yes** — `/dashboard/analytics` renders honest empty state + compose-profile quickstart |
| Chatwoot widget | `CHATWOOT_BASE_URL` + `CHATWOOT_WEBSITE_TOKEN` + `CHATWOOT_WIDGET_ENABLED=true` | **HALF** — token SET, base URL ABSENT, enabled-flag ABSENT → inactive | Yes (renders nothing), but a token with no base URL is a config smell — either finish or remove the token |
| Ghost publishing | `GHOST_URL` + `GHOST_ADMIN_API_KEY` | URL ABSENT (key SET) | **Yes** — honest disabled state, "never fake publishing" (`lib/integrations/ghost.ts`) |
| GrowthBook | `GROWTHBOOK_API_HOST` + `GROWTHBOOK_API_KEY` + `GROWTHBOOK_CLIENT_KEY` | host+client key ABSENT (API key SET) | **Yes** — SDK falls back to built-in flag defaults; overrides UI (`20260927195519_phase12_flag_overrides`) still works locally |
| Documenso signing | `DOCUMENSO_URL` + `DOCUMENSO_API_KEY` | URL ABSENT (key SET) | **Yes** — API-only; no embedded UI by license design |
| Listmonk broadcasts | `LISTMONK_URL` + `LISTMONK_USER` + `LISTMONK_TOKEN` | URL+user ABSENT (token SET) | **Yes** — `ListmonkConfigError`, nurture Broadcasts tab degrades |
| Postiz social | `POSTIZ_URL` + `POSTIZ_API_KEY` | URL ABSENT (key SET) | **Yes** — SocialApp reads `/api/integrations/postiz/status`, "not connected" state |
| Activepieces automation | `ACTIVEPIECES_URL` + `ACTIVEPIECES_API_KEY` (+`_API_PREFIX`) | URL ABSENT (key SET) | **Yes** — honest "not connected" |
| Plane projects | `PLANE_BASE_URL` + `PLANE_API_KEY` + `PLANE_WORKSPACE_SLUG` | base+slug ABSENT (key SET) | **UNVERIFIED UI** — API throws `PlaneConfigError`; **Plane is missing from Settings → Providers entirely** (§6.2) so Tico can't see its state |
| Porkbun domains | BYO per-workspace, encrypted in DB (`lib/studio/service.ts:520`) | n/a (UI-gated) | **Yes** — 400 "add them in studio domain settings first" |
| Stripe billing | `STRIPE_SECRET_KEY` | ABSENT | **Yes** — `BillingNotConfiguredError` → 503 on topup/payment-method |
| Resend e
...[truncated 5261 chars]