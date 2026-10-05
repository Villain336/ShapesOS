# LIBRARY-MAP-V2.md

**Supersedes `docs/history/VAULT-COMPONENT-MAP.md` (retained for reference only).**

The single source of truth for the Marketr design-v2 rebuild (2026-09-22).
Every control in the six target surfaces — dashboard, project, automations,
AI chat, team chat, autopilot — MUST come from the libraries below. Zero
hand-styled controls.

## Visual direction (Warm Operator)

- Canvas: warm paper `#FAFAF7` (`bg-page`), white surfaces with 1px rings,
  warm inks (`text-ink` / `text-ink-2` / `text-ink-3`).
- **Orange discipline:** `#EA580C` only for primary actions, links, active
  states, and focus. Never orange icons, never orange body text.
- Type: Inter (UI) + Newsreader (display, `.display-serif`).
- Radii: cards 10px (`rounded-card`), controls 8px (`rounded-control`), pills
  fully rounded (`rounded-chip` / `rounded-full`).
- Elevation: exact Beautiful Shadows tokens **only** on floating layers:
  `shadow-float-sm`, `shadow-float-md`, `shadow-float-lg`.
- Icons: **Phosphor only** (`@phosphor-icons/react`) — `weight="duotone"` for
  feature/nav icons, `weight="regular"` for small chrome. No Lucide anywhere
  under `app`, `components`, or `lib`.

## Token cheat sheet (Tailwind v4)

Surfaces: `bg-surface bg-inset bg-field bg-canvas bg-page`
Ink: `text-ink text-ink-2 text-ink-3`
Borders: `border-line border-line-strong`
Accent: `bg-accent text-accent-ink bg-accent-tint` (= orange-600 `#ea580c`)
Semantic: `bg-green-tint text-green` / `bg-red-tint text-red` /
`bg-orange-tint text-orange`
Radii: `rounded-chip rounded-control rounded-card rounded-window`
Shadows: `shadow-hairline shadow-btn shadow-card shadow-raised shadow-overlay`,
plus float tokens `shadow-float-sm/md/lg`
Floating material: `.material-float` (blurred warm surface; falls back to
solid under reduced-transparency)

## Where things live

| What | Path | Source |
|---|---|---|
| Design tokens, keyframes, base rules, Warm Operator theme | `app/globals.css` | Rewritten for design-v2; Fontsource Inter + Newsreader |
| `cn()` | `lib/utils.ts` | clsx + tailwind-merge |
| BeautifulUI atoms | `components/vault/atoms/` | BeautifulUI from design-vault showcase |
| BeautifulUI primitives | `components/vault/primitives/` | BeautifulUI from design-vault showcase |
| shadcn-registry components | `components/vault/shadcn/` | design-vault showcase `src/components/ui/` |
| Vault composition wrappers | `components/vault/*.tsx` | Written for the rebuild |

## Component mapping

### Buttons — ALWAYS the BeautifulUI Button
`import { Button } from "@/components/vault/atoms/Button"`
- `variant`: `primary` (dark pill — default primary action), `accent`
  (**orange** — the single main CTA per surface), `secondary`, `ghost`,
  `success`, `quiet`
- `size`: `xs` (toolbar), `sm` (canonical action pill), `md`
- The shadcn button (`@/components/vault/shadcn/button`) exists ONLY for
  internal use inside ported shadcn components. Never import it directly in
  app code.

### Chat primitives (ported from shadcn registry, 2026-09-22)
All live in `components/vault/shadcn/`:
- `message-scroller.tsx` — `MessageScrollerProvider`, `MessageScroller`,
  `MessageScrollerViewport`, `MessageScrollerContent`, `MessageScrollerItem`,
  `MessageScrollerButton` (sticky bottom anchored to the *viewport*, not the
  document — pass `style={{ bottom: "…"}}` so it clears the composer)
- `message.tsx` — `Message`, `MessageContent`, `MessageHeader`,
  `MessageAvatar`, `MessageTime`
- `bubble.tsx` — `Bubble` (`variant="secondary"` user / `"ghost"`
  assistant), `BubbleContent`
- `attachment.tsx`, `marker.tsx` — supporting primitives

Generated imports were fixed at port time: `cn` comes from `@/lib/utils`,
buttons from `@/components/vault/shadcn/button`, scroll chevron is Phosphor
`ArrowDown`. The temporary `components/ui/` directory was removed.

### Other shadcn pieces
`avatar`, `badge`, `checkbox`, `dialog`, `dropdown-menu`, `input`, `label`,
`popover`, `progress`, `scroll-area`, `select`, `separator`, `sheet`,
`skeleton`, `switch`, `tabs`, `textarea`, `tooltip`.

### BeautifulUI primitives in play
`PromptBar` (chat composers), `TaskRows` (run history timelines),
`StreamingText`, `ThinkingState`, `ToolChips`, `CodeBlock`, `ApprovalCard`
(canonical approve/reject card), `InsightCards`, `RecordsTable`,
`FilterTable`, `DiffTable`, `ContextCards`, `SearchList`, `GlideMenu`,
`LoadingState`, `Shimmer`, `StreamText`, `EntityChip`, `ValuePill`.

### Composition wrappers
`Card` (+ `CardHeader`/`CardBody`), `Stat` (single surface summary — not a
hero metric), `EmptyState`, `Field`, `PageHeader` (legacy — do NOT use on new
surfaces; the six target surfaces have their own lean headers).

## The six target surfaces

| Surface | Route / component | Notes |
|---|---|---|
| Dashboard | `app/dashboard/page.tsx` | Operational home: attention queue, projects, win-this-week rail |
| Project | `app/dashboard/projects/[id]/page.tsx` | Explore tool lists grouped Research/Content/Sites/Automate |
| Automations | `app/dashboard/projects/[id]/automations/page.tsx` + `components/WorkflowCanvas.tsx` | Full-bleed canvas, floating palette + toolbar + inspector |
| AI chat | `components/AiChatPanel.tsx` | 264px thread rail, max-w-3xl transcript, floating composer |
| Team chat | `components/TeamChatPanel.tsx` | Same primitives as AI chat, polling transcript |
| Autopilot | `app/dashboard/projects/[id]/autopilot/page.tsx` + `components/AutopilotStudio.tsx` | Approval cards, queue/rules/activity tabs, kill switch |

## Prohibited (per approved docs/history/DESIGN-BRIEF.md)

Hero-metric template · repetitive card grids · ghost cards · gradient text ·
decorative monospace · tracked caps · emoji icons · page section numbering ·
orange icons · orange body text · generic page header/subheader on chat and
automations surfaces.
