<!--
  Marketr Tier 1S synthesis playbook — ORIGINAL EXPRESSION.
  Synthesized from: Growth.Design (Dan Benoni & Louis-Xavier Lavallée's free case studies and teardowns) (learn-only; not licensed for redistribution).
  License: CC-BY-4.0 (Marketr original synthesis).
  Synthesis date: 2026-09-26. Author: Marketr (original: true).
  This text is Marketr-original and carries no verbatim source content —
  ideas and standard industry practices expressed in our own words, with
  factual attribution to the source of the knowledge.
-->

# Growth Teardowns: Reading Products Like a Psychologist

*Original synthesis of knowledge learned from Growth.Design (Dan Benoni & Louis-Xavier Lavallée). Ideas are expressed in Marketr's own words; factual attribution to Growth.Design's research and guidance.*

The most instructive design education available is free: it is other people's products, read closely. Growth.Design's case studies popularized a discipline for doing this — the product teardown — that turns casual screen-tapping into a systematic extraction of the psychological patterns driving user behavior. This playbook teaches the teardown method, the core psychology patterns it surfaces, the ethics line that separates growth from manipulation, and how to run teardowns on competitor products yourself.

## The teardown method

A teardown is not a review and not a redesign. It is a forensic exercise with four steps:

1. **Observe the flow step by step.** Walk the actual user journey — signup, onboarding, first task, upgrade prompt — as a new user would. Screenshot or note every screen. Resist the urge to judge; collect first.
2. **Ask why each choice exists.** For every element, ask two questions: *what behavior does this choice drive?* and *what metric does it serve?* A progress bar is not decoration — it drives completion, serving activation. A testimonial next to the pricing button is not filler — it reduces hesitation, serving conversion. Assume every deliberate choice is load-bearing until proven otherwise.
3. **Map each choice to a psychological mechanism.** Name the underlying human tendency the choice exploits or serves: commitment, social proof, loss aversion, the goal-gradient effect, variable reward. This is the step that converts observation into knowledge — without it, you have a pile of screenshots; with it, you have a pattern library.
4. **Extract the portable pattern.** Strip away the product's branding and context until you have the abstract mechanism: "show progress toward a visible finish line to accelerate completion," not "Duolingo's XP bar." Portable patterns transfer across products; product-specific observations do not.

The output of a good teardown is not "here is what they did" but "here is the reusable mechanism, the psychology behind it, and where else it applies." Build a library of these and you stop designing from intuition.

## The habit loop

The most frequently surfaced pattern in growth teardowns is the habit loop — the four-phase cycle that turns one-time use into repeated behavior:

1. **Trigger.** Something prompts the action. External triggers are notifications, emails, badges. Internal triggers are emotions and routines: boredom, anxiety, the lull between meetings. Products that win long-term attach themselves to internal triggers — the user reaches for the product because of how they feel, not because a push notification fired.
2. **Action.** The smallest behavior the user performs in response — and the operative word is *smallest*. The action must be as easy as possible: one tap, one scroll, one glance. Every unit of friction at this step loses users geometrically, because the trigger's motivational force is weakest at exactly this moment. Teardowns constantly reveal products shaving steps, pre-filling fields, and deferring decisions to keep the action trivial.
3. **Variable reward.** The payoff must be unpredictable to sustain engagement. A feed that shows something different every time, a streak count that climbs, a match that might be perfect — variability is what keeps the loop spinning after novelty fades. Predictable rewards produce predictable, declining engagement; the brain discounts what it can fully anticipate.
4. **Investment.** The user puts something into the product: data, effort, content, configuration, social connections. Investment does two things at once — it raises switching costs (leaving means abandoning what you built) and it improves the next cycle (your data makes the feed better, your content draws your audience). The loop's genius is that phase four loads phase one of the next cycle: the better the product gets from your investment, the stronger the trigger.

When tearing down a product with strong retention, map every screen to these four phases. You will almost always find all four, deliberately engineered.

## Onboarding as progressive commitment

Teardowns of high-converting onboarding flows reveal a consistent structure: **ask for small yeses before big ones.** The pattern:

- Let the user experience value before asking for identity. The signup wall goes *after* the first win, not before it — once the user has invested effort and seen a result, the account creation step feels like protecting progress rather than paying admission.
- Sequence requests from low-cost to high-cost: a preference tap, then an email, then permissions, then payment. Each yes makes the next yes easier — the user is building a streak of agreement, and breaking it feels inconsistent.
- Never ask for information you do not immediately use. Every field that serves only the company's database is friction with no user-side payoff, and teardowns show it depressing completion.

The metric this serves is activation: the moment the user first gets real value. Everything in onboarding should be justifiable as shortening the path to that moment or raising the odds the user reaches it.

## Progress mechanics: goal gradients, streaks, open loops

Several related patterns govern motivation inside the product:

- **Goal-gradient acceleration.** People speed up as they approach a visible finish line. A progress bar at 70% does not merely inform — it energizes. Teardowns show products manufacturing visible finish lines everywhere: profile completeness meters, setup checklists, "3 of 5 steps done." The finish line must be *visible*; hidden progress does not motivate.
- **Streaks.** Consecutive-day counters convert the habit loop's reward phase into a compounding asset — but they cut both ways. A long streak motivates powerfully; a broken streak can demotivate so sharply the user churns. Well-designed products add streak repair or freeze mechanics, acknowledging that life interrupts routines.
- **Open loops.** Unfinished business holds attention: the unanswered message, the incomplete lesson, the "you have 3 items waiting." The mind tracks open loops involuntarily. Used with consent — surfacing genuinely pending value — this is good service. Used to manufacture anxiety, it is manipulation (see the ethics line below).

## Peak-end design

People do not remember experiences as the average of their moments. They remember the emotional peak and the ending. Teardowns of beloved products consistently reveal deliberate engineering of both:

- **Engineer the peak.** Identify the moment of maximum delight or triumph in the journey — the first result, the milestone hit, the creation shared — and invest disproportionate polish there. A confetti moment, a beautifully rendered summary, a shareable achievement card. This is where motion budget and visual craft should concentrate.
- **Engineer the ending.** Every session, flow, and lifecycle ends somewhere. Endings that feel complete — a summary screen, a "you're all caught up" state, a graceful empty state — leave the user satisfied and willing to return. Endings that fizzle (a dead-end screen, an abrupt paywall) leave a residue of frustration that colors the whole memory.

When tearing down a competitor, ask: what will the user remember tomorrow — the peak and the end? If the competitor engineered both and you did not, that is the gap.

## Social proof at decision points

Testimonials, user counts, ratings, and logos do not persuade in the abstract — they persuade at the moment of hesitation. Teardowns show social proof clustered precisely where doubt spikes: beside pricing, beside the signup button, beside the permission request. The pattern is placement, not volume: one well-placed proof point at the decision point outperforms a wall of logos on a page nobody reads while deciding.

Match the proof to the doubt. Price hesitation is answered by value proof (results, ROI). Trust hesitation is answered by safety proof (user counts, recognizable names). Effort hesitation is answered by ease proof ("set up in 2 minutes," onboarding ratings).

## Loss aversion and endowment, framed honestly

People weigh potential losses more heavily than equivalent gains, and they overvalue what they already feel they own. Products use this constantly: trial countdowns, "your progress will be lost" warnings, personalized workspaces that feel like *yours* within minutes.

The teardown question is always whether the framing is **true**. "You will lose your saved work if you leave" is honest when the work genuinely cannot be recovered — it is a service to warn. "Only 2 spots left!" is dishonest when the scarcity is fabricated. The mechanism is identical; the ethics are opposite. Growth.Design's teardowns return to this line repeatedly: the pattern is portable, the honesty is not optional.

## The ethics line

This is the most important section of the playbook. Psychology-informed design serves the user's goal: it reduces friction toward outcomes the user wants, surfaces information the user needs, and motivates behaviors the user would endorse on reflection. Patterns that extract value *against* the user's interest — manufactured urgency, hidden costs, roach-motel cancellations, shame-based retention, addictive loops optimized for time-spent rather than value-delivered — are dark patterns, not growth.

Three tests for any pattern you extract from a teardown:

1. **The reflection test.** Would the user, fully informed and thinking clearly, endorse having been influenced this way? If yes, it is persuasion in service of the user. If no, it is manipulation.
2. **The symmetry test.** Does the pattern make it as easy to leave, cancel, or decline as to join, buy, or accept? Asymmetric friction is the fingerprint of a dark pattern.
3. **The metric test.** Does the pattern serve a metric the user shares (activation, success, retained value) or only a metric the company keeps (time-on-site, forced conversion)? Growth that the user would not celebrate is extraction wearing growth's clothes.

Marketr's position is unambiguous: teardowns are for learning how to serve users better. Any pattern that fails these tests stays in the library labeled as what it is — a dark pattern to recognize and avoid, never to deploy.

## Running your own competitor teardowns

Operationalize the method:

1. **Pick one flow, one competitor, one question.** "How does their onboarding drive activation?" beats "review their app." Narrow teardowns produce portable patterns; broad ones produce notes.
2. **Walk it as a new user.** Fresh account, real device, no skipping. Capture every screen and every email/notification the flow triggers over the following days — the teardown continues after the session ends.
3. **Annotate each screen with the two why-questions** (behavior driven, metric served), then map to mechanisms from this playbook's pattern library.
4. **Extract 3–5 portable patterns** per teardown, each stated abstractly enough to apply to a different product.
5. **File them with an ethics tag**: serves-user, neutral, or dark-pattern (recognize-only). Review the file quarterly; patterns drift as products evolve.
6. **Convert serves-user patterns into design requirements** for your own flows: "our onboarding must demonstrate value before requesting signup," stated as a checkable rule, not an aspiration.

Done consistently, teardowns compound into the single most valuable design asset a team can own: a pattern library grounded in real products, real psychology, and a clear ethics line.

## Knowledge provenance
- Source: Growth.Design (Dan Benoni & Louis-Xavier Lavallée) (free-to-read; learn-only, not licensed for redistribution).
- Synthesis basis: original expression of ideas from the source; no source text reproduced.
