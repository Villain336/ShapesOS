<!--
  Marketr Tier 1S synthesis playbook — ORIGINAL EXPRESSION.
  Synthesized from: IBM Carbon Design System; Atlassian Design System; Adobe Spectrum; Shopify Polaris; GitHub Primer; Salesforce Lightning Design System (learn-only guidance; not licensed for redistribution).
  License: CC-BY-4.0 (Marketr original synthesis).
  Synthesis date: 2026-09-26. Author: Marketr (original: true).
  This text is Marketr-original and carries no verbatim source content —
  ideas and standard industry practices expressed in our own words, with
  factual attribution to the sources of the knowledge.
-->

# Enterprise Design Systems: Comparative Playbook

*Original synthesis of knowledge learned from six official design systems — IBM Carbon, the Atlassian Design System, Adobe Spectrum, Shopify Polaris, GitHub Primer, and the Salesforce Lightning Design System. Ideas are expressed in Marketr's own words; factual attribution to each system's official guidance.*

## Why study these six systems

Every one of these systems exists because a large organization needed dozens or hundreds of product teams to ship interfaces that feel like one product. They differ in what they are tuned for, and that tuning is itself the first lesson: a design system is a strategy document before it is a component library.

IBM's Carbon is optimized for product consistency across a sprawling enterprise portfolio — one set of building blocks that can stretch across cloud consoles, data products, and developer tools without each team reinventing foundations. The Atlassian Design System is shaped around collaboration software: issues, comments, boards, and notifications, where the recurring problems are about teamwork metaphors, permissions, and busy multi-user views. Adobe Spectrum is built to carry a single brand identity across wildly different surfaces — desktop applications, web apps, and mobile — where the core problem is translating a visual language across platforms without breaking it. Shopify Polaris serves the merchant: people running businesses who are often not technical and who need commerce admin tools that reduce mistakes in money-moving workflows. GitHub Primer serves developers: a dense, precise audience working in code-heavy surfaces where information throughput matters more than visual warmth. The Salesforce Lightning Design System (SLDS) is engineered for enterprise CRM density — records, lists, and dashboards packed with fields, where the constraint is fitting enormous data models onto one screen without losing legibility.

Marketr's read: a system earns its keep when it answers its organization's hardest UI questions once, so product teams never answer them twice. The differences between these systems are all decisions about *who* the user is and *what* their most demanding workflows look like.

## Token foundations everywhere

All six systems converge on the same architectural idea: separate raw values from the decisions about how those values are used. At the bottom sit primitive values — individual colors, spacing steps, type sizes, radii — which carry no meaning about where they apply. Above them sit semantic aliases that carry intent: a token that means "surface background," "danger text," or "focus ring," which points at a primitive but can be repointed later.

This two-layer structure is what lets one system serve many brands and themes. Carbon, Spectrum, and SLDS each use token layers so that a light theme, a dark theme, or a product-specific brand variant becomes a remapping of the semantic layer, not a rewrite of every component. Atlassian and Primer make the same move with semantic color names that keep their meaning across themes, so switching to dark mode never requires hunting down hard-coded values. Polaris leans on semantic tokens to keep merchant-facing surfaces coherent even as seasonal or brand variants shift underneath.

The collective lesson for Marketr: never store a raw value directly in a component. Always route through an alias that names the *purpose* of the value. Themes, dark mode, and white-labeling for agencies then become token swaps, not rebuilds. And token names should read like design decisions ("action-background-hover") rather than visual descriptions ("blue-60"), because decisions survive rebrands and descriptions do not.

## Component anatomy lessons

Across all six systems, mature components share a recognizable anatomy: they are driven by variants rather than by endless custom props. A button is not twelve separate components; it is one component with axes — size, emphasis (primary, secondary, quiet, danger), and state (enabled, hover, focused, pressed, disabled, loading). Atlassian, Carbon, and Spectrum all document their components this way, and the discipline matters: when every variant is a first-class combination, teams stop inventing ad-hoc one-offs.

