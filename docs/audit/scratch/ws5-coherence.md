# Marketr Totality Audit — WS5: Product Coherence

**Scope:** research only. All findings verified in code (file paths quoted). Marked UNVERIFIED where inferred, not read.
**Date:** 2026-09-27. Repo: `~/workspace/marketr`.

---

## 1. NAVIGATION INVENTORY

### 1a. Nav surfaces

| Surface | File | Items | Notes |
|---|---|---|---|
| Desktop sidebar (`AppSidebar`) | `components/AppSidebar.tsx` | **21 top-level + 3 settings** | Sticky `w-60`, workspace switcher on top, user menu at bottom |
| Mobile nav (`MobileNav`) | `components/AppSidebar.tsx` | same 21+3 via shared `NavItems` | Consistent with desktop — good |
| Command bar | `components/command-bar/CommandBar.tsx` | **6 "Go" + 2 "Do" + mission templates + "Ask"** | Only 6 of the 24 sidebar items have ⌥1–⌥6 hotkeys |
| Project tabs | `app/dashboard/projects/[id]/page.tsx` | **23 tabs** (grouped SEO / Content / Build / Automate) | Rendered as a tab grid, not sidebar |
| Authority sub-nav | `app/dashboard/authority/layout.tsx` | 7 tabs (Overview, Outreach, Digital PR, Listings, AEO, Reviews, Intelligence) | `SectionNav` bottom-border tabs |
| Flywheel sub-nav | `app/dashboard/flywheel/layout.tsx` | 7 tabs (Overview, Reallocation, Recycling, Test Lab, CTV, DSP, Launch) | `SectionNav` |
| Settings sub-nav | `components/settings/SettingsNav.tsx` | **16 tabs** | `SettingsNav` — but see §1d |

### 1b. Sidebar → route table (verified: every href below has a real `page.tsx`)

| # | Label | Destination | Status |
|---|---|---|---|
| 1 | Projects | `/dashboard` | OK — but see label dispute §1c |
| 2 | Marketr | `/dashboard/assistant` | OK — but see label dispute §1c |
| 3 | CRM | `/dashboard/crm` | OK |
| 4 | Attribution | `/dashboard/attribution` | OK |
| 5 | Reviews | `/dashboard/reviews` | OK |
| 6 | Calls | `/dashboard/calls` | OK |
| 7 | Reports | `/dashboard/reports` | OK |
| 8 | Analytics | `/dashboard/analytics` | OK (Umami-backed, sidecar-walled) |
| 9 | Files | `/dashboard/files` | OK |
| 10 | Alerts | `/dashboard/alerts` | OK |
| 11 | Studio | `/dashboard/studio` | OK |
| 12 | Direct Mail | `/dashboard/mail` | OK (Listmonk sidecar-walled) |
| 13 | Social | `/dashboard/social` | OK (Postiz sidecar-walled) |
| 14 | Media | `/dashboard/media` | OK |
| 15 | Authority | `/dashboard/authority` | OK |
| 16 | Flywheel | `/dashboard/flywheel` | OK |
| 17 | Substrate | `/dashboard/substrate` | OK |
| 18 | Missions | `/dashboard/missions` | OK |
| 19 | Playbooks | `/dashboard/playbooks` | OK |
| 20 | Approvals | `/dashboard/approvals` | OK |
| 21 | — | — | — |
| S1 | Alert rules | `/dashboard/settings/alerts` | OK |
| S2 | Brand kits | `/dashboard/settings/brand-kits` | OK |
| S3 | Members | `/dashboard/settings/members` | OK |

No sidebar item points at a missing route. Duplicate destinations: none (each label → one unique route).

### 1c. Label disagreements between nav surfaces (COHERENCE BUG)

