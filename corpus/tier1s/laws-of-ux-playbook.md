<!--
  Marketr Tier 1S synthesis playbook — ORIGINAL EXPRESSION.
  Synthesized from: Laws of UX (learn-only; not licensed for redistribution).
  License: CC-BY-4.0 (Marketr original synthesis).
  Synthesis date: 2026-09-26. Author: Marketr (original: true).
  This text is Marketr-original and carries no verbatim source content —
  ideas and standard industry practices expressed in our own words, with
  factual attribution to the source of the knowledge.
-->

# Decision Rules for Interface Design

*Original synthesis of knowledge learned from Laws of UX, the public collection of UX principles grounded in psychology. Ideas are expressed in Marketr's own words; factual attribution to the collection and its sources.*

## How to use these

The Laws of UX collect findings from psychology and human-computer interaction research and translate them into practical guidance for designers. They are not laws in the physics sense. They are heuristics — strong tendencies of human behavior that hold often enough to be worth designing for, and that occasionally fail in specific contexts. Treat each one as a hypothesis to apply thoughtfully and then verify with your own users, not as a commandment. The collection is valuable because it gives teams a shared vocabulary for arguing about design decisions: instead of "I feel like the button should be bigger," you can point to a named, researched tendency. This playbook teaches the rules in practical form and ends with an honest account of their limits.

## Make important actions easy to hit

People acquire on-screen targets faster when the targets are large and close to where the pointer or finger already is. This is one of the oldest and most replicated findings in interaction research, and it shows up everywhere: make primary actions prominent and generously sized, keep destructive actions smaller and farther from common paths, and place related controls near each other so the hand doesn't travel. On touch interfaces the principle matters even more, since fingers are imprecise and screen edges are the easiest places to hit. When a checkout button is small and tucked in a corner, conversion suffers for mechanical reasons long before aesthetics enter the picture.

## Fewer, simpler choices mean faster decisions

Decision time grows with the number of options and with how complex each option is to evaluate. The design response is not to remove choices blindly — it is to structure them: group related options, chunk long lists into meaningful categories, hide advanced choices behind progressive disclosure, and preselect sensible defaults so the common path requires no deliberation. A pricing page with three clearly differentiated plans converts better than the same plans scattered across a comparison grid with twelve columns, not because users are lazy but because comparison is cognitively expensive. Simplify the decision, or at least make the structure of the decision visible.

## Users expect your interface to work like the ones they already know

People spend most of their time in other products, so they arrive at yours with a head full of learned patterns. When common tasks behave the way users have learned to expect — a shopping cart works like other shopping carts, a date picker looks like other date pickers — they spend their attention on your content instead of your interface. Novelty is a cost you charge the user; spend it on things that genuinely differentiate the product, not on reinventing navigation. This rule is also why studying competitors' patterns is design research, not copying: familiarity is a feature.

## Grouping communicates relationships

Humans instinctively perceive objects that are near each other, enclosed in a shared region, or styled alike as belonging together. You can exploit this deliberately: place related fields in one card, separate distinct sections with whitespace, use consistent styling for elements that behave the same way. This is how interfaces get their grammar. When everything is evenly spaced and uniformly styled, users must read every label to understand the structure; when grouping does the work, they grasp it at a glance. Audit any busy screen by asking what the spacing is saying — often the spacing is saying something the designer never intended.

## Spend contrast on exactly one thing

An element that differs sharply from its surroundings — in color, size, motion, or style — stands out and is remembered better than uniform elements. The strategic implication is scarcity: if everything is highlighted, nothing is. Choose the single most important action or message on the screen and give it the contrast; let everything else recede. This is the difference between a page with one confident call-to-action and a page with six competing banners where the user's eye lands nowhere. Boldness works only when it is rare.

## Beginnings and endings get the attention

