<!--
  Marketr Tier 1S synthesis playbook — ORIGINAL EXPRESSION.
  Synthesized from: Brad Frost's Style Guide Guide (learn-only; not licensed for redistribution).
  License: CC-BY-4.0 (Marketr original synthesis).
  Synthesis date: 2026-09-26. Author: Marketr (original: true).
  This text is Marketr-original and carries no verbatim source content —
  ideas and standard industry practices expressed in our own words, with
  factual attribution to the source of the knowledge.
-->

# Running a Design System: The Style Guide Operations Playbook

*Original synthesis of knowledge learned from Brad Frost's Style Guide Guide. Ideas are expressed in Marketr's own words; factual attribution to Brad Frost's research and guidance.*

## Workshop vs. storefront: the two halves of a design system

Brad Frost's Style Guide Guide draws a distinction that clarifies every design-system conversation: the **workshop** versus the **storefront**.

The **workshop** is where components are built — the development environment where atoms, molecules, and organisms are coded, tested, and refined. Tools like Pattern Lab or Storybook live here. The workshop is for makers: designers and engineers iterating on components in isolation, trying variants, breaking things safely.

The **storefront** is how the organization *consumes* the system — the published style guide site that shows everyone what exists, how it looks, how it behaves, and how to use it. The storefront is for the whole company: product managers checking whether a pattern exists before speccing a new one, marketers pulling the right button style, new hires learning the visual language.

Teams confuse these at their peril. A team with only a workshop has components nobody can find. A team with only a storefront (usually screenshots in a wiki) has documentation of things that don't really exist in code. You need both, and you need to know which one you're improving at any given moment. The workshop optimizes for builders; the storefront optimizes for discovery and adoption.

## Publish early at a visible URL — visibility creates gravity

The single most actionable piece of operational advice in the Guide: publish the style guide **early, at a visible internal URL, even when it's crude**. Don't wait until the system is complete, polished, or "ready." Put up the rough version on day one and let the team see it.

Why this works is psychological, not technical. A visible style guide becomes the **center of gravity** for the organization's scattered design decisions. Before the guide exists, every team makes its own calls in isolation — its own button styles, its own spacing habits, its own naming. The moment a shared URL exists, those decisions have somewhere to coalesce. People start linking to it in design reviews ("use the modal from the guide"). Product managers check it before requesting custom work. The guide pulls the organization toward consistency by being *there*, not by being perfect.

Frost's corollary: fill in the blanks iteratively, with the whole team. The guide starts sparse — maybe just colors, type, and buttons — and grows as real project work produces new patterns. Each new pattern gets built in the workshop, published to the storefront, and the guide gets a little more complete. The team collectively owns this accretion. A style guide built by one person in a corner is a mandate; a style guide that grows from everyone's work is a habit.

## Replace screenshots with living code, fast

Every style guide starts life with some static documentation — screenshots, written guidance, do-and-don't examples. That's fine as a starting point, but the Guide is blunt about the end state: **replace screenshots with living, coded examples as fast as possible**.

The reason is drift. A screenshot of a button is a picture of what the button looked like on the day the screenshot was taken. The coded button is what the button *is*. The moment the code changes and the screenshot doesn't, the guide is lying — and a guide that lies gets ignored. Living examples can't lie, because they're rendered from the same components shipping to production.

The operational rule: every pattern in the storefront should be a live render of the workshop's component, ideally with the code snippet alongside it so developers can copy the real thing. Static images are acceptable only as temporary placeholders on the road to live examples. Track this migration explicitly — "percentage of patterns with living examples" is a reasonable health metric for the system.

## Dogfood the system

The Guide's credibility test is dogfooding: **build the style guide's own UI from its own components**. The storefront should consume the workshop's output. The guide's buttons should be the system's buttons; its navigation should use the system's navigation patterns; its layout should follow the system's templates.

This does three things. First, it's the ultimate integration test — if the components can't build a decent documentation site, they're not ready for the product. Second, it forces the team to experience the system as consumers, surfacing the gaps that only real usage reveals (missing states, awkward combinations, poor documentation). Third, it's a demonstration: when a skeptical engineer opens the guide and sees it running on the components, the "does this actually work?" question answers itself.

