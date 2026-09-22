# VAULT-COMPONENT-MAP.md

**The single source of truth for the Marketr UI rebuild (2026-09-22).**
Every button, input, card, dialog, dropdown, badge, avatar, tooltip, sheet,
table, tab, and toggle in the touched surfaces MUST be one of the components
below. Zero hand-styled controls. Tico explicitly rejected generic Tailwind
styling — "visual language matches" is not a substitute for using these.

## Where things live

| What | Path in `~/workspace/marketr` | Source |
|---|---|---|
| Design tokens, keyframes, base rules | `app/globals.css` | Ported from `design-vault/showcase` BeautifulUI `foundation.css`, re-skinned: `--accent` = orange-600 `#ea580c`, light-mode only |
| `cn()` | `lib/utils.ts` | clsx + tailwind-merge |
| BeautifulUI atoms | `components/vault/atoms/` | `design-vault/showcase/src/components/atoms/` |
| BeautifulUI primitives | `components/vault/primitives/` | `design-vault/showcase/src/components/primitives/` |
| shadcn-registry (Base UI) components | `components/vault/shadcn/` | `design-vault/showcase/src/components/ui/` |
| Vault composition wrappers | `components/vault/*.tsx` | Written for this rebuild, encode the token language |

Tailwind v4. Token cheat sheet: surfaces `bg-surface bg-inset bg-field bg-canvas bg-page`,
ink `text-ink text-ink-2 text-ink-3`, borders `border-line border-line-strong`,
accent `bg-accent text-accent-ink bg-accent-tint`, semantic `bg-green-tint text-green`
/ `bg-red-tint text-red` / `bg-orange-tint text-orange`, radii
`rounded-chip rounded-control rounded-card rounded-window`, shadows
`shadow-hairline shadow-btn shadow-card shadow-raised shadow-overlay`.
shadcn aliases also work: `bg-background text-foreground border-border bg-primary`
(= orange accent) `text-muted-foreground` etc.

## Component mapping

### Buttons — ALWAYS the BeautifulUI Button
`import { Button } from "@/components/vault/atoms/Button"`
- `variant`: `primary` (dark pill — default primary action), `accent` (**orange** —
  use for the single main CTA per surface), `secondary`, `ghost`, `success`, `quiet`
- `size`: `xs` (toolbar), `sm` (canonical action pill), `md`
- The shadcn button (`@/components/vault/shadcn/button`) exists ONLY for internal
  use inside the ported shadcn components (dialog close etc.). Never import it
  directly in app code.
- **Server components**: `Button.tsx` is `"use client"` — calling its exported
  `buttonVariants()` during server render throws. Import classnames from the
  server-safe module instead:
  `import { buttonVariants } from "@/components/vault/atoms/button-variants"`
  (same cva definition; `Button.tsx` re-exports it for client use).

### Cards / layout
| Need | Component | Path |
|---|---|---|
| Card | `Card` + `CardHeader` + `CardBody` | `@/components/vault/Card` |
| Page title row | `PageHeader` (title, description, actions) | `@/components/vault/PageHeader` |
| Dashboard stat tile | `Stat` (label, value, delta, deltaTone, icon) | `@/components/vault/Stat` |
| Empty list state | `EmptyState` (icon, title, description, action) | `@/components/vault/EmptyState` |
| Form field (label+control+hint) | `Field` (wraps shadcn Label/Input) | `@/components/vault/Field` |

### Overlays / menus / form controls — shadcn (Base UI)
`@/components/vault/shadcn/<name>` — `dialog`, `dropdown-menu`, `tooltip`,
`tabs`, `select`, `switch`, `checkbox`, `popover`, `avatar`, `badge`, `input`,
`textarea`, `label`, `progress`, `separator`, `skeleton`, `scroll-area`, `sheet`.
All speak vault tokens via the shadcn var aliases in `globals.css`
(`--color-primary` IS the orange accent).

