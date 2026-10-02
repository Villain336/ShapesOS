# WS3 — Design System Consistency Audit (research only, no fixes)

**Repo:** `~/workspace/marketr` · **Date:** 2026-09-27 · **Auditor:** Z7 (subagent)
**Law:** `AGENTS.md` — the locked UI house pattern, reference `app/dashboard/studio/StudioApp.tsx`:
- shell `bg-[#FAFAF7] p-4 md:p-6` · title `text-xl font-bold tracking-tight text-stone-900` · subtitle `text-[13px] text-stone-500`
- sub-tabs: Lucide icon + label, ACTIVE = `border-violet-600 text-violet-700` (never plain-text dark-underline)
- primary buttons `bg-violet-600 hover:bg-violet-700` (NEVER teal/green)
- data lists = DENSE TABLES, badge columns, rows `hover:bg-violet-50/40` (not cards)
- filter toolbar = dropdowns + search + violet button · info notes `border-stone-200 bg-stone-50`
- Lucide icons only, no emoji UI

Method: every `app/dashboard/*/page.tsx` (26 sections: the 24 named + `layout` chrome + dashboard root `page.tsx`) plus each surface's main client component (`*App.tsx`, `/components/*`), audited class-by-class with line-level quotes. Subpages of media/authority/flywheel/intelligence/settings/projects/substrate spot-checked.

---

## (a) Per-surface scorecard

Legend: ✓ compliant · ~ minor/intentional deviation · ✗ drift. "n/a" = element doesn't exist on that surface (neutral).

