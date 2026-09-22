# Marketr — Design Brief v2 ("design-v2")
**Status:** APPROVED DIRECTION — Tico's verdict 2026-09-22 ~07:25 EDT drove this brief.
**Baseline commit:** `370464e` · **Ledger:** marketr-design-v2
**Scope:** Design/layout/iconography pass only. No feature changes, no schema changes, no API changes.

Tico's six notes (all non-negotiable, each addressed below):
1. Layout is off → §2 blended layout system; kill the cramped centered-column-with-headers pattern.
2. Chat doesn't look like traditional LLM → §4: ChatGPT/Claude shell.
3. Symbols are generic → §5: Phosphor duotone icon system, repo-wide Lucide replacement.
4. Use libraries outside the old limit → §6: constraint lifted; named library picks.
5. Chat/workflows frame small and limiting; no page header + subheader → §2/§4: full-bleed tool surfaces, headers removed.
6. Study Jasper, CrewAI, Claude, Ahrefs, Semrush → blended language below (§1). Apply all 10 UI skills → §7.

---

## 1. Design language — "Warm Operator"

A blend, not a copy: Claude's warm paper neutrals + Ahrefs' orange-ramp discipline + Semrush's tight utilitarian tool surfaces + Jasper's flat color-band rhythm + CrewAI's premium type moments.

**Color tokens (light mode only — that decision stands)**
- Canvas: `#FAFAF7` warm paper (never pure white page bg, never cool blue-gray).
- Surface: `#FFFFFF`; raised surface: `#FFFFFF` with 1px ring.
- Borders/rings: `rgba(28,25,23,0.08)` 1px — the consensus elevation mechanism (Jasper/Ahrefs/Claude all use borders, not shadows).
- Ink: `#1C1917` (warm near-black); secondary `#57534E`; muted `#A8A29E` (all warm, zero blue-gray — Claude rule).
- Accent: orange-600 `#EA580C` primary CTA/active/focus; hover `#C2410C`; pale wash `#FFF4E8`; deep `#9A3412`.
- **Accent discipline (Jasper/Claude rule): orange ONLY on primary actions, links, active states, focus rings. NEVER on icons, NEVER body text.** Body links use `#C2410C` (passes 4.5:1 on white); `#EA580C` text is reserved for ≥18px/bold.
- Success green / danger red / warning amber stay semantic and muted; no orange-adjacent warning hues.

**Typography**
- UI: Inter (Semrush precedent for dense tools), system fallback.
- Display: Newsreader (Google, via @fontsource/newsreader) for page-level headlines and empty-state invitations — the serif premium signal 3 of 5 reference sites use. UI chrome stays Inter.
- Tracking: display −0.02em; body 0. Sentence case everywhere (frontend-design rule). No ALL-CAPS labels (impeccable bans eyebrow/kicker labels — do NOT use tracked-caps eyebrows despite Claude using them; the skill ban wins).

**Radius — "warm utilitarian"**: cards 10px, controls 8px, pills (full) for CTAs/chips/nav-active. No other radii.

**Shadows**: beautiful-shadows tokens ONLY on floating layers (canvas palette/toolbar, popovers, dialogs, composer, toasts). Everything structural uses 1px rings. Never mix with default Tailwind shadows.

**Impeccable bans (hard):** no hero-metric template (big number + label + accent), no gradient text, no identical card grids (vary widget sizes/composition), no ghost cards, no colored side-stripes >1px, no emoji/unicode glyphs as icons, no monospace-as-technical-costume, no section numbers.

**Dashboard composition (Ahrefs steal, minus bloat):** composite health widget up top (click-through drill-down — "every metric is a link"), varied-size widgets below, one primary action per view, quiet gray "?" tooltips at ambiguous metrics. Co-Pilot-style AI recommendation panel for autopilot/approvals (Semrush steal).

---

## 2. Layout system

- **App shell:** keep the left module rail (Ahrefs/Semrush IA — proven for tool suites). Refine per §1 tokens + §5 icons. Scroll-reactive translucency optional; keep it simple.
- **Full-bleed tool surfaces (automations canvas, AI chat, team chat): REMOVE the page header + subheader pattern entirely.** No centered max-w column, no "Page title + description" block. The surface owns the viewport:
  - Automations: canvas edge-to-edge; floating translucent palette (backdrop-blur 20px/saturate 180% — apple-design material, never stacked translucent-on-translucent), floating top-center toolbar (Save / Run now), right inspector as collapsible floating panel. Maximum canvas space.
  - Chat: see §4.
- **Content pages** (dashboard, project, autopilot, reports): full-width 12-col grid, generous gutters, no narrow centered column. Section rhythm via spacing and flat color bands (Jasper), not cards-in-cards.

---

## 3. What changes per surface

1. **Dashboard** — rebuild composition: warm greeting headline (Newsreader), composite visibility-health widget (drill-down links), varied widget grid (no identical cards), AI "suggested next actions" panel, quiet tooltips. Kill hero-metric template.
2. **Project page** — project-centric IA: project header row (domain, one primary action), tab/grouped tool grid, per-project metric widgets with drill-down.
3. **Automations canvas** — full-bleed per §2; node cards rebuilt on vault/shadcn Card with Phosphor duotone icons; edges orange-tinted on select; run-step states via badges; approval-gate nodes visually distinct (warm amber ring, never red).
4. **AI chat** — §4.
5. **Team chat** — same shell language as AI chat, simpler: channel header slim row (not a page header), message list, composer.
6. **Autopilot/approvals** — approval queue as first-class cards (approve/reject prominent, orange primary on approve), kill-switch control, run history timeline.