Explicit state matrices are the second half of this lesson. Primer and SLDS are especially rigorous here: for interactive components, every state — including the awkward ones like loading-then-errored or disabled-with-tooltip — has a defined appearance and behavior. Carbon pairs this with clear guidance about which states are interactive and which are purely presentational. The payoff is practical: a state matrix is the checklist a developer runs before shipping, and it is where accessibility defects are caught, because focus, pressed, and loading states are precisely the ones most often skipped.

The third shared pattern is composition over configuration. Polaris and Carbon both prefer small, composable pieces (a card that accepts header, body, and actions as slots) over mega-components with forty props. Atlassian's guidance leans the same way for complex surfaces like dialogs and banners. Marketr's takeaway: when a component's prop list keeps growing, it is usually several components wearing a trench coat. Split it, and give teams the composition primitives to reassemble what they need.

## Density philosophies compared

Density — how much information a screen carries per square inch — is one of the places where these systems genuinely diverge, and the divergence is instructive.

Primer assumes developer-tool density as the default. Its audience lives in diffs, issue lists, and dashboards; the system is tuned so that scanning a hundred rows is fast and precise, with compact type, tight spacing, and strong alignment grids. SLDS pushes further into enterprise CRM density: Salesforce screens can carry dozens of fields, tabs, and related lists, so the system supplies compact form rows, dense tables, and truncation rules that keep record pages usable. Both treat high density as a feature, not a compromise.

Polaris sits at the other end by design. A merchant entering inventory or configuring shipping is doing focused, error-prone work, and the system deliberately trades throughput for clarity: larger targets, generous spacing, forgiving forms, and progress cues that make multi-step commerce workflows feel safe. Comfortable density is a deliberate choice for a non-specialist audience doing consequential work.

Carbon, Spectrum, and Atlassian mostly land in the middle, but they add the most transferable idea: density as a *user-level setting* rather than a fixed system trait. Atlassian's and Spectrum's patterns support compact versus comfortable modes that a user or admin can choose, so the same component tree serves a power user who wants density and a newcomer who wants breathing room. Carbon's spacing scale is built so that tightening or loosening it shifts an entire surface coherently.

Marketr's lesson: pick a default density for your primary persona (we are a data-dense marketing workspace, so developer-tool density is closer to our truth than merchant comfort), but build density as a variable, not a constant. A user preference or per-surface density token beats a one-size answer.

## Accessibility as infrastructure

The single most consistent pattern across all six systems: accessibility is not a chapter; it is load-bearing infrastructure. Every system treats it as non-negotiable and bakes it into the parts teams cannot easily change after the fact.

Contrast is handled at the token layer. Semantic color tokens are specified so that text-on-surface pairs pass recognized contrast thresholds in every theme — including dark mode — which means product teams inherit compliant color pairs by default rather than auditing them screen by screen. Focus visibility is handled at the component layer: Carbon, Spectrum, and Primer all define a single, highly visible focus indicator (an offset ring or outline) that works on every component, so keyboard users get a consistent wayfinding signal everywhere. Keyboard interaction patterns are standardized per component — dialogs trap focus, menus respond to arrow keys, tabs follow established roving-index behavior — so assistive-technology users meet the same mental model across the product.

Screen-reader support shows up as component-level contract: names, roles, and states are wired into every interactive component by the system, not left for product teams to remember. Polaris is notably explicit that empty states and loading states must announce correctly, which is exactly the kind of dynamic-content case teams get wrong when it is bolted on later.

Marketr's synthesis: the moment you treat accessibility as a component-and-token contract, it scales with the system. The moment you treat it as per-screen polish, it decays with every release. Build the focus ring, the contrast pairs, and the ARIA contracts into the primitives, then audit against them automatically.

## Voice, content, and data visualization guidance

These systems all ship content guidance alongside components, because the words inside a UI fail as often as the pixels do. Polaris is the most developed here: its microcopy guidance favors plain merchant language, sentence-case headings, and error messages that say what went wrong and what to do next — never just an error code. Atlassian's voice guidance centers on collaboration contexts: notifications, comments, and empty states for teams, where tone has to stay helpful without being patronizing.