In a list or sequence, the items at the start and the end are recalled and noticed more than those buried in the middle. Practical consequences: put the most important navigation items first and last, lead dashboards with the metric that matters, end onboarding flows and multi-step processes with a strong, reassuring confirmation rather than a fizzle. Also relevant to sequences over time: people disproportionately remember the best moment of an experience and how it ended. A painful checkout that finishes with a delightful confirmation leaves a better memory than a smooth one that ends abruptly in confusion.

## Complexity can be moved, never destroyed

Every system has inherent complexity in what it does; the only question is who carries it. You can absorb it into the product — smart defaults, automation, progressive disclosure, careful information architecture — or you can dump it on the user in the form of manuals, configuration screens, and jargon. Designers should bias toward absorbing complexity, but the honest version of this rule admits there is a floor: oversimplifying a genuinely complex task produces interfaces that feel dumbed-down and untrustworthy to expert users. The goal is the right complexity in the right place, not zero complexity.

## Show progress toward visible goals

People work harder and persist longer as they perceive themselves getting closer to a goal. Visible progress — checklists, progress bars, step indicators, streak counters — converts an amorphous effort into a race with a finish line. The effect is strongest when the goal is clear and the remaining distance looks small, which is why onboarding flows that say "step 3 of 4" outperform open-ended ones, and why showing a partially complete profile motivates completion more than showing an empty one. Use this deliberately in funnels, onboarding, and any multi-step task where abandonment is the risk.

## Unfinished business sticks in the mind

People remember and ruminate on tasks they started but did not complete. This is a powerful lever — abandoned carts, "continue watching" rows, draft reminders — but it demands restraint. Every open loop you manufacture is attention debt you are charging the user, and attention debt spent carelessly becomes annoyance, churn, and dark-pattern territory. Use open loops only where resuming genuinely serves the user: their cart, their draft, their course. Manufactured urgency that exists only to manipulate erodes trust far faster than it lifts metrics.

## People judge by the peak and the ending

When users recall an experience, they do not average every moment — they anchor on the most intense moment and on how it concluded. Two design consequences follow. First, design the ending deliberately: the confirmation screen, the handoff after signup, the last frame of an onboarding flow. A weak ending can sour a strong experience. Second, a single genuinely delightful moment can carry an otherwise ordinary experience, which means delight is not decoration — it is a memory-shaping investment. Audit your flows by asking: what will they remember, and what was the last thing they saw?

## Respect the limits of working memory

People can only hold a few things in active thought at once. Interfaces that demand juggling — comparing three products across three tabs, remembering a code from one screen while typing it into another, forms that hide previously entered values — impose a cognitive tax that produces errors and abandonment. The design answers: one task per screen, keep everything needed for a decision visible at once, show rather than hide entered data, and break long processes into steps where each step's context is self-contained. When in doubt, assume the user is distracted, tired, and on a phone.

## Interactions should feel instant

There is a threshold of responsiveness below which an interface feels like it reacts immediately, and above which the user's attention starts to wander. Keep common interactions under that feeling of instantaneity; for anything that must take longer, acknowledge the wait immediately — a spinner, a skeleton screen, a progress indicator — because an acknowledged wait feels shorter than a silent one. Perceived performance is a design material: optimistic updates, progressive loading, and skeleton placeholders are not cosmetic tricks, they are respect for the user's attention. Never leave a user staring at a frozen screen wondering whether anything is happening.

## The caution section: what these are not

Repeat this to any team that cites these rules as proof: they are heuristics with varying scientific strength, not physics. Some rest on deep, replicated research; others are catchy summaries of messier findings; all of them bend under context. A rule about target size matters differently on a watch than on a desktop. A rule about choice overload matters differently for experts than for novices. Culture, accessibility needs, domain expertise, and device constraints all modulate every principle here. Use them to generate better first drafts and to argue design decisions on grounds stronger than taste — then test with real users, because your context outranks any general rule. The collection's real gift is not answers; it is better questions asked earlier, in a language the whole team can share.

## Knowledge provenance
- Source: Laws of UX (free-to-read; learn-only, not licensed for redistribution).
- Synthesis basis: original expression of ideas from the source; no source text reproduced.
