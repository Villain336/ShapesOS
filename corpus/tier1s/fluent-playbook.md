<!--
  Marketr Tier 1S synthesis playbook — ORIGINAL EXPRESSION.
  Synthesized from: Microsoft Fluent Design System / Fluent 2 (learn-only; not licensed for redistribution).
  License: CC-BY-4.0 (Marketr original synthesis).
  Synthesis date: 2026-09-26. Author: Marketr (original: true).
  This text is Marketr-original and carries no verbatim source content —
  ideas and standard industry practices expressed in our own words, with
  factual attribution to the source of the knowledge.
-->

# Designing for Productivity: The Fluent (Fluent 2) Playbook

*Original synthesis of knowledge learned from Microsoft's Fluent Design System, including Fluent 2. Ideas are expressed in Marketr's own words; factual attribution to Microsoft's official guidance.*

## What this playbook is for

Fluent is the design language behind Microsoft's productivity empire — the Office suite, Teams, Windows, and the enterprise tools where people spend their working lives. Where Apple's guidelines optimize for delight and Material 3 optimizes for systematic brandability, Fluent optimizes for something else: **getting serious work done, fast, across every device and input method a professional might use.** This playbook teaches Marketr to design for the enterprise-productivity posture: dense, calm, keyboard-friendly, token-driven, and relentlessly consistent.

## The five foundations

Fluent 2 is built on five design foundations. Treat them as lenses you hold up to every screen.

### 1. Light

Light draws attention and creates atmosphere — but in Fluent's world, it is used with a light hand.

1. **Light is a spotlight, not a stage.** Subtle illumination can highlight the active control, the hovered row, or the edge of a focused panel. It says "look here" without raising its voice.
2. **Keep it ambient.** Broad, gentle light effects that respond to pointer position give surfaces a sense of life. Aggressive glows and neon edges belong in marketing sites, not in the tool someone stares at eight hours a day.
3. **Light must degrade gracefully.** Effects that depend on pointer tracking should vanish cleanly on touch devices and in high-contrast modes, where they can become noise.

**Do this:** a faint reveal highlight that follows the pointer across a navigation list, confirming which row is hot.
**Not that:** glowing borders on every card that turn a dashboard into a pinball machine.

### 2. Depth

Depth in Fluent organizes the interface into spatial layers so users always know what sits above what.

1. **Layers carry meaning.** A dialog is above the page; a menu is above the control that opened it; a teaching bubble floats above both. Depth should match the *importance and transience* of the layer, not be applied decoratively.
2. **Parallax and perspective are seasoning.** Subtle spatial effects can make transitions feel physical, but the enterprise user is trying to file an expense report, not ride a ride. A little goes a long way; most screens need none.
3. **Shadows are quiet.** Elevation shadows in Fluent are soft and restrained. If you can see the shadow more than the surface, it's too strong.

### 3. Motion

Fluent's motion philosophy can be summarized in one word: **quiet.**

1. **Fast, subtle, purposeful.** Transitions complete quickly — typically a couple of hundred milliseconds — travel short distances, and exist to explain what changed. A panel that slides in tells you where it came from; a fade that swaps content tells you the context changed.
2. **Motion reduces cognitive load, never adds to it.** The right transition makes a state change instantly comprehensible; the wrong one makes the user wait to understand. When in doubt, simplify.
3. **Personality is allowed, but it's seasoning.** Small moments of character — a gentle overshoot on an important confirmation, a smooth handoff between related elements — humanize the product. They should never slow a power user down.
4. **Honor reduced motion.** Provide calm alternatives for users who request less animation. Critical state changes must be perceivable without any motion at all.

**Do this:** a 150ms slide that shows a detail pane coming from the list item you clicked.
**Not that:** a 900ms bounce-and-spin that celebrates opening a settings panel.

### 4. Material

Fluent's material vocabulary distinguishes surfaces by their **lifespan and role**:

