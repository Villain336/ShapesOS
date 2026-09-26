<!--
  Marketr Tier 1S synthesis playbook — ORIGINAL EXPRESSION.
  Synthesized from: Material Design 3 (learn-only; not licensed for redistribution).
  License: CC-BY-4.0 (Marketr original synthesis).
  Synthesis date: 2026-09-26. Author: Marketr (original: true).
  This text is Marketr-original and carries no verbatim source content —
  ideas and standard industry practices expressed in our own words, with
  factual attribution to the source of the knowledge.
-->

# Building Systematic Interfaces: The Material Design 3 Playbook

*Original synthesis of knowledge learned from Material Design 3. Ideas are expressed in Marketr's own words; factual attribution to Google's official guidance.*

## What this playbook is for

Material Design 3 is the most complete, token-driven design system in the industry — a working grammar for color, type, shape, motion, and components that scales from a watch face to a desktop dashboard. This playbook teaches Marketr to *think in tokens*: every visual decision should be a choice from a finite, named system, never an arbitrary value invented on the spot. If the Apple playbook teaches restraint, this one teaches rigor.

## Color: roles, not hex values

The single most important shift Material 3 asks of a designer: **stop picking colors, start assigning roles.**

1. **Every color has a job.** Material 3 defines semantic roles — primary, on-primary, surface, on-surface, surface-container variants, error, and their "on-" counterparts for content drawn atop them. A role says *what the color is for* (e.g., "the color of the main brand action," "the color of text on that action"), not what it looks like.
2. **Never hardcode a hex where a role belongs.** When a component needs "primary," it asks the theme for `primary` — it doesn't embed a specific blue. This is what makes light mode, dark mode, and brand reskins possible without redesigning every screen.
3. **On-colors guarantee contrast by construction.** Each container role is paired with an on-color designed to be legible on top of it. If you always pair `primary` with `on-primary`, you get accessible contrast for free instead of eyeballing it case by case.
4. **Containers create hierarchy.** Instead of gray text on white, Material 3 uses tonal containers: a surface-container-low, -medium, -high ladder that lets you build elevation and grouping out of color tone. Cards sit on containers; dialogs sit on higher containers; the background sits lowest.

**Do this:** define `primary`, `on-primary`, `surface`, `on-surface`, plus three container tones. Build the entire screen from those.
**Not that:** fifteen ad-hoc grays, four blues that are "close enough," and a red invented for one error banner.

## Tonal palettes: light and dark from one source

Material 3 builds color schemes from **tonal palettes** — a single hue stepped through thirteen tones from near-white to near-black.

- Pick your brand hue; the system generates the full tonal ladder automatically.
- Light and dark schemes are two different *assignments* of the same tones to the same roles — dark mode isn't "inverted," it's re-mapped. Surfaces go dark, primary goes to a lighter tone, on-colors flip to match.
- Because every role draws from a fixed ladder, the whole interface stays harmonious: no tone appears that doesn't belong to a family.

For Marketr: when generating a theme, derive every surface, border, and text color from a small set of tonal ramps rather than sampling colors independently. Two ramps (a brand hue + a neutral hue) can cover an entire product.

## Type: roles with defined specs

Just as color has roles, **type has roles** — a fixed ladder:

- **Display** (largest, for hero moments and major numbers)
- **Headline** (section-level statements)
- **Title** (card and dialog titles, smaller headlines)
- **Body** (the workhorse: paragraphs, list content, descriptions)
- **Label** (buttons, tabs, overlines, captions — small, often uppercase or tracked)

Each role carries a defined size, weight, and line height, with large/medium/small steps inside most roles. The discipline this buys you:

1. **No orphan type styles.** Every string of text in the product maps to a role. If you need a fifteenth style, you're probably solving a hierarchy problem with typography instead of layout.
2. **Line height is part of the spec.** Body text needs generous line height (roughly 1.4–1.6×) for readability; display type can run tighter because it's short and large. Choosing size without line height is choosing half a style.
3. **Weight carries meaning.** Regular for body, medium/semibold for emphasis and labels, bold reserved for display and the rare moment that truly needs shouting. If everything is bold, nothing is.
4. **Scale type with the screen, not the whim.** On large screens, step display and headline roles up; on small screens, step them down. The role stays the same — only its expression changes.

**Do this:** audit a screen and tag every text node with its role. Anything unclassifiable gets re-set in the nearest role.
**Not that:** 11px here, 12.5px there, 13px somewhere else — "they all looked fine."

## Elevation: tone first, shadow second

Material 3 expresses elevation — the sense that one surface floats above another — primarily through **tonal surface change**, with shadow as a secondary cue.

- Level 0: the bare surface. Level 1: slightly raised (a filled tonal container). Level 5: dialogs and drawers, the highest emphasis.
- In dark mode, shadows are nearly invisible, so tonal elevation *must* carry the effect alone. If your hierarchy depends on shadows, it breaks the moment the lights go out.
- Use shadows restrained: soft, diffuse, and consistent in direction. Harsh offset shadows read as 2009 skeuomorphism, not depth.

Rule of thumb: if you can communicate the layering with a tonal step, do that and skip the shadow. Add shadow only where the surface truly floats (dialogs, menus, sheets).

## Shape: a finite corner-radius scale

Corner radius in Material 3 is a **small token set**, not a per-component art project:

