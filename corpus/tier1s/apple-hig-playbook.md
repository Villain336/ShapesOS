<!--
  Marketr Tier 1S synthesis playbook — ORIGINAL EXPRESSION.
  Synthesized from: Apple Human Interface Guidelines (learn-only; not licensed for redistribution).
  License: CC-BY-4.0 (Marketr original synthesis).
  Synthesis date: 2026-09-26. Author: Marketr (original: true).
  This text is Marketr-original and carries no verbatim source content —
  ideas and standard industry practices expressed in our own words, with
  factual attribution to the source of the knowledge.
-->

# Designing to Apple's Standard: The Apple HIG Playbook

*Original synthesis of knowledge learned from the Apple Human Interface Guidelines. Ideas are expressed in Marketr's own words; factual attribution to Apple's official guidance.*

## What this playbook is for

Apple's Human Interface Guidelines are the most influential set of design principles in consumer software. They don't teach tricks; they teach restraint. This playbook distills the philosophy into rules Marketr can apply when generating, evaluating, or improving any interface — marketing dashboards included. Internalize this and your designs will feel calm, premium, and effortless.

## The three pillars

Apple's guidance has long been organized around three themes. Everything else is commentary on these.

### 1. Clarity

Clarity means the interface never makes the user wonder what something is, what it does, or why it's there.

1. **Every element must earn its place.** Before adding a label, icon, button, or decorative flourish, ask: does this help the user act? If it only helps the designer feel productive, cut it. Busy screens are failed screens.
2. **Controls must be unmistakable.** A button should look tappable; a heading should look like a heading; disabled things should look disabled. Never require experimentation to discover what is interactive. If the user has to tap it to find out, the design failed.
3. **Hierarchy is legibility.** Size, weight, and spacing should tell the user what to read first, second, and never. One dominant headline per screen. Supporting text gets visually quieter. Fine print stays fine but remains readable.
4. **Say what it does in words people already use.** Labels and headlines should use the user's vocabulary, not the system's. "Save invoice" beats "persist document."

**Do this:** one primary action per screen, visually louder than everything around it. Secondary actions sit quieter. Destructive actions are visually distant from the primary.
**Not that:** three equally loud buttons side by side, forcing the user to read all three before knowing which is safe.

### 2. Deference

Deference is the idea that the interface is a supporting actor and the user's content is the star. Chrome, borders, panels, and decoration should get out of the way.

1. **Content is the hero; chrome is the stagehand.** Strip containers, dividers, and backgrounds until removing one more would cause confusion. Generous whitespace is a design element, not empty space.
2. **Blur and translucency hint at what's behind, they don't decorate.** When a layer is translucent, it should communicate *layering* — this panel floats above the content beneath — not just look pretty.
3. **Full-bleed content where possible.** Let photos, video, and primary content fill the screen edge to edge. Controls float on top of it or appear on demand, then retreat.
4. **Motion serves the content, never itself.** Animation draws attention to a change in the content or the user's position in the app. Celebration animations that distract from the task are out.

**Do this:** a photo library app where thumbnails fill the screen and controls appear only when you need them.
**Not that:** every image wrapped in a heavy card with a thick border, a drop shadow, a badge, and three buttons underneath.

### 3. Depth

Depth uses visual layers and motion to answer three questions the user always has: *Where am I? Where can I go? Where did I come from?*

1. **Layers have meaning.** A sheet that slides up from the bottom is a different kind of object than the screen behind it — it feels temporary, dismissible, subordinate. A push that slides in from the right feels like moving *forward* in a hierarchy; sliding back out returns you.
2. **Navigation should be physically consistent.** If moving deeper goes right, coming back must go left. If sheets dismiss downward, they should also appear upward. Inconsistent directions teach the user that motion is meaningless decoration, and then all motion stops working as a cue.
3. **Raise, don't flatten, what's important.** Modals, pickers, and alerts sit above the main flow both visually and physically. When they appear, dim or blur what's beneath so attention moves to the layer that matters.
4. **Transitions explain state changes.** A shared element that grows from a thumbnail into a full screen tells the story "this is the same thing, bigger." A crossfade between unrelated screens says "context changed." Use the right grammar.

**Do this:** tapping a list item slides the detail view in from the right; swiping or tapping back slides it out the way it came.
**Not that:** every transition is the same generic fade, so users lose track of whether they're drilling deeper or switching contexts.

## Design for each platform, not for all of them

One of Apple's firmest rules: **adapt to the platform's conventions instead of shipping one identical UI everywhere.** A Mac app should feel like a Mac app — menu bar, keyboard shortcuts, window chrome, right-click affordances. An iPhone app should feel like an iPhone app — gestures, bottom tab bars, large titles. A watch app should do one thing per screen because that's all the wrist can hold.

