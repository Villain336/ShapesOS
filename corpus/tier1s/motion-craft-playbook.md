<!--
  Marketr Tier 1S synthesis playbook — ORIGINAL EXPRESSION.
  Synthesized from: Emil Kowalski's public writing on UI animation and design engineering (learn-only; not licensed for redistribution).
  License: CC-BY-4.0 (Marketr original synthesis).
  Synthesis date: 2026-09-26. Author: Marketr (original: true).
  This text is Marketr-original and carries no verbatim source content —
  ideas and standard industry practices expressed in our own words, with
  factual attribution to the source of the knowledge.
-->

# Motion Craft: Animation as Explanation

*Original synthesis of knowledge learned from Emil Kowalski's public writing on UI animation and design engineering. Ideas are expressed in Marketr's own words; factual attribution to Emil Kowalski's research and guidance.*

Animation in interfaces is not decoration. It is a communication channel with a cost: every moving element spends a fraction of the user's attention and patience. The craft, as taught across Emil Kowalski's essays and talks on UI animation, is to make each animation earn its cost by explaining something the user needs to understand. This playbook distills that philosophy into principles and an audit checklist.

## The central question: what does this motion explain?

Before adding any animation, demand an answer to one question: *what does this motion explain?* There are exactly five acceptable answers:

1. **Feedback — the action registered.** The button press rippled, the toggle slid, the item bounced into the cart. The user acted; the interface confirms it heard them. Without feedback, users repeat actions or doubt the system.
2. **Origin — where this element came from.** A dialog grows from the button that opened it; a menu unfolds from its trigger. Origin motion teaches the user the relationship between cause and effect, so next time they know where to look.
3. **Continuity — how two states relate.** A card expands into a detail view; a list re-sorts and items glide to new positions. The motion shows that these are the *same* objects in a new arrangement, not a new screen that replaced the old one. This preserves the user's mental model across transitions.
4. **Focus — what deserves attention.** A subtle pulse on the new message, a highlight that fades on the just-changed value. Motion is the strongest attention signal available; spend it on the thing the user actually needs to notice.
5. **Spatial change — where things moved.** Items reordered, panels slid, drawers opened. When layout changes, motion bridges the before and after so the user doesn't have to re-scan the whole screen.

If a motion explains none of these — if it exists because the screen felt static, because a competitor does it, because it looked nice in the prototype — remove it. Stillness is not a failure state. It is the default, and animation is the exception that must justify itself.

## Frequency sets the motion budget

Not all interactions deserve equal animation. The governing variable is frequency: how often does the user perform this interaction?

- **High-frequency interactions** (typing, scrolling, switching tabs, hovering lists, dismissing toasts — things people do hundreds of times a day) must be near-instant. Their animations, if any, should be measured in tens of milliseconds or removed entirely. A 300ms flourish on an action repeated 200 times a day costs the user a full minute of waiting — and far more in perceived sluggishness.
- **Rare, meaningful moments** (first-run onboarding, completing a major milestone, an empty state resolving, a celebratory confirmation) can afford to be expressive. The user encounters them infrequently, the emotional stakes are higher, and the motion itself becomes part of the memory of the moment.

The common failure mode is inverting this budget: lavish transitions on routine navigation, and a dead, instant cut on the moment that mattered. Audit by frequency first.

## Entrances and exits deserve different timing

A single duration for both directions is a missed opportunity. In practice, exits should usually be faster than entrances. The psychology is straightforward: when something appears, the user needs time to notice and orient — the motion is doing explanatory work. When something leaves, the user has already decided it is gone; lingering exit animations feel like the interface is slow to obey.

A practical starting pattern: entrances around 200–300ms with an easing that settles softly; exits around 120–200ms, snappier, getting out of the way. Tune from there, but keep the asymmetry. Symmetric timing is a sign nobody thought about what each direction is for.

## Animate cheap properties: transform and opacity

Not all CSS properties cost the same to animate. Changing layout-affecting properties (width, height, top, left, margin) forces the browser to recalculate layout for surrounding elements on every frame — expensive, and the classic cause of janky animation. Changing `transform` (translate, scale, rotate) and `opacity`, by contrast, can be handled by the compositor with minimal work.

The rule: express every animation as a combination of transform and opacity wherever possible. Need something to grow? Scale it. Need it to move? Translate it. Need it to appear? Fade it. Reserve layout-triggering animations for the rare cases where the layout change itself is the thing being explained — and even then, consider whether a transform-based illusion (scaling a wrapper while the inner layout snaps) achieves the explanation more cheaply.