| Route | Sidebar says | Command bar says | Page itself says |
|---|---|---|---|
| `/dashboard` | **"Projects"** (`AppSidebar.tsx:74`) | **"Overview"**, subtitle "Dashboard home" (`CommandBar.tsx:82`) | Page comment: "dashboard home: attention queue, project vitals" (`app/dashboard/page.tsx:1-2`); H1 area renders an attention queue + "win this week" suggestions, plus a project list. It is NOT purely a projects list. |
| `/dashboard/assistant` | **"Marketr"** (`AppSidebar.tsx:75`) | **"Assistant"**, subtitle "AI assistant" (`CommandBar.tsx:86`) | Comment: "global AI assistant… one page for every project, with a project switcher in the top strip" (`app/dashboard/assistant/page.tsx:1-3`). The product's own name is used as a feature label in the sidebar. |
| `/dashboard/settings` | *(not in sidebar)* | **"Settings"**, subtitle "Workspace settings", ⌥6 (`CommandBar.tsx:87`) | **404 — no `page.tsx`, no `layout.tsx`, no redirect** under `app/dashboard/settings/`. The command bar navigates users into a dead end. |

### 1d. Settings is split-brained — there are TWO settings navs that don't know about each other

- `SettingsNav.tsx` (the tab strip rendered inside 16 of the 18 settings pages) lists: Skills, Connectors, Direct Mail, Media safety, Members, Providers, Governance, Automation, Experiments, Signing, Security, Notifications, Defaults, API/MCP, Audit log, Usage.
- The sidebar's "Settings" section lists: **Alert rules** (`/dashboard/settings/alerts`), **Brand kits** (`/dashboard/settings/brand-kits`), Members.
- `alerts/page.tsx` and `brand-kits/page.tsx` do **not** render `SettingsNav` (verified via grep: `grep -L "SettingsNav"` matched exactly these two files), so:
  - From inside Settings (e.g. Providers), you **cannot reach** Alert rules or Brand kits.
  - From Alert rules / Brand kits, you **cannot reach** the other 16 settings pages.
  - There is no `/dashboard/settings` landing page to recover from.
- **17 settings sub-pages exist, 0 are reachable from a single coherent nav.** A user hunting for "where do I set X" has to know which of two islands it's on.

### 1e. Orphan tree: the entire `/dashboard/intelligence` section is unreachable from nav

Pages that exist: `ai-visibility`, `competitors`, `corpus`, `corpus/brain`, `community`, `data-costs`, `difficulty`, `radar`, `rank`, `repurpose` (10 routes, all with `page.tsx`).
- Zero links from the sidebar, zero from the command bar.
- The only inbound links in the whole repo: notification deep-links (`app/api/cron/fleet/route.ts:59` → `/dashboard/intelligence/competitors`, `lib/intelligence/radar/alerts.ts:151` → `/dashboard/intelligence/radar`).
- Note the confusion multiplier: `/dashboard/authority/intelligence` is a *different* page (the "Onboarding Intelligence Report" — twelve audits + 90-day Growth Plan) than the `/dashboard/intelligence/*` tree. Two "Intelligence" scopes with overlapping subject matter and no cross-linking.

### 1f. Same label, two scopes (duplicate-label confusion)

| Label | Top-level | Project-scoped (`/dashboard/projects/[id]/…`) |
|---|---|---|
| Studio | `/dashboard/studio` = Creative Studio home | `projects/[id]/studio` = "Brand assets and domains" |
| Social | `/dashboard/social` = Postiz sidecar publishing workspace | `projects/[id]/social` = "Scheduled posts across channels" |
| Reviews | `/dashboard/reviews` | `authority/reviews` |
| Chat | — | `projects/[id]/chat` = "Ask AI, or message your team" (also `DashboardMain.tsx` full-bleeds on suffix `/chat`) |

The project tab grid (`app/dashboard/projects/[id]/page.tsx:57-92`) is well-built (23 tabs with one-line descriptions), but a user sees "Studio" and "Social" in the sidebar AND inside a project with no indication they are different surfaces.

**Nav verdict:** destinations all resolve, mobile/desktop agree, command-bar/server labels do not agree, settings has two disconnected navs with no landing, the intelligence tree is nav-orphaned, and four labels exist in two scopes.

---

## 2. FIRST-RUN — where a new user lands, and the golden path