If the guide is built with bespoke one-off code while preaching component reuse, the team notices the hypocrisy, and adoption dies.

## Stay technology-agnostic at the core

Organizations live longer than frameworks. The Guide advises keeping the system's **core technology-agnostic** and translating it into tech-specific flavors, rather than marrying the system to one stack.

In practice: define the pattern — its structure, behavior, accessibility requirements, visual design — independently of any framework. Then implement it for each technology the organization uses (React components, web components, plain HTML/CSS, whatever's next). The pattern is the contract; the implementations are translations.

This pays off twice. When the organization adopts a new stack, the patterns port over — the design decisions survive even as the code changes. And it keeps the system honest: if a pattern can't be described without reference to framework-specific magic, it's probably not a real pattern yet, just an implementation detail wearing a costume.

The operational consequence is that the storefront should document patterns in framework-neutral terms (what it is, when to use it, how it behaves, accessibility notes) with per-framework implementation tabs. The pattern page outlives any single implementation.

## Governance operations: the machinery that keeps it alive

A style guide that nobody maintains becomes a museum. The Guide treats governance as operations — recurring machinery, not one-time policy:

- **Naming conventions:** how patterns are named (remember the Atomic Design rule — name the pattern, not the page it first appeared on), how variants and states are labeled, how tokens are structured. Write the conventions down and enforce them in review. Inconsistent naming is the first rot.
- **Contribution workflow:** who can propose a new pattern, what a proposal must include (use case, design, code, accessibility review, documentation), who approves it, and what the bar is. The bar should be explicit: a pattern enters the system when it's needed in at least two places, or when it encodes a decision the whole org must share. Everything else stays local.
- **Versioning:** how changes are communicated. Semantic-style versioning for components, changelogs on the storefront, and a clear policy on breaking changes (deprecation period, migration guide, direct outreach to consuming teams). Nobody should discover a breaking change by deploying.
- **Deprecation policy:** patterns die. Designs evolve, products pivot, better solutions emerge. A healthy system retires components deliberately: mark deprecated, set a removal date, provide the replacement and a migration path, communicate early and often. A system that can't kill components accumulates cruft until teams stop trusting it.

Assign ownership explicitly. A style guide without a named owner — a person or small team whose job includes the guide's health — decays. Ownership doesn't mean central control of every decision; it means someone is accountable for the machinery running.

## Iterate forever: the guide is a product, not a project

The final and most important reframe in the Guide: **a style guide is a living product with a roadmap, not a project that ships**. Projects have end dates; products have backlogs, users, metrics, and ongoing investment.

Treat the guide's consumers — designers, engineers, PMs — as users. Collect their feedback. Track adoption: what percentage of the product's UI comes from system components? How often do teams request patterns that already exist (a discoverability problem) versus patterns that genuinely don't exist (a coverage gap)? What's the time from pattern proposal to availability?

Put the guide on a roadmap like any other product: this quarter we close the form-component gap, next quarter we tackle data-visualization patterns, ongoing we improve documentation quality. Review the roadmap with stakeholders. Fund it. The organizations whose design systems thrive are the ones that staff them like products — and the ones whose systems die are the ones that "finished" the style guide project and moved everyone on.

## The operations checklist

If you're starting or rescuing a style guide, in order:

1. **Stand up the storefront now**, crude, at a visible internal URL. Visibility before completeness.
2. **Wire the workshop to the storefront**: components built in the dev environment render live in the guide.
3. **Dogfood**: rebuild the guide's own chrome from its components.
4. **Publish contribution, naming, versioning, and deprecation policies** — short documents, enforced in review.
5. **Name an owner** accountable for the guide's health.
6. **Replace every screenshot** with a living example; track the percentage.
7. **Keep pattern definitions framework-neutral**; ship per-stack implementations as translations.
8. **Run it as a product**: backlog, roadmap, adoption metrics, quarterly review.

A design system isn't something you build — it's something you run. The building is the easy part.

## Knowledge provenance
- Source: Brad Frost's Style Guide Guide (free-to-read; learn-only, not licensed for redistribution).
- Synthesis basis: original expression of ideas from the source; no source text reproduced.