This is a performance rule, but it is also a design constraint that improves taste: the discipline of working within transform and opacity pushes animations toward the subtle and purposeful.

## Motion should be interruptible and origin-aware

Real interfaces are not videos; users act mid-animation. Two requirements follow:

**Interruptibility.** Every animation must handle being reversed or superseded partway through. A drawer that is closing when the user reopens it should not finish closing first and then reopen — it should reverse smoothly from its current position. An animation that cannot be interrupted is a modal dialog wearing a costume: it seizes control of the timeline. Build transitions as functions of current state, not as fire-and-forget timelines.

**Origin-awareness.** When an element dismisses, it should return toward where it came from. A popover collapses back into its trigger; a dragged card released over empty space springs home. This closes the loop that the entrance opened (origin, from the five explanations) and reinforces the user's spatial model: things live somewhere, they visit, they return.

Together these make interfaces feel physical rather than theatrical — responsive to the user rather than performed at them.

## Spring and physics-based motion for gestures

For anything the user's finger or cursor directly manipulates — drags, swipes, pulls, flings — fixed-duration easing curves feel wrong, because the user's input has velocity and the animation should too. Spring-based motion, which models stiffness and damping rather than duration, responds to how the gesture actually ended: a fast fling travels further, a gentle release settles quickly.

The practical guidance: use springs for gesture-driven motion and direct manipulation; use tuned duration-based easing for triggered transitions (things that start from a tap, not a drag). When a spring overshoots, that is usually a feature — a slight overshoot reads as physical and alive — but keep it subtle in high-frequency contexts, where even playfulness becomes noise through repetition.

## Reduced motion is a first-class behavior

Respecting the user's reduced-motion preference is not a checkbox at the end of the project; it is a design requirement on par with the animation itself. Some users experience vestibular disorders, migraines, or genuine discomfort from motion. The correct behavior:

- Honor the operating system's reduced-motion setting automatically.
- Under reduced motion, replace movement with instant state changes or simple opacity fades — never with slower versions of the same motion.
- Ensure every piece of information the animation conveys (origin, continuity, spatial change) is still conveyed by the final state alone. If the design depends on the animation to be understandable, the design is broken for these users.

Design the still version first, in fact. If the interface is fully legible with zero animation — and per the central question, it should be, since animation explains rather than carries — then the reduced-motion variant is not a degraded experience. It is the same experience, honestly rendered.

## Default to no animation when unsure

The tiebreaker rule: when you cannot articulate which of the five explanations a motion serves, do not add the motion. Uncertainty is itself the answer — if the explanation isn't clear to the designer, it will not be clear to the user either, and the motion will read as decoration at best and sluggishness at worst.

This is the hardest rule to follow because stillness feels like a lack of craft. It is the opposite: restraint is the craft. Every animation you decline makes the ones you keep more meaningful.

## Motion audit checklist

Run this over any product or prototype:

1. **Explanation check.** For every animated element, name which of the five explanations it serves (feedback, origin, continuity, focus, spatial change). Anything unnameable gets removed.
2. **Frequency budget.** List the five most frequent interactions. Verify each is near-instant. List the three rarest meaningful moments. Verify each earns its expressiveness.
3. **Timing asymmetry.** Confirm exits are faster than entrances everywhere. Flag any symmetric durations for review.
4. **Property cost.** Confirm all animations use transform and opacity only. Flag any layout-triggering animation and justify it or replace it.
5. **Interruptibility.** Trigger each transition, then reverse it mid-flight. Nothing should jump, queue, or finish-then-restart.
6. **Origin-awareness.** Dismiss every overlay, popover, and dragged element. Each should retreat toward its origin.
7. **Gesture physics.** Every drag, swipe, and fling uses spring motion that respects release velocity. No fixed-duration curves on direct manipulation.
8. **Reduced motion.** Enable the OS reduced-motion setting and walk the full product. Everything must remain legible and complete; motion becomes fades or instant changes.
9. **The stillness test.** Disable all animation. If any screen becomes confusing, the layout — not the animation — needs fixing.

A product that passes all nine has motion that serves the user. Everything else is choreography in search of an audience.

## Knowledge provenance
- Source: Emil Kowalski's public writing on UI animation and design engineering (free-to-read; learn-only, not licensed for redistribution).
- Synthesis basis: original expression of ideas from the source; no source text reproduced.