### 2a. Landing after login
- `app/login/page.tsx`: on success, `window.location.href = res?.url ?? "/dashboard"` (line ~69). Google OAuth when configured; otherwise the self-hosted `ADMIN_EMAIL`/`ADMIN_PASSWORD` credential form.
- `proxy.ts` only guards `/api/*` (rate limiting) — no page-level middleware redirects. `app/dashboard/layout.tsx` redirects unauthenticated users to `/login` via `requireUser()`.
- **There is no onboarding flow.** Verified: `find app -iname "*onboard*" -o -iname "*welcome*" -o -iname "*setup-wizard*"` returned **zero** matches. No welcome tour, no checklist, no setup wizard component anywhere.

### 2b. What `/dashboard` shows a brand-new user (honestly decent)
`app/dashboard/page.tsx` builds an attention queue + a **"win this week" suggestion stack** that walks a new user through the golden path:
1. No projects → *"Add your first project to unlock keyword research."* → CTA "Add a project" → `#new-project` anchor (ProjectCreateForm).
2. Project, no keywords → *"Run keyword research to find terms worth ranking for."* → `/dashboard/projects/[id]/keywords`.
3. Keywords, no content → *"Turn N saved keywords into content briefs."* → `/dashboard/projects/[id]/content`.
4. No autopilot → *"Put refreshes and fixes on autopilot with supervised runs."*
5. `!provider.isLive` → *"Connect DataForSEO for live search data instead of mock results."* → CTA **"Connect data"** → **`href: "/dashboard/settings"` — which 404s** (`app/dashboard/page.tsx:207`). The one guidance CTA aimed at new users is a broken link.

### 2c. Golden-path trace: keyword research → content → design (no keys)

| Step | What happens without keys | Wall? |
|---|---|---|
| Create project | `ProjectCreateForm` on `/dashboard` — needs a domain. Works. | Minor: domain required, no guidance on what "project" means for an agency vs a single site. |
| Keyword research | Works via **mock provider** (`lib/providers/mock.ts`, `isLive = false`). Honest banner: *"Showing mock data — add DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to .env for live keyword data."* (`components/KeywordResearch.tsx:171-179`). | **Soft wall:** guidance tells the user to edit `.env` — developer-oriented, impossible on a hosted deployment, and no link to Settings → Providers (which would 404 anyway). |
| Content engine | Mock LLM provider exists (`lib/llm/mock.ts`); `llmStatus()` is designed so "the mock banner never misleads" (`lib/llm/index.ts:28-34`). | UNVERIFIED whether brief/draft generation is blocked or mocked without an LLM key — content page wires no visible `llmStatus` banner (`grep` on `app/dashboard/projects/[id]/content/page.tsx` found none). |
| Design (Studio) | Fully functional, key-free (local canvas). Templates, stock via BYO keys optional. Public share links `/s/[token]` work. | **No wall.** This is the strongest 5-minute value. |

### 2d. Hard walls a new user WILL hit
1. **Login wall on hosted:** Google OAuth only "when configured" — otherwise the operator's `ADMIN_EMAIL`/`ADMIN_PASSWORD`. A new self-serve signup flow does not exist in the open-source build (UNVERIFIED for a hosted SaaS wrapper).
2. **Sidecar walls (Phase 12 embeds):** Social needs a self-hosted Postiz sidecar (`lib/integrations/postiz.ts` — "SIDECAR CONTRACT"), Direct Mail needs Listmonk, Analytics needs Umami, plus Chatwoot/Ghost/GrowthBook/Documenso/ActivePieces. These nav items are dead UI without extra deployments.
3. **Root `/` is a stale museum piece:** `app/page.tsx` still reads *"Foundation scaffold is live. Feature build starts in milestone 2 — see SPEC.md."* The product shipped 12+ phases past that. A visitor who lands on `/` before logging in sees a dead landing page.

---

## 3. SETTINGS COVERAGE