1. **Long-lived, stable surfaces** form the app's foundation — the page background, the navigation rail, the content canvas. These are calm, consistent, and unchanging as the user works. They should feel like a desk: always there, never distracting.
2. **Transient overlay materials** belong to temporary layers — menus, dialogs, flyouts, tooltips. These can carry subtle translucency or blur that separates them from what's beneath, signaling "I'm temporary; the real content is underneath."
3. **Never confuse the two.** A stable surface that looks like an overlay feels unreliable; an overlay that looks like a stable surface feels like it won't go away. The material tells the user how to think about the layer.

For Marketr: audit layered UI and ask of each surface — is this permanent or passing? Assign material accordingly, and keep the permanent surfaces visually quiet.

### 5. Scale

Fluent is designed for a world where the same app runs on a phone, a laptop, a wall-sized display, and inside a headset.

1. **Design the experience, not the screen size.** Define how content and controls *behave* as space changes: what collapses, what reflows, what becomes a dialog, what disappears behind a "more" menu.
2. **Components scale, layouts adapt.** A single button component should work at phone size and desktop size; the *layout* decides how many buttons fit and where they go.
3. **Plan for the extremes.** Dense data tables on a 49-inch ultrawide and a single-column task list on a phone are the same product. If your design only works between 13 and 15 inches, it's not done.

## Token-first architecture: the engine room

Fluent's most important structural idea — and the one Marketr should copy first — is its **two-layer token system**:

1. **Global (raw) tokens** hold primitive values: the actual color ramps, spacing steps, font stacks, radius values, shadow definitions. These are the raw ingredients, named mechanically.
2. **Alias (semantic) tokens** map primitives to *purposes*: "the background of a selected list row," "the border of an error input," "the text color of a disabled button." Aliases are what components actually consume.
3. **Components never read raw values.** A button doesn't know its hover color is a specific gray; it knows it uses the "button background hover" alias. This indirection is what makes theming, high-contrast modes, and brand customization possible without touching component code.
4. **Aliases are contextual.** The same alias can resolve differently per theme, per platform, per contrast setting. The component stays identical; the meaning of the alias shifts with context.

**The practical payoff:** when leadership asks for a dark mode, a high-contrast mode, or a white-label reskin, you redefine aliases — you don't redesign screens. If your design system can't do that, it's a style guide, not a system.

Checklist for any design system Marketr generates:

- [ ] Raw value tokens defined once (colors, spacing, type, radii, shadows, motion)
- [ ] Semantic aliases mapping values to purposes
- [ ] Components referencing aliases only
- [ ] Aliases re-mapped per theme (light/dark/high-contrast) rather than components re-styled

## Adaptive density for information-dense UI

Enterprise users live in data: long tables, nested trees, multi-column forms, dashboards with dozens of widgets. Fluent's answer is **adaptive density** — the interface adjusts its compactness to the task and the user:

1. **Density is a dial, not a fixed value.** Comfortable spacing for scanning and learning; compact spacing for power users monitoring dense data. The same component should support both without being redesigned.
2. **Density never breaks touch targets or readability.** Compact means tighter, not cramped. Rows can shrink, but text stays legible and interactive elements stay hittable.
3. **Let the user or the context choose.** A settings toggle for density, or automatic compactness in known data-heavy views, respects that different tasks need different information bandwidth.
4. **Align to a grid.** Dense layouts fall apart without strict alignment — consistent column widths, aligned labels, rhythmic row heights. The grid is what makes density feel organized instead of chaotic.

**Do this:** a data table with a comfortable/compact toggle; compact rows drop padding but keep 13px+ legible text and full row click targets.
**Not that:** shrinking font to 10px and calling it "pro mode."

## Full input-mode support

Fluent assumes users arrive with **mouse, touch, keyboard, or pen** — sometimes all four in one session — and insists the product work completely under each:

1. **Keyboard operability is total.** Every action reachable by mouse must be reachable by keyboard: tab order follows visual order, focus is always visible, shortcuts exist for frequent actions, and no keyboard trap strands the user inside a dialog. Power users live on the keyboard; the product must keep up.
2. **Touch targets stay generous** even in dense layouts — small controls get larger invisible hit areas rather than smaller visible ones.
3. **Pen and touch gestures** should feel natural where the platform supports them (inking, pinch, swipe), but gestures must never be the *only* path to an action. Everything gestural gets a visible, discoverable equivalent.
4. **Hover is an enhancement, not a requirement.** Information or actions revealed only on hover are invisible to touch and keyboard users. If it matters, it needs a non-hover path.

The test: unplug the mouse. If a task becomes impossible, the design failed this foundation.

## Accessibility baked into the token and component layer

In Fluent's architecture, accessibility isn't a review gate — it's **a property of the system**:

1. **Contrast lives in the tokens.** Because components consume aliases, high-contrast themes are implemented by re-mapping aliases to high-contrast values. Every component gets high-contrast support automatically — no per-component audit needed.
2. **Focus indicators are designed, not defaulted.** The focus ring is a first-class visual element with its own token, visible against every background, consistent across every component.
3. **Screen reader support is structural.** Components expose names, roles, and states through the platform's accessibility APIs. Custom controls must report the same information a native control would — "this is a toggle, and it is on."
4. **Text scaling is assumed.** Layouts reflow when the user enlarges text; nothing clips, overlaps, or becomes unreachable.

The lesson for Marketr: push accessibility decisions *down* into tokens and components so every screen inherits them, instead of pushing them *out* to a checklist at the end.

## Cross-platform consistency with platform-appropriate adaptation

Fluent products run on Windows, macOS, iOS, Android, and the web. The system's answer to "one UI or many" is nuanced:

1. **Consistent where it matters:** interaction patterns, terminology, iconography, information architecture, and the core visual language stay the same. A Teams user switching from Windows to iPhone should feel at home immediately.
2. **Adaptive where the platform demands it:** navigation patterns follow platform conventions (tab bars on iOS, navigation drawers on Android), controls respect platform sizing and gesture norms, and system integrations (share sheets, notifications, file pickers) use the native surfaces.
3. **Tokens make this affordable.** Because components consume aliases, platform variants are mostly re-mappings and layout rules — not separate designs.

## Fluent vs. the other systems in this set: the posture contrast

This is the comparison Marketr should internalize, because it determines *which system to borrow from* for a given product:

- **Fluent (enterprise productivity):** restrained motion, adaptive density, total keyboard support, cross-platform consistency, accessibility in the token layer. The aesthetic is calm competence — the interface should disappear into the workday. Emotion is expressed through reliability, not flourish.
- **Apple HIG (consumer delight):** deference to content, clarity through reduction, platform-native idioms, emotional polish. The interface should feel beautiful and effortless. Best borrowed from when the product's job is to make someone *feel* something.
- **Material 3 (systematic brandability):** exhaustive token roles, tonal color science, explicit state machines, expressive theming. Best borrowed from when you need a rigorous construction kit that can wear many brands.

A marketing analytics dashboard like Marketr's own product leans Fluent: dense tables, keyboard-driven power users, long sessions, accessibility as table stakes. A consumer landing page leans Apple. A white-label component library leans Material 3. **Match the system's posture to the product's job.**

## Applying this to Marketr's own UI work

1. Build the two-layer token system first: raw value tokens, then semantic aliases; components consume aliases only.
2. Define light, dark, and high-contrast alias mappings from day one — not as a later pass.
3. Design motion quiet: fast, short, purposeful transitions that explain state changes.
4. Support comfortable and compact density in data-heavy views without breaking legibility or hit targets.
5. Make every workflow completable by keyboard alone; design the focus indicator as a first-class element.
6. Assign materials by layer lifespan: calm stable surfaces for the foundation, subtle overlay materials for transient layers.
7. Adapt navigation and controls per platform while keeping patterns, terms, and iconography consistent.

## Knowledge provenance
- Source: Microsoft Fluent Design System / Fluent 2 (free-to-read official guidance; learn-only, not licensed for redistribution).
- Synthesis basis: original expression of ideas from the source's guidelines; no source text reproduced.