### AI chat surfaces
| Need | Component | Key props |
|---|---|---|
| Chat composer | `PromptBar` (`@/components/vault/primitives/PromptBar`) | `demo={false}`, `placeholder`, `onSend(text)`; `variant="Rounded"`; `tall` for hero sizing. Has @ sources + / commands menus built in — wire Marketr slash commands to them. |
| Assistant tool-call trace | `ToolChips` | `steps: ToolStep[]` (`{icon: "think"\|"write"\|"run"\|"read", label, chip, mono, detailMono, detail: [{text, tone?}]}`), `diffs`, `labels={{header, more}}` |
| "Working…" trace | `ThinkingState` | `rows: Row[]`, `active`, `done`, `variant="Steps"` |
| Streaming reply text | `StreamText` (atom) | `text`, `charsPerTick`, `tickMs`, `caret`, `onDone` |
| Cited sources / context chips | `ContextCards` | `chunks: ContextChunk[]` |
| Rich answer w/ sources + follow-ups | `StreamingText` | `content: StreamingToken[]` (`cite` tokens render source chips), `sources`, `followUps`, `loop={false}`, `onFollowUp` |
| Message action bar | `SelectionActions` | contextual AI bar (attach under assistant messages) |
| Thread rail items | `GlideMenu` (gliding highlight) wrapping rows with `data-menu-row` | `highlightClassName="inset-x-0 rounded-control bg-hover"` |
| Loading | `LoadingState` | `label` |
| Inline shimmer | `Shimmer` (atom) | wraps children |
| Status pills in chat | `ValuePill` (atom) | `tone: "neutral"\|"green"\|"orange"\|"red"\|"accent"` |
| Entity mentions | `EntityChip` (atom) | `name`, `color`, `monogram` |

### Automation canvas + approvals
| Need | Component | Key props |
|---|---|---|
| Graph itself | `@xyflow/react` (already installed) — the ONE exception; it is a graph library, not a UI component |
| Node cards | `Card` (vault) — small, `rounded-card bg-surface shadow-card` |
| Node status | `TaskRows` — `rows: TaskRow[]` (`{key, label, amount, status: "done"\|"running"\|"sequence", step?, details}`) for run-step tracking |
| Node palette / toolbar | `GlideMenu` + vault `Button` |
| Property editor | `sheet` (shadcn) + `Field` + shadcn `input`/`select`/`switch` |
| Canvas toolbar buttons | vault `Button` (`xs`/`sm`), `tooltip` (shadcn) on icon buttons |
| Approval gate UI | shadcn `dialog` + vault `Button` (`accent` = approve, `ghost` = reject); status via `ValuePill` |
| Autopilot queue list | `TaskRows` (per-item status) or `Card` list; bulk actions via shadcn `checkbox` |

### Tables / lists / data display
| Need | Component | Key props |
|---|---|---|
| Filterable status table | `FilterTable` | `rows: {task, date, status: "todo"\|"progress"\|"done", owner}[]`, `labels` — use for keyword tables, content lists, queue lists |
| Searchable list | `SearchList` | `items: string[]`, `labels={{placeholder, ariaLabel, emptyTitle, emptyHint}}` |
| Recommendation rows | `RecommendationCard` | `options: RecommendationOption[]` — radar items, decay actions, fix suggestions |
| Insight charts | `InsightCards` | liveline-based; check props in source before use |
| Code / diffs (IDE) | `CodeBlock`, `DiffTable` | check props in source |

### Do NOT use
- `ChatComposer` (primitives) — scripted demo with hard-coded reply phases; NOT a
  real chat component. Build the thread from `PromptBar` + `StreamText`/`StreamingText`
  + `ToolChips` + `ThinkingState` instead.
- `ApprovalCard` (primitives) — a multi-question survey widget, not an approval
  gate. Use `dialog` + vault `Button` for approvals.
- Any hand-rolled `<button>`, `<input>`, card `<div>`, dialog, dropdown, badge,
  or toggle. If a need isn't covered above, port the closest vault component
  and adapt it — never invent a generic Tailwind replacement.

## Hard rules
1. Lucide icons only (`lucide-react`). No emoji anywhere in UI.
2. No `dark:` variants — the app is light-mode only.
3. Orange accent usage: `accent` Button variant for the primary CTA, `bg-accent-tint
   text-accent-ink` for highlights, focus rings are automatic. Never orange body text.
4. Motion: follow `better-ui` + `emil-design-eng` (exact easings in tokens,
   `active:scale-[0.96]` on pressables, no `transition-all`, ≤300ms UI motion).
5. Do not change business logic, API routes, or Prisma schema. UI replacement only.
6. `tsc --noEmit` must stay clean.
