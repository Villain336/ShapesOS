# THEMING — the dynamic brand-color law (Phase 13 Wave A)

**Provenance:** Tico, 2026-09-27. The 2026-09-25 UI audit lock ("static violet
primary") is AMENDED: each user's primary accent now derives from their
company's brand kit (Settings → Brand kits). Default (no brand set) = the
current inspiring violet. **Everything else in the original lock still holds:**
structure, density, typography (Inter UI / Newsreader display), Lucide-only
icons (no emoji UI), radii (cards 10 / controls 8 / chips full), warm-paper
canvas `#FAFAF7`, 1px-ring elevation, the merge doctrine, and "Mark ready"
recoloured to primary. Only the primary color became a variable.

## The variables (FIXED names — other workers consume these)

Defined on `:root` in `app/globals.css`:

| Variable      | Semantics                              | Default (violet, unchanged visuals) |
|---------------|----------------------------------------|-------------------------------------|
| `--brand-600` | Primary — buttons, active tabs, links  | `#7c3aed` (violet-600)              |
| `--brand-700` | Primary hover/active — darker 600      | `#6d28d9` (violet-700)              |
| `--brand-50`  | Soft tint — row hovers, selection bgs  | `#f5f3ff` (violet-50)               |

**Rule: never hardcode a primary color again — always the variables.**
`bg-violet-600`, `text-violet-700`, `bg-violet-50` (and hexes `#7c3aed` /
`#6d28d9` / `#f5f3ff` used as the UI accent) are banned in new/modified code.
The legacy accent tokens are now aliases, so everything already built on them
re-tints for free:

```css
--accent:      var(--brand-600);
--accent-hover: var(--brand-700);
--accent-ink:  var(--brand-700);
--accent-tint: var(--brand-50);
```

(`--accent-deep` stays fixed violet for now — Wave C call.)

## How components consume them (Tailwind v4)

The repo uses Tailwind v4 with `@theme inline`. The brand vars are registered
as theme tokens that keep the live `var()` reference:

```css
@theme inline {
  --color-brand-600: var(--brand-600);
  --color-brand-700: var(--brand-700);
  --color-brand-50:  var(--brand-50);
}
```

Consume as ordinary utilities — they re-tint at runtime when the tenant brand
overrides the vars:

```tsx
// primary button (replaces bg-violet-600 hover:bg-violet-700)
className="rounded-md bg-brand-600 px-3 py-1.5 text-white hover:bg-brand-700"

// active tab (replaces border-violet-600 text-violet-700)
className={active ? "border-brand-600 text-brand-700" : "border-transparent ..."}

// row hover / selection (replaces hover:bg-violet-50/40)
className="hover:bg-brand-50/40"

// soft chip (replaces bg-violet-50 text-violet-700)
className="bg-brand-50 text-brand-700"

// checkbox accent (replaces accent-violet-600)
className="accent-brand-600"
```

Opacity modifiers (`bg-brand-50/40`, `border-brand-600/30`) work via
Tailwind v4 color-mix. Shared primitives already converted (exemplars):
`app/dashboard/nurture/ui.tsx` (`btnPrimary`, violet `Chip` tone),
`app/dashboard/substrate/ui.tsx` (`btnPrimary`, `rowCls`, violet `Chip`
tone), `app/dashboard/social/SocialApp.tsx` patterns. The legacy tone name
`"violet"` in those Chip maps is kept for caller compatibility — it resolves
to the brand vars, not a hardcoded violet.

## Auto-derivation

The user picks **one** color. `--brand-700` / `--brand-50` auto-derive from
`--brand-600` via `color-mix` in `lib/brand-theme.ts` (`brandThemeVars`):

- `--brand-700 = color-mix(in srgb, <primary> 80%, black)` — hover darkening
- `--brand-50  = color-mix(in srgb, <primary> 7.6%, white)` — soft tint
  (7.6% reproduces `#f5f3ff` exactly from the default violet, so the default
  theme is byte-identical to the old lock)

`lib/brand-theme.ts` is the **only writer** of the brand vars
(`sanitizeBrandHex` accepts `#rgb` / `#rrggbb` only; anything else falls back
to violet). `applyBrandTheme(el, primary | null)` sets/clears the three vars
on a given element; `null` clears them and the `:root` violet defaults return.

## Brand-kit wiring

- Source of truth: the workspace's **default** brand kit, `colors.primary`
  (Settings → Brand kits → "Default kit for this workspace").
- `app/dashboard/layout.tsx` (server) reads it and passes it to
  `components/BrandTheme.tsx`, which applies the vars to the dashboard root
  element via inline style. **Tenant scoping:** vars live on the per-workspace
  theme root — a fresh server render per workspace — so a brand color can
  never leak across workspaces. No brand / invalid hex → violet defaults.
- **Live preview:** while editing a kit, `BrandKitManager` broadcasts every
  picker change via `previewBrandTheme(primary)`; `BrandTheme` listens for the
  `marketr:brand-preview` window event and temporarily overrides the saved
  brand — the whole UI re-tints **before saving**. Closing the editor (or
  unmount) clears the preview and reverts to the saved brand; a successful
  save keeps the preview applied, which is then the new saved state. The edit
  form includes a "Live preview" strip (button + chip + hex readout) built on
  the brand utilities.

## Wave C handoff

Wave C owns the full 26-surface conversion of remaining `violet-600/700/50`
hardcodes (studio editor panels, mail, prospects, media, settings pages,
etc.). This foundation gives it: the three variables, the Tailwind tokens,
the auto-derivation, the tenant wiring, and the law above. Wave C changes
nothing structurally — structure/density/typography/Lucide rules are
untouched by this amendment.