Practical implications for Marketr:

- When generating UI, ask what platform it's for and apply that platform's navigation patterns, control sizes, and idioms.
- Never port a desktop sidebar-and-toolbar layout onto a phone and call it done. Rework the information architecture for the smaller surface.
- Respect platform-specific behaviors users rely on: system back gestures, pull-to-refresh, long-press context menus, system share sheets. Rebuilding these custom breaks muscle memory.

## The interface should adapt to the user's settings

Apple expects interfaces to be dynamic, not static:

1. **Semantic color, not hardcoded color.** Name colors by role — "primary text," "secondary background," "accent" — and let each role resolve to the right value for the current mode (light/dark), contrast setting, and platform. A hardcoded gray that looks fine in light mode will wash out in dark mode.
2. **Dynamic type.** Text must remain legible and well-laid-out when the user cranks the system text size to maximum. Layouts that clip, overlap, or truncate at large sizes fail this rule. Design every text container to grow gracefully.
3. **Appearance modes.** Dark mode isn't an inverted screenshot; it's a re-tuned palette where surfaces darken, shadows weaken (they're invisible on black), and emphasis shifts to lighter strokes and subtle borders.
4. **Reduced motion.** Honor the user's request for less animation with calmer, instant, or simplified transitions — never strip all feedback, just the drama.

## Hierarchy, harmony, and consistency

- **Hierarchy:** one path through each screen. The eye lands on the most important thing first because it's biggest, boldest, or most colorful — never all three by accident.
- **Harmony:** elements that belong together look related — consistent spacing, aligned edges, matching corner radii, a single accent color used sparingly. Harmony is what makes an interface feel designed rather than assembled.
- **Consistency:** the same action works the same way everywhere in your product. If swipe-to-delete exists on one list, users will try it on every list. Consistency across your own app matters more than novelty.

## Use familiar conventions so people instantly know how to act

Apple pushes designers toward platform patterns precisely because users arrive pre-trained. A tab bar at the bottom of an iPhone app needs no onboarding. A standard toggle switch needs no explanation. **Custom controls are a tax on the user** — charge it only when the standard control genuinely can't express what you need, and then make the custom control behave as close to the standard as possible.

Checklist when evaluating a design:

- Could a first-time user tell what's tappable without trying?
- Is there a platform-standard pattern for this interaction, and if so, why aren't we using it?
- Does every custom element behave like its closest standard cousin?

## Accessibility is a design input, not a final checklist

Apple's stance is that accessibility work done at the end is damage control; done at the start, it's just design.

1. **Label everything.** Every icon-only button, image, and custom control needs a text description for screen readers (VoiceOver). "Close" is a label; "X" is not.
2. **Contrast is non-negotiable.** Body text must stand out from its background at ratios that survive sunlight, cheap screens, and aging eyes. Decorative low-contrast text is the first thing to fail — so don't decorate with text.
3. **Touch targets are generous.** Interactive elements should be comfortably tappable — around 44 points or larger — with enough spacing that neighbors can't be hit by accident. Small targets are an error factory.
4. **Don't rely on color alone.** Errors, statuses, and required fields need an icon or text in addition to color, because a meaningful share of users can't distinguish your red from your green.
5. **Test the flows, not just the pixels.** Run through your product with a screen reader and keyboard only. If a task can't be completed, it's a design bug, not a user problem.

## Translucency and materials: restraint wins

Apple's visual signature — frosted panels, blurred bars — is powerful precisely because it's used sparingly.

1. **Material communicates layering.** A translucent toolbar tells the eye "I'm floating above the content." If everything is translucent, nothing is.
2. **Legibility beats atmosphere.** Blur is not a license for thin text over busy backgrounds. Content over translucent surfaces still needs sufficient contrast; add a scrim or solid backing when the background is unpredictable.
3. **Keep it stable.** Materials shouldn't flicker or change opacity as content scrolls beneath them. The effect should feel like real glass — constant and calm.

## Applying this to Marketr's own UI work

- Start every screen with the content, not the chrome. Add interface elements only to answer a user question or enable an action.
- Give each screen one job and one primary action; make it visually dominant.
- Animate to explain navigation and state changes, not to entertain.
- Use the platform's patterns first; customize only with justification.
- Design the dark mode and large-text versions from the beginning, not as a pass at the end.
- Evaluate every generated interface against the three questions of depth: can the user tell where they are, where they can go, and where they came from?

## Knowledge provenance
- Source: Apple Human Interface Guidelines (free-to-read official guidance; learn-only, not licensed for redistribution).
- Synthesis basis: original expression of ideas from the source's guidelines; no source text reproduced.