Empty states get recurring attention across Carbon, Primer, and SLDS: an empty list or zero-result search should explain the situation, offer the next action, and — where appropriate — reassure the user that nothing is broken. This is a small pattern with outsized impact on perceived quality, and every system that documents it treats it as a component with copy rules, not as ad-hoc text.

Data visualization is where the enterprise systems diverge from marketing-product norms. Carbon and SLDS both publish chart and table guidance aimed at dense operational data: favor legibility over decoration, keep a consistent color assignment for series, never encode meaning in color alone (pair it with labels or patterns), and give tables the same density and sorting contracts as the rest of the system. Spectrum adds cross-platform chart consistency, so a dashboard reads the same on desktop and mobile. Marketr's read is direct: charts are components with the same variant, state, and accessibility contracts as buttons — they need defined empty, loading, and error states, and they need token-driven colors so they survive theme changes.

## Governance patterns

The six systems are equally instructive about *running* a design system, not just building one. Four governance patterns repeat:

First, contribution models. Carbon and Primer both describe how product teams propose additions or changes — a contribution isn't a pull request, it's a review process with design and accessibility gates. The system grows, but no one team can unilaterally widen it.

Second, versioning and deprecation discipline. SLDS and Carbon are explicit: components get versioned, breaking changes are announced with migration paths, and deprecated components get sunset timelines rather than silent removal. This is what lets hundreds of product teams trust the system — they can plan around change instead of being ambushed by it.

Third, documentation treated as a product. Every one of these systems invests in guidance pages that explain *when* to use a component, not just *how*. Atlassian and Polaris are strongest on usage guidance — the "use this, not that" examples that prevent misuse. The lesson: undocumented components get misused, and misused components erode the system's authority.

Fourth, adoption support. Carbon and SLDS both describe dedicated support for product teams — office hours, migration help, review of new surfaces. A design system without an adoption function is a library nobody reads.

Marketr's takeaway: governance is the difference between a component library and a design system. Budget for the review process, the versioning discipline, the docs, and the human support from the start.

## What to steal for Marketr: a distilled checklist

Drawing the six systems together, here is the distilled set of moves Marketr should adopt:

1. **Token layers.** Primitives at the bottom, semantic aliases above. No raw values in components. Theme and dark mode as token remapping, including agency white-labeling later.
2. **State coverage.** Every interactive component ships with an explicit state matrix — enabled, hover, focus, pressed, disabled, loading, error — and the awkward combinations get defined, not discovered in production.
3. **Density strategy.** Default to data-dense (closer to Primer/SLDS than Polaris), but implement density as a switchable variable so individual users and surfaces can go comfortable.
4. **Accessibility defaults.** Contrast enforced at the token layer, one consistent focus indicator at the component layer, keyboard and screen-reader contracts built into every interactive component, automated checks in the pipeline.
5. **Contribution workflow.** A documented path for proposing components and changes, with design and accessibility review gates — no unilateral additions.
6. **Docs as product.** Every component gets usage guidance (when to use, when not to), copy rules, and do/don't examples. Empty states, error messages, and chart conventions get the same treatment as buttons.

## A caution: guidance text is learn-only

These systems' official guidance is published to be read and learned from, not to be redistributed or copied. Marketr's rule, consistent with how this playbook was written: reimplement the *ideas* — the token layering, the state matrices, the density thinking, the governance discipline — and never lift the assets, the component names, or the prose. When in doubt, ask whether what we're taking is a technique (fine) or an expression (not fine). Techniques compound; expressions get you in trouble.

## Knowledge provenance
- Sources: IBM Carbon Design System; Atlassian Design System; Adobe Spectrum; Shopify Polaris; GitHub Primer; Salesforce Lightning Design System (all free-to-read official guidance; learn-only, not licensed for redistribution).
- Synthesis basis: original expression of ideas from the systems' guidance; no source text, component code, or assets reproduced.