Existing (18 sub-pages under `app/dashboard/settings/`): alerts, api-mcp, audit, automation, brand-kits, connectors, defaults, experiments, governance, mail, media, members, notifications, providers, security, signing, skills, usage.

| Need | Present? | Evidence |
|---|---|---|
| Providers/keys | ✅ (read-only status) | `settings/providers/page.tsx` — "statuses are live, key material is never displayed." Keys are set via env, not UI — fine for self-host, a wall for SaaS. |
| Workspace/team | ✅ | `settings/members/page.tsx` (invite flow at `app/invite` exists too) |
| Billing | ⚠️ partial | Only as `BillingSection` + `OverageBillingSection` embedded in **Settings → Usage** (admin-only). **No dedicated Billing/Plans page anywhere.** |
| Brand kit | ✅ | `settings/brand-kits/page.tsx` — logo/colors/fonts/tone for client reports |
| Notifications | ✅ | `settings/notifications/page.tsx` + `settings/alerts/page.tsx` (on the orphaned island) |
| Workspace identity / white-label | ❌ missing UI | Schema has `whiteLabelLogoUrl`, `whiteLabelCustomDomain`, `whiteLabelBrandColor` (`prisma/schema.prisma:488-490`), consumed by the public review page (`app/r/review/[token]/page.tsx`) — but **no settings page sets them** (UNVERIFIED whether an API route does; no UI does). |
| Plans/pricing | ❌ | Nothing in-app. `docs/open-core-options.md` = **"Status: DECISION DEFERRED (undecided)"** — the commercial model is undecided, and there's no UI reflecting any plan. |

---

## 4. BILLING

- **Plumbing exists, UI is a drawer:** `app/api/billing/{topup,webhook,payment-method,status,overage}`, `app/api/cron/overage-invoicing/route.ts`, `lib/metering/{billing.ts,service.ts}`. Surfaced in UI only inside Settings → Usage (`BillingSection`, `OverageBillingSection`).
- **Metering IS user-visible** — `components/settings/UsageDashboard.tsx`: "credit usage this period, by action and by project, with the spend cap and CSV export for client chargeback" (`settings/usage/page.tsx`). The metering model is credit-based with an agency chargeback framing.
- **No pricing page, no plan picker, no plan display in-app.** `docs/commercial-license-terms.md` contains no pricing/plans language (grep for pricing/plans/tier/billing returned nothing). So: the product meters and bills (Stripe), but a user can never see what plan they're on or change it in the UI. For the open-source self-host story this is coherent; for the "$29/$79/$199 hosted tiers" narrative in MEMORY.md, the in-product surface doesn't exist yet.

---

## 5. DOCS / HELP — does the product teach itself?

- **No help center.** No docs links in the sidebar, command bar, or any page chrome I checked. `docs/quickstart.md` exists in the repo but is **not linked from any UI** (grep for "quickstart" across `app/` and `components/` returned zero).
- **No onboarding checklist** (§2a).
- Empty states use the `EmptyState` vault component (icon + title + description + action) — present on key pages.
- The strongest teaching surface is the `/dashboard` "win this week" suggestion stack — but its "Connect data" CTA is the broken link (§2b).
- Mock-data banners are honest but developer-oriented (`.env` instructions in `components/KeywordResearch.tsx`).
- The global AI assistant (`/dashboard/assistant`) is the de-facto help system — first-class, per-project chat. Reasonable, but it's a chat, not guidance.
- **Verdict:** the product does not teach itself. A new user gets the dashboard suggestion stack and then is on their own.

---

## 6. IDENTITY — what is this product called?

