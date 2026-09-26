<!--
  Marketr Tier 1S synthesis playbook — ORIGINAL EXPRESSION.
  Synthesized from: Refactoring UI (Adam Wathan & Steve Schoger's free blog/tips) (learn-only; not licensed for redistribution).
  License: CC-BY-4.0 (Marketr original synthesis).
  Synthesis date: 2026-09-26. Author: Marketr (original: true).
  This text is Marketr-original and carries no verbatim source content —
  ideas and standard industry practices expressed in our own words, with
  factual attribution to the source of the knowledge.
-->

# Tactical UI Craft: A Checklist from Refactoring UI's Method

*Original synthesis of knowledge learned from Refactoring UI (Adam Wathan & Steve Schoger). Ideas are expressed in Marketr's own words; factual attribution to Refactoring UI's research and guidance.*

Good interfaces rarely fail because the designer lacks taste. They fail because every tiny decision — how big is this heading, how far apart are these two things, which gray is this border — was made from scratch, by feel, in the moment. The core insight behind Refactoring UI's teaching is simple: most ugly UI is the product of too many unconstrained decisions, not too little talent. Constrain the decisions, and decent taste becomes nearly automatic.

This playbook turns that insight into a tactical checklist that any designer, engineer, or design agent can apply to any screen.

## 1. Start from a feature, not a blank canvas

Design does not begin with a hero section or a color swatch. It begins with a real feature — something the user is trying to do — and the smallest implementation that lets them do it. Build the working skeleton first: the form fields, the table rows, the list items, the buttons. Get the functionality visible. Only then layer on hierarchy, emphasis, and polish.

This ordering matters for two reasons. First, a screen designed around real content cannot lie about what matters; the content tells you. Second, polishing an empty layout produces decoration — polishing a working feature produces design.

**Check:** Can you point at every element on the screen and name the user action it serves? If something exists for "balance" or "filling space," it is decoration. Remove it or give it a job.

## 2. Constrain every decision with token scales

The single most powerful habit in Refactoring UI's method: never pick a value freely when you can pick from a scale.

- **Spacing scale.** Define a small set of spacing values (for example, a 4-point progression) and use nothing else. When everything on screen is a multiple of one base unit, layouts snap into alignment without you measuring anything.
- **Type scale.** A handful of sizes with clear jobs: display, heading, subheading, body, small, caption. Text that is "a little bigger than body but not quite a heading" is a failure of the scale — add a step to the scale or use an existing one.
- **Color palette.** A curated ramp of grays plus a small set of brand colors with defined shades. If you are eyeballing a hex value per component, the palette is incomplete.
- **Radius scale.** Two or three radii (small, medium, large) applied consistently: small for compact controls, larger for cards and dialogs. A radius that matches nothing else on the screen is a random number.
- **Elevation scale.** A few shadow depths with assigned meanings (resting, raised, overlay), not a slider you drag until it "looks right."

The mechanism is psychological as much as practical: limited options make consistent choices the path of least resistance. A design agent should treat values outside the scale as bugs, not preferences.

**Check:** Open any screen and list the distinct spacing values, font sizes, radii, and shadows in use. More than the scale defines? Collapse them.

## 3. Build hierarchy with weight, contrast, and spacing before size

When everything looks equally important, the amateur instinct is to make the important thing huge. The disciplined method builds hierarchy from subtler tools first:

1. **Font weight.** Semibold against regular creates a clear step without changing the layout.
2. **Color contrast.** Near-black text next to medium gray text establishes primary and secondary instantly.
3. **Spacing.** More space around an element gives it importance; tight grouping says "these belong together."
4. **De-emphasis.** Instead of making the key item louder, make everything else quieter — lighter text, smaller type, muted icons.

Only after these levers are exhausted should you reach for larger type sizes. In practice, most hierarchy problems are solved by steps one through four and never need the fifth.

**Check:** Squint at the screen (or blur it). Can you still tell what is most important? If the answer depends on reading the words, the hierarchy is built from content, not design.

## 4. Test hierarchy in grayscale before trusting accent color

Color is the weakest hierarchy tool because it is the most easily ignored — and because color perception varies across users and devices. A robust screen reads correctly with all color removed. Do the grayscale test early: strip the accent color and see whether the important elements still stand out through weight, contrast, spacing, and size.

If the screen falls apart in grayscale, the design was leaning on color as a crutch. Fix the structure first, then add color back as reinforcement, not as the only signal.

**Check:** Convert a screenshot to grayscale. The primary action, the key headline, and the critical data should still be identifiable in under three seconds.

## 5. Start with generous spacing, then compress deliberately

Whitespace is the cheapest design material and the one beginners ration most. The method: start with more space than feels natural — generous padding inside cards, airy gaps between sections, breathing room around headings. A spacious layout almost always looks better than a cramped one at first pass.

Then compress with intent. Bring related items closer together to show grouping; reduce padding where density serves the user's task (data-dense tables, dashboards). Every compression should be a deliberate decision about grouping or density, never a default.

**Check:** If the screen feels busy, the fix is almost never "rearrange" — it is "remove something or add space." Try both before restructuring.

## 6. One primary action per view; quiet secondaries

Every view should have exactly one action that is unmistakably the main thing to do — the primary button, visually dominant. Everything else is secondary or tertiary: text buttons, subtle links, icon buttons, quiet borders instead of fills.

Competing primary buttons force the user to do the designer's job of deciding what matters. When two actions genuinely compete, the honest answer is usually that the view is trying to do two jobs and should be split, or that one action is actually a settings-level concern that belongs elsewhere.

**Check:** Cover the primary button. Does the screen still scream a different action? If yes, that action is too loud — demote it.

## 7. Borders, labels, and shadows must earn their place

Borders are the most overused element in amateur UI. A box around everything creates visual noise: every border competes for attention and none of them mean anything. The method's rule: a border, label, or shadow must solve a structural problem — separating two things that would otherwise blur together, grouping related controls, lifting an overlay above the page — or it should not exist.

Common removals that improve screens instantly: borders on table cells (use row dividers or zebra spacing instead), boxes around single form fields (the field itself is the boundary), labels that repeat what the control already says, shadows on elements that sit at the same layer as their neighbors.

**Check:** Delete all borders on the screen. Add back only the ones whose absence causes genuine confusion. Most screens keep fewer than half.

## 8. Flat vs. raised: elevation communicates layering

Elevation — the combination of shadow and position that makes an element feel "above" the page — is a communication tool, not decoration. It answers one question: what layer is this on? A dialog is above the page. A dropdown is above the card it sits in. A sticky toolbar is above scrolling content.

Use elevation only where layering is real. Two adjacent cards at the same level should not have different shadow depths "for variety." Inconsistent elevation teaches the user that depth is meaningless, and then the one place it matters — the modal over the page — loses its signal.

**Check:** Every elevated element should map to a real layer in the stacking order. If you cannot name the layer, flatten it.

## 9. Personality from one deliberate accent, not many treatments

Interfaces get personality the way outfits do: one confident choice, not ten competing ones. Pick one accent color and use it consistently — for the primary action, for active states, for the key data highlights. Everything else stays neutral.

The temptation is to give each section its own color, each status its own hue family, each chart its own rainbow. The result is not personality; it is noise. Restraint reads as confidence. When one color appears in exactly the places that matter, users learn what it means, and the interface feels designed rather than decorated.

**Check:** Count the distinct hues carrying meaning on the screen (excluding photography and data-viz categories). If it is more than one accent plus neutrals, consolidate.

## 10. Icons must match the visual weight of surrounding text

An icon next to text is a partnership: if the icon is heavier, bolder, or more detailed than the text, it dominates; if it is whisper-thin next to sturdy type, it looks broken. Match stroke weight to the text weight, match optical size so the icon sits comfortably on the text baseline, and keep the level of detail consistent across the icon set.

This is also an argument for fewer, simpler icons. A detailed illustration-style icon next to 14px body text will always look wrong. When in doubt, a simpler icon at the right weight beats a beautiful icon at the wrong one.

**Check:** At a glance, does any icon draw the eye before the text it accompanies? If yes, reduce its weight or size until the pair reads as one unit.

## Putting it together: the screen audit

Run any screen through these ten checks in order. Most screens fail checks 2 (unconstrained values) and 7 (decorative borders) first — fixing those two alone typically accounts for the majority of visible improvement. The method compounds: scales make hierarchy cheaper, hierarchy makes spacing decisions obvious, and deliberate restraint in color and elevation makes the accent color do real work.

This is why the approach suits design agents particularly well. It is a set of decidable rules, not a vibe. "Is this spacing value on the scale?" is checkable. "Does this border solve a structural problem?" is answerable. Taste, it turns out, can be substantially proceduralized.

## Knowledge provenance
- Source: Refactoring UI (Adam Wathan & Steve Schoger) (free-to-read; learn-only, not licensed for redistribution).
- Synthesis basis: original expression of ideas from the source; no source text reproduced.