---

## 4. AI chat — traditional LLM shell (ChatGPT/Claude read at first glance)

- **Left slim rail (264px):** "+ New chat" (orange primary), thread list (grouped, hover actions), bottom: project context chip + model/mode indicator. No page header above it.
- **Center:** message column `max-w-3xl`, generous vertical whitespace. Assistant messages: plain text, no bubble, small brand mark. User messages: subtle warm-gray bubble, right-aligned. Tool-call traces: collapsible quiet rows. Streaming: blinking caret, fade-in (opacity + y 8px, 200ms ease-out).
- **Bottom composer:** floating rounded-2xl bar, textarea autogrow, attach / slash-command / voice / send buttons; hint line for `/commands`. Composer uses beautiful-shadows `sm`.
- **Implementation:** use shadcn chat primitives (Message, MessageScroller, Bubble) — check the design-vault inventory first; port if missing. NEVER hand-rolled bubbles (shadcn skill rule).
- Empty state is an invitation: headline (Newsreader) + 3–4 suggestion chips that start real threads.

---

## 5. Iconography — Phosphor, repo-wide

Lucide reads generic — replace with **Phosphor Icons** (`@phosphor-icons/react`):
- Feature/nav icons: **duotone** weight (the distinctive look), inheriting text color.
- Small UI chrome (16px): regular weight.
- Never orange icons (accent discipline). Rounded caps/joins.
- **Scope:** repo-wide codemod — replace `lucide-react` imports with Phosphor equivalents via a name-mapping pass; closest match where names differ; verify no missing imports break the build. Install the package.

---

## 6. Libraries (constraint lifted by Tico)

- Keep: BeautifulUI atoms/primitives, shadcn-registry (Base UI) components already in `components/vault/`.
- Add: `@phosphor-icons/react`; `@fontsource/inter` + `@fontsource/newsreader` (or next/font/google — builder's choice, one approach); shadcn chat primitives (Message/MessageScroller/Bubble) from the vault inventory or ported; `motion` (framer-motion successor) for spring physics where CSS can't do it.
- You may pull any other component from `~/workspace/design-vault/library/LIBRARIES.json` / `COMPONENT-MANIFEST.json` (44 libraries) that serves the brief. Light mode + orange-600 stands.
- Write `LIBRARY-MAP-V2.md` superseding `VAULT-COMPONENT-MAP.md`: every surface → library/component source.

---

## 7. The 10 skills — application checklist (ALL apply)

Skill sources: `~/workspace/skills/<name>/SKILL.md`. Read each before building.
- **frontend-design:** two-pass (plan → self-review for generic vibes → code); kill AI tells; Chanel's advice (remove one decorative element); sentence case; CTAs name the action; empty states invite.
- **apple-design:** respond on pointer-down; interruptible springs (damping 1.0, response 0.3–0.4; bounce 0 unless momentum); velocity handoff; rubber-band boundaries; backdrop-blur materials; size-specific tracking; honor reduced-motion/transparency/contrast.
- **beautiful-shadows:** exact token values; floating layers only; one shadow per state; never on dense lists.
- **accessibility:** 4.5:1 text / 3:1 UI; 44px targets (24px min); native elements; focus-visible 2px offset 2px; labels on all inputs; `prefers-reduced-motion` → durations 0.01ms.
- **design-review:** self-review the 6 surfaces against its rubric with measured numbers before screenshotting; DO NOT run its anonymous usage ping (privacy — Tico's vault rule).
- **emil-design-eng:** animation decision framework; <300ms UI; custom easings (`cubic-bezier(0.16,1,0.3,1)` out); press scale(0.97); never scale(0) entrances; exact transition properties; transform/opacity only.
- **shadcn:** compose primitives; no `space-x-*` (gap), `size-*`, semantic tokens, no raw colors; chat primitives for chat; full Card/Dialog/Tabs composition.
- **impeccable:** Operate mode (scanability > expression); bans list (§1); craft floor pre-ship; one authored motion moment per surface.
- **better-interface:** escalation triggers are blockers (no-name controls, no visible focus, color-only meaning, motion-only state change, destructive w/o confirmation).
- **interaction-design:** timing scale (100–150 micro / 200–300 small / 300–500 medium); easing set; skeletons preserve layout; interruptible always.
- Plus **better-ui** + **emil-design-eng** (already in repo workflow).

---

## 8. Engineering constraints

- Read `~/workspace/marketr/AGENTS.md` first: this Next.js has breaking changes — consult `node_modules/next/dist/docs/` before writing code.
- No Prisma/schema/API changes. No new routes (chat/canvas pages exist).
- tsc clean, `next build` passes, `prisma migrate status` unchanged (24 migrations).
- Local git only. No remote/push/publish/deploy. No paid services. Don't touch GitHub integration gaps.
- Screenshots: NEW filenames `v3-*.png` (client caches by path — never reuse names). 6 surfaces: dashboard, project, automations, AI chat, team chat, autopilot. Existing setup: `/tmp/shot/` playwright scripts, preview server on :3000, `.env` admin creds.
- Commit: `feat(design-v2): ...`. Report hash + per-note changelog for Tico's 6 notes.