| Surface | Name used | File |
|---|---|---|
| Browser tab | "Marketr — marketing & SEO workspace" | `app/layout.tsx:10` |
| Sidebar brand + login | "Marketr" | `components/AppSidebar.tsx`, `app/login/page.tsx` |
| Sidebar nav item → `/dashboard/assistant` | **"Marketr"** (the product name, as a feature label) | `components/AppSidebar.tsx:75` |
| Command bar → same route | "Assistant" | `components/command-bar/CommandBar.tsx:86` |
| Design section | **"Studio"** (nav) / **"Creative Studio"** (page H1) | `AppSidebar.tsx:82`, `components/studio/StudioHero.tsx:18,29` |
| Editor internals | Phase 11 **"Canvas"** (code comments, `useCanvasStore`, `DesignCanvas`) | `app/dashboard/studio/designs/editor/*` — code-only, not user-facing |
| Studio hero subtitle | "…powered by **Canva**." | `components/studio/StudioHero.tsx:31` — **stale and wrong**; Marketr's editor is its own Polotno-style build, not Canva. This is a real attribution error visible to users on the Studio home. |
| Root landing | "Marketr" + dead scaffold copy | `app/page.tsx` — "Foundation scaffold is live. Feature build starts in milestone 2" |

So: the product is "Marketr" almost everywhere; the two live naming defects are (1) a sidebar nav item literally labeled "Marketr" that goes to the AI assistant — confusing and self-referential, and (2) "powered by Canva" on the Studio home. Favicon exists (`app/favicon.ico`); title is consistent.

---

## 7. WHITE-LABEL READINESS (the agency story)

- **Data model:** ready-ish. `Workspace` carries `whiteLabelLogoUrl`, `whiteLabelCustomDomain`, `whiteLabelBrandColor` (`prisma/schema.prisma:488-490`); brand kits (logo/colors/fonts/tone) drive white-label client reports (`settings/brand-kits/page.tsx`, milestone 12); public review pages consume workspace white-label fields (`lib/reviews/engine.ts:361`, `app/r/review/[token]/page.tsx`).
- **UI to manage clients: absent.** The sidebar has a `WorkspaceSwitcher` — but every non-current workspace is rendered `disabled` with the tooltip **"Workspace switching is not enabled"** (`components/AppSidebar.tsx`, `WorkspaceSwitcher`). Client switching is a visible-but-dead control. And the white-label workspace fields are **write-dead**: no settings page and no API route sets `whiteLabelLogoUrl`/`whiteLabelCustomDomain`/`whiteLabelBrandColor` (verified: zero matches under `app/api/` and `app/`+`components/` for writes; only `lib/reviews/engine.ts:361` and `app/r/review/[token]/page.tsx` read them). They can only be populated by direct DB writes.
- **In practice: single-tenant.** One workspace per operator; "clients" = projects inside it + brand kits for reports. There is no agency → client workspace hierarchy in the UI, no per-client login, and the white-label domain/logo/color fields are write-dead (direct-DB-only). The report/PDF/client-review side of white-label is partially built; the operational side is not.

---

## 5-MINUTE VALUE TEST — VERDICT: **PASS (fragile)**

**The pass:** a new user with zero keys can log in (admin creds) → land on `/dashboard` → follow the "win this week" suggestions → create a project → run keyword research on **honestly-labeled mock data** → open Studio → build and share a real design via `/s/[token]`. Studio is fully functional key-free. Value is reachable inside 5 minutes.

**Why it's fragile — the walls a new user hits on the way:**
1. The dashboard's own "Connect data" guidance CTA 404s (`app/dashboard/page.tsx:207` → `/dashboard/settings`), as does the command bar's ⌥6 Settings (`components/command-bar/CommandBar.tsx:87`).
2. Mock-data guidance says "edit `.env`" (`components/KeywordResearch.tsx:175-179`) — impossible on hosted, and there's no in-UI key entry anyway (providers page is read-only).
3. No onboarding, no help center, no quickstart link in UI (`docs/quickstart.md` exists but is unlinked).
4. Four nav items (Social, Direct Mail, Analytics, Experiments-adjacent embeds) are dead without self-hosted sidecars (Postiz, Listmonk, Umami…).
5. Root `/` shows a stale "foundation scaffold" landing page to anyone who arrives before login.

**One-line summary:** Marketr is one product with one shell, but it navigates like several: two settings navs that can't see each other, an orphaned intelligence tree, three labels for the home route, a feature literally named after the product, and a "powered by Canva" byline on the flagship Studio. The golden path works; the signposts don't.