- A scale runs from sharp (0) through extra-small, small, medium, large, to extra-large and full (pills/circles).
- Components adopt shape tokens by category: buttons tend toward full or large; cards medium; dialogs large or extra-large; chips full.
- Keeping the scale finite means the whole product shares a "roundness personality." Mixing 4px, 6px, 7px, and 8px radii across screens is how interfaces quietly become incoherent.

When generating UI: pick the shape family first (rounder = friendlier, sharper = more technical), then apply tokens consistently. Never invent a new radius for one component.

## State layers: every interaction state, explicitly designed

This is one of Material 3's most actionable ideas: **interactive elements don't have one appearance — they have a state machine**, and each state gets a visible, systematic treatment through a translucent "state layer" overlaid on the component:

- **Hover:** a subtle overlay signals "this responds to you."
- **Focus:** a clear visible indicator (not just the browser default, and never nothing) shows keyboard users exactly where they are.
- **Pressed:** a stronger overlay confirms the press landed.
- **Dragged / selected / disabled:** distinct, consistent treatments — selected states often pair a tonal container with an icon; disabled states drop opacity and remove interactivity cues rather than merely graying out.

The state layer uses fixed opacity values per state, so the feedback feels identical across buttons, list items, chips, and icon buttons. Consistency here is what makes an interface feel *solid*.

Checklist for any interactive component you generate:

- [ ] Hover state visible and subtle
- [ ] Focus state obvious to keyboard users
- [ ] Pressed state gives instant confirmation
- [ ] Disabled state is unmistakably non-interactive
- [ ] Selected state (where applicable) is distinct from hover

## Motion: explaining change, with physicality

Material 3 treats motion as a communication channel: it shows *what changed, where it went, and how things relate.*

1. **Continuity over decoration.** Shared-element transitions — an image growing from a thumbnail into its detail view, a FAB morphing into a sheet — tell the user "this is the same object in a new state." That story is the point of the animation.
2. **Easing with physics.** Newer Material guidance favors spring and physics-based easing over fixed cubic curves: elements accelerate and settle like physical objects, with slight overshoot where it aids comprehension. Motion should feel weighty and responsive, not robotic.
3. **Hierarchy in timing.** Exiting elements leave faster than entering elements arrive; small elements move faster than large ones. A single global duration for everything feels wrong because everything doesn't weigh the same.
4. **Purposeful and quick.** Interface motion is measured in hundreds of milliseconds, not seconds. If the user notices the animation before the result, it's too slow or too showy.
5. **Respect reduced-motion settings.** Provide instant or minimal alternatives; never make critical information visible only mid-animation.

## Tokens all the way down

The architecture that makes all of this work: **components consume design tokens, never hardcoded values.**

- Color tokens (`primary`, `surface-container-high`), type tokens (`headline-medium`), shape tokens (`corner-large`), elevation tokens (`level-2`), motion tokens (durations, easing curves) — each is a named value in the theme.
- Swapping a theme (light to dark, brand A to brand B, default to high-contrast) changes tokens, not components. Components don't know what blue they're wearing; they only know their role.
- For Marketr, this means: when generating a design system or component, define the token layer first, then build components that reference it. A component with a hardcoded `#6750A4` is a component that can't be themed.

## Adaptive layout: one system, many screens

Material 3 is **adaptive by construction** — the same components compose differently across window sizes:

- **Layout primitives** (columns, gutters, margins that change at defined breakpoints) do the responsive work so individual components don't have to.
- Navigation transforms with size: bottom bar on phones becomes a navigation rail on tablets becomes a drawer on desktop. Same destinations, platform-appropriate expression.
- Foldables and large screens get multi-pane layouts: list-detail, supporting panels. Content fills the space; it doesn't just stretch.

Practical rule: design the phone layout first, then define *breakpoint behaviors* (what changes at medium, what changes at expanded) rather than designing three separate products.

## Material 3 vs. the other systems in this set

- **vs. Apple HIG:** Apple gives you philosophy and platform conventions; Material 3 gives you a tokenized construction kit. Apple's guidance is "be restrained and defer to content"; Material's is "here are the exact roles, tokens, and state specs." Use Apple for taste, Material 3 for systematic construction.
- **vs. Fluent:** Fluent is optimized for dense enterprise productivity and cross-platform consistency with platform adaptation; Material 3 is optimized for expressive, brandable consumer and prosumer products with deep theming. Material 3's color system is more expressive; Fluent's density and input-mode story is more enterprise-complete.

## Applying this to Marketr's own UI work

1. Define the token layer before any component: color roles from tonal palettes, five type roles with sizes/weights/line-heights, a 6–7 step shape scale, elevation levels, motion tokens.
2. Map every color usage to a role; pair every container with its on-color.
3. Give every interactive element the full state machine (hover, focus, pressed, disabled, selected).
4. Express elevation with tonal steps first, shadows second.
5. Animate to explain state and hierarchy changes; keep it physical, quick, and respectful of reduced motion.
6. Build adaptive behavior from layout primitives and breakpoint rules, not from separate designs per screen size.

## Knowledge provenance
- Source: Material Design 3 (free-to-read official guidance; learn-only, not licensed for redistribution).
- Synthesis basis: original expression of ideas from the source's guidelines; no source text reproduced.