| Surface | Shell OK? | Title/sub OK? | Tabs OK? | Buttons OK? | Lists OK? | Icons OK? | Notes |
|---|---|---|---|---|---|---|---|
| alerts | ✗ | ✗ | n/a | ✗ | ✗ | ⚠ | zinc palette; cards not tables; `✓`/`✗` text glyphs |
| analytics | ✓ | ✓ | ~ | ✓ | ✓ | ✓ | shell lacks `h-full` only; metric stat-cards are fine |
| approvals | ✓ | ✓ | n/a | ✓ | ✓ | ✓ | exemplary: row hover `hover:bg-violet-50/40`, violet Approve btn |
| assistant | ✗ | n/a | ✗ | ✗ | n/a | ✓ | whole surface uses `bg-surface`/`text-ink` token theme; pill tabs, no violet buttons |
| attribution | ✗ | ✓ | ✓ | ~ | ~ | ✓ | no `bg-[#FAFAF7]`; white-band header; tables use `.crm-table` (hover `#fafaf9`, not violet) |
| authority | ✓ | ✓ | n/a | ✓ | ~ | ✓ | root is a card-grid hub page (intentional); subpages compliant |
| calls | ✗ | ✓ | ✓ | ✓ | ~ | ✓ | same white-band header as attribution; tables via `.crm-table` |
| crm | ~ | ~ | ✓ | ✓ | ✓ | ✓ | `bg-[#FAFAF7]` present but **no padding**; white-band header; tabs violet via CSS var (`--crm-accent: #7c3aed`); `.crm-table` hover not violet |
| files | ✗ | ✗ | ✓ | ~ | ✗ | ✓ | page + FileManager both no-shell; `text-ink` header; cards use `border-line bg-surface` token theme |
| flywheel | ✓ | ✓ | n/a | ✓ | ~ | ✓ | root is a hub of track cards (intentional); 3 subpages spot-checked ✓ |
| intelligence | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 7/9 subpages ✓ — but **root `/dashboard/intelligence` has no `page.tsx`** (verify 404) |
| mail | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | fully compliant incl. `MailApp` (`btnPrimary` = `bg-violet-600`) |
| media | ✓ | ✓ | n/a | ~ | ~ | ✓ | sections are `rounded-xl` cards containing tables (hub sections, defensible); `EmergencyStopButton` red-themed (correct) |
| missions | ✓ | ✓ | ✓ | ✓ | ~ | ✓ | template picker is a card grid (line 242) — pickers are OK as cards |
| nurture | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `ui.tsx` exports locked `btnPrimary` = `bg-violet-600` — model citizen |
| playbooks | ~ | ✓ | n/a | ✓ | ✓ | ✓ | shell `bg-[#FAFAF7] p-4 md:p-6` but missing `flex h-full` (nit) |
| projects | ✗ | ✗ | ✗ | ✗ | ✗ | ⚠ | **entire section runs a parallel design system** (`components/vault/*`: `bg-page`, `text-ink`, vault Card/buttonVariants); `✓ ✗ ✕ ⚠ ★` text glyphs in 9 components |
| prospects | ✗ | ✗ | n/a | ✓ | ~ | ✓ | **slate palette, not stone** (`text-slate-900`, `border-slate-200`); `h-full bg-[#FAFAF7]` with **no padding**; detail `<h1 className="text-lg font-bold tracking-tight">` (no stone-900) |
| reports | ✗ | ✗ | n/a | ✗ | ✗ | ✓ | **`bg-accent` primary buttons (not violet)**; template list = card buttons, selected = `border-orange-200`; zinc palette; no shell |
| reviews | ~ | ✗ | ✓ | ✗ | ~ | ✓ | shell `mx-auto max-w-6xl space-y-4 px-4 py-6`; title `text-[20px] font-semibold`; **`btnPrimary` = `bg-violet-700`/`hover:bg-violet-800`** (one shade off); sections are cards + tables mixed |
| settings | ✗ | ✓ | ~ | ~ | ~ | ✓ | **all 17 subpages**: shell `flex flex-col gap-6` — no `bg-[#FAFAF7]`, no padding; root `/dashboard/settings` has no `page.tsx` (verify 404); one `border-zinc-200 bg-white/60` card |
| social | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | fully compliant |
| studio | ✓ | ✓ | ✓ | ~ | ✓ | ✓ | **reference** — with exceptions (see punch list #2, #3) |
| substrate | ✓ | ✓ | ✓ | ~ | ✓ | ✓ | exemplary shared system: `ui.tsx` `PageTitle` + `tableShell` + `Chip`; layout shell compliant |
| layout (chrome) | ~ | — | — | — | — | ✓ | chrome itself is token-themed (`min-h-screen bg-page text-ink`); `MobileNav` present |
| dashboard root | ✗ | ✗ | — | — | ~ | ✓ | shell `flex flex-col gap-6` no `bg-[#FAFAF7]`; title `text-ink`, subtitle `text-ink-2` |

---

## (b) Punch list — ordered by visibility

**P1. Reports: non-violet primary buttons + orange selection state (the most visible rule-break)**
- `components/ReportsManager.tsx:212` — `className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"` ("New template") and again at `:318`. The house pattern demands `bg-violet-600 hover:bg-violet-700`; `bg-accent` is a custom token, a different hue family.
- `components/ReportsManager.tsx:218` — template list renders as card buttons with selected state `border-orange-200 bg-white` — orange + cards, two violations in one line. Pattern: dense tables, violet.
- `components/ReportsManager.tsx:206` — root shell `<div className="grid gap-6 lg:grid-cols-[280px_1fr]">`: no `bg-[#FAFAF7]`, no `p-4 md:p-6`.
- `app/dashboard/reports/page.tsx` — wrapper `<div className="flex flex-col gap-6">`, title `<h1 className="text-xl font-bold tracking-tight text-ink">` (`text-ink`, not `text-stone-900`), subtitle `mt-1 text-sm text-zinc-500` (not `text-[13px] text-stone-500`).

**P2. "powered by Canva" is still live user-facing copy in Studio (stale per Phase 11/12 Polotno decision)**
- `components/studio/StudioHero.tsx:31` — `<p className="mt-0.5 text-[13px] text-stone-500">The central home for all creative and design work across Marketr — powered by Canva.` — rendered by `app/dashboard/studio/page.tsx:25` in the **default** (flag-off) hero. This is the first thing a user reads on the reference page itself.
- Stale but code-visible (not user-facing): `StudioApp.tsx:3` comment "powered by Canva", `app/dashboard/studio/page.tsx:1-2` comment, `app/dashboard/projects/[id]/studio/page.tsx:1` comment, `components/StudioStudio.tsx:554` "Canva connected".
- The "Canva connection" tab is still a live tab: `StudioApp.tsx:1169` `{ id: "canva", label: "Canva connection", icon: Plug }`, with working `CanvaTab` (`:520-657`: "Connect Canva", `placeholder="Canva design id (DAG…)"`, "Not connected — connect Canva to export PDF files into creatives."). If the Polotno decision retired Canva Connect, this whole tab is dead product surface, not just copy.

**P3. The reference itself breaks the never-green rule — "Mark ready" buttons**
- `app/dashboard/studio/StudioApp.tsx:395` — `className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40"` ("Mark ready", with `<CheckCircle2 size={14} />`).
- Duplicated in `app/dashboard/studio/CreativeWizard.tsx:488` (same class string, same "Mark ready" action).
- AGENTS.md says primary buttons are NEVER teal/green. If the reference ships an emerald solid primary-style button, no worker will honor the rule. Decision needed: either recolor to violet or amend the law to carve out approve/attest actions.

**P4. Projects section = a parallel design system (`components/vault`)**
- All `app/dashboard/projects/[id]/*` pages: shells like `<div className="flex flex-col gap-6">` (no `bg-[#FAFAF7]`), titles `text-xl font-bold tracking-tight text-ink` (e.g. `projects/[id]/keywords/page.tsx`), importing `Card, CardBody, CardHeader`, `EmptyState`, `Stat`, `ValuePill`, `buttonVariants` from `@/components/vault/*`. The dashboard chrome itself (`app/dashboard/layout.tsx`) is `min-h-screen bg-page text-ink` — so the whole SEO-workbench subtree speaks tokens, not the house pattern.
- Text-glyph "icons" instead of Lucide in 9 components: `✓`/`✗`/`✕`/`⚠`/`★` found in `RankingsDashboard`, `SiteIde`, `SitesManager`, `ContentBrowser`, `HostingManager`, `DecayActions`, `LocalSeoTabs`, `ProgrammaticStudio`, `FixAgentManager` (e.g. `RankingsDashboard` uses `✓` for rank wins). House rule: Lucide only.

**P5. Text-glyph status icons in alerts too**
- `components/AlertHistory.tsx:151` — `{r.ok ? "✓" : "✗"} {r.name}`. Same Lucide-only violation (should be `Check`/`X` icons).

**P6. Alerts: zinc palette, cards-instead-of-tables, no shell**
- `app/dashboard/alerts/page.tsx` — wrapper `<div className="flex flex-col gap-6">` (no `bg-[#FAFAF7]`/padding); `<h1 className="text-xl font-bold tracking-tight text-ink">Alert history</h1>`; `<p className="mt-1 text-sm text-zinc-500">`.
- `components/AlertHistory.tsx` — events render as cards `<div key={e.id} className="rounded-lg border border-zinc-200 bg-white/50 p-4">` (pattern: dense tables); only button is `btnGhost = "rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 hover:border-zinc-400 disabled:opacity-50"` (line 45-46) — no violet primary anywhere.

**P7. Prospects: slate instead of stone + missing padding + off-size title**
- `app/dashboard/prospects/ProspectsApp.tsx:349` — root `<div className="flex h-full min-h-[600px] text-slate-900">`; sidebar `border-slate-200`; research text `text-slate-700` (lines 642, 648, 656, 662) — the only surface on the slate scale.
- `app/dashboard/prospects/page.tsx` — `<div className="h-full bg-[#FAFAF7]">` — bg present, `p-4 md:p-6` missing.
- `ProspectsApp.tsx:417` — `<h1 className="text-lg font-bold tracking-tight">` (text-lg, no `text-stone-900`); tables at `text-xs` (line 482: `<table className="w-full text-left text-xs">`) vs the 13px dense-table norm.
- Buttons are violet and correct (`bg-violet-600 … hover:bg-violet-700`, lines 356/464/565/582/593/613) — buttons are the one compliant axis here.

**P8. Reviews: off-by-one title size, off-by-one button shade, own shell**
- `components/reviews/ReviewsApp.tsx:37` — `btnPrimary = "inline-flex items-center gap-1.5 rounded-lg bg-violet-700 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-violet-800 disabled:opacity-60"` — violet-**700**/800 instead of 600/700.
- `components/reviews/ReviewsApp.tsx:691` — root `<div className="mx-auto max-w-6xl space-y-4 px-4 py-6">`; header `<h1 className="text-[20px] font-semibold tracking-tight text-stone-900">Reviews</h1>` — 20px semibold, not `text-xl font-bold`.
- Sections use `cardCls = "rounded-xl border border-stone-200 bg-white p-4"` (line 33) with tables inside — cards as the section container, same defensible-but-off pattern as media.

**P9. Settings: 17 subpages with no shell bg/padding; no root page**
- Every `app/dashboard/settings/*/page.tsx` sampled (providers, audit, brand-kits, connectors) opens `<div className="flex flex-col gap-6">` — no `bg-[#FAFAF7]`, no `p-4 md:p-6`. Titles/subtitles are compliant (`text-xl font-bold tracking-tight text-stone-900` / `mt-0.5 text-[13px] text-stone-500`).
- `app/dashboard/settings/providers/page.tsx` has a `rounded-xl border border-zinc-200 bg-white/60 p-5` card (zinc-200, not stone-200).
- No `app/dashboard/settings/page.tsx` exists — `/dashboard/settings` has no route (verify whether it 404s or is intentionally unreachable).

**P10. Files: dual no-shell + token theme**
- `app/dashboard/files/page.tsx` — `<div className="flex flex-col gap-6">` (no shell), `<h1 className="text-xl font-bold tracking-tight text-ink">Files</h1>`, `<p className="mt-1 text-sm text-ink-2">`.
- `components/FileManager.tsx` — root `<div className="flex flex-col gap-4">` (no `bg-[#FAFAF7]`); file surfaces are `rounded-xl border border-line bg-surface` (lines 229/273/416/435) — token theme, not stone. Root tabs ARE compliant (`border-violet-600 text-violet-700` active, lines 194-196, 210-212).

**P11. Attribution / Calls / CRM: the white-band header variant**
- `components/attribution/AttributionApp.tsx:189` root `<div className="flex h-full flex-col overflow-hidden">`; header `<div className="border-b border-stone-200 bg-white px-5 pb-0 pt-4">` (:191) — a full-width white band, not the `bg-[#FAFAF7]` page. Tabs compliant (`border-violet-600 text-violet-700`, :224-226). Tables use `.crm-table` whose CSS (`components/crm/crm.css:74`) is `tbody tr:hover { background: #fafaf9; }` — stone-50, not `hover:bg-violet-50/40`.
- `components/calls/CallsApp.tsx:86-91` — identical white-band pattern; tabs compliant (:99-100). Emerald hits are badges only (`bg-emerald-50 text-emerald-700`, :77) — fine.
- `components/crm/CrmApp.tsx:160-162` — page wrapper `app/dashboard/crm/page.tsx` is `<div className="h-full bg-[#FAFAF7]">` (**padding missing**); CrmApp root `<div className="crm flex h-full flex-col">` + white-band header. Tabs resolve violet via CSS var (`--crm-accent: #7c3aed` = violet-600, `crm.css:7`) — compliant in spirit. Table headers are `11px uppercase` (`crm.css:64`) and row hover `#fafaf9` (`crm.css:74`) — two small deviations from the dense-table pattern.

**P12. Assistant: token theme + pill tabs (possibly intentional design-v2 — needs a ruling)**
- `app/dashboard/assistant/page.tsx` — wrapper `<div className="h-full">` only.
- `components/chat/AssistantClient.tsx:74` — root `<div className="flex h-full min-h-0 flex-col">`; top strip `border-line bg-surface` (:76); tabs are **pills**: `rounded-full … active ? "bg-surface font-medium text-ink shadow-hairline" : "text-ink-2 hover:text-ink"` (:127-131) — not the `border-b-2 border-violet-600` tab law. No `bg-violet-600` anywhere in the file; no send-button violet (composer is token-styled). Page comment says "no page header per design-v2" — the headerless layout is sanctioned, but the pill tabs + token palette are not covered by that note. Flag for Tico: sanction the assistant's distinct chat chrome, or bring it into the house.

**P13. Dashboard root page (the home)**
- `app/dashboard/page.tsx:216` — `<div className="flex flex-col gap-6">` (no `bg-[#FAFAF7]`, no padding); `<h1 className="text-xl font-bold tracking-tight text-ink">` (:220); subtitle `text-[13px] text-ink-2` (:222).

**P14. Minor systemic nits (batch-fix candidates)**
- `text-[13.5px]` tabs instead of `text-[13px]` in 11 spots: StudioApp (:978, :1181), MailApp (:826), MissionsApp (:206), NurtureApp (:182), SocialApp (:166), FileManager (:194, :210), substrate/tabs.tsx (:56). The locked pattern only pins the active color, but the reference itself uses 13.5px — align the law or the code, one of them.
- `.crm-table` hover is `#fafaf9` (stone-50) in `components/crm/crm.css:74` — used by attribution + calls tables.
- `text-2xl` big numbers in `AnalyticsPanel.tsx:191` are metric values, not titles — fine, no action.
- Emerald/teal/green as **status badges** (`bg-emerald-50 text-emerald-700`) are widespread and fine; only solid-button usage is a violation (P1, P3). `EddmApp.tsx:1158` `bg-emerald-500` is a wizard timeline "done" dot — fine.
- `StudioHero` compact-flag variant uses `text-lg` title (line 13-15) — minor.

**P15. Missing routes to verify**
- No `app/dashboard/intelligence/page.tsx` (9 subpages exist: ai-visibility, community, competitors, corpus, data-costs, difficulty, radar, rank, repurpose).
- No `app/dashboard/settings/page.tsx` (17 subpages).
- Both may be intentional (deep-link-only), but confirm neither 404s from nav.

---

## (c) Compliance counts

**Fully compliant: 12** — analytics, approvals, flywheel, intelligence (subpages), mail, media, missions, nurture, playbooks, social, studio (reference, minus P2/P3), substrate.
**Drifting: 12** — alerts, assistant, attribution, authority (root cards), calls, crm, files, projects, prospects, reports, reviews, settings.
**Special cases: 2** — dashboard root page (drifts), dashboard layout chrome (token-themed shell; pages are expected to paint their own `bg-[#FAFAF7]`).

Fully-compliant exemplars to copy: `approvals` (table + `hover:bg-violet-50/40` + violet Approve), `nurture/ui.tsx` (`btnPrimary`/`btnSecondary`/`btnDanger` constants), `substrate/ui.tsx` (`PageTitle` + `tableShell` + `Chip` shared system), `social/SocialApp.tsx`.

---

## (d) "powered by Canva" — answer

**Yes.** Live user-facing: `components/studio/StudioHero.tsx:31` — "The central home for all creative and design work across Marketr — powered by Canva." Rendered by default (flag off) on `/dashboard/studio`. Beyond copy, the **Canva Connect product surface is still live**: "Canva connection" tab (`StudioApp.tsx:1169`), `CanvaTab` with connect/status/export flows (`:520-657`), "Export from Canva" / "Canva link" buttons (`:330/:333`), `placeholder="Canva design id (DAG…)"` (`:342`). Stale comments also remain (`StudioApp.tsx:3`, `studio/page.tsx:1-2`, `projects/[id]/studio/page.tsx:1`, `components/StudioStudio.tsx:554` "Canva connected").

## (e) Mobile-specific views

No dedicated mobile pages. Mobile accommodations found:
- `app/dashboard/layout.tsx:54` — `<MobileNav>` (responsive nav shell).
- `components/chat/AssistantClient.tsx:141-151` — mobile thread toggle (`md:hidden`).
- `app/dashboard/approvals/page.tsx:3,15` — "mobile-usable Approve/Deny buttons" (`h-11 min-w-[88px]`, `ApprovalsInbox.tsx:224`).
- `app/dashboard/media/attribution/page.tsx:258-259` — "mobile" is data text (device-split label), not a view.

## (f) Honesty notes / caveats

- All class strings above were copied verbatim from the code (file + line). Tab/badge-only color hits (`bg-emerald-50`, `bg-emerald-500` timeline dots, emerald `Check` icons) were checked in context and are status indicators, not primary buttons — not violations.
- The `text-ink`/`bg-page`/`bg-surface`/`border-line` token theme (`components/vault/*`, assistant, FileManager, dashboard chrome) is a coherent second design system, not random drift — the punch list treats "which system wins per surface" as the decision, not just recoloring.
- `hover:bg-violet-50/40` appears 127× across `app/dashboard` + `components` — the row-hover law is mostly honored where tables exist.
- `dark:` variants exist only inside `components/vault/shadcn/*` primitives — no dark-mode leftovers on dashboard surfaces themselves.
- No true emoji anywhere; the ✓/✗/✕/⚠/★ items above are unicode dingbats used as status glyphs (still non-Lucide).
- Nothing was changed, built, or committed. This is the punch list for the UI/UX pass.
