<!--
  Marketr Tier 1S synthesis playbook — ORIGINAL EXPRESSION.
  Synthesized from: CXL blog (learn-only; free practitioner publication).
  Synthesis date: 2026-09-26. Author: Marketr (original: true).
  Ideas expressed in Marketr's own words, with factual attribution to the
  source of the knowledge.
-->

# Experimentation & CRO Playbook

*Original synthesis of knowledge learned from the CXL blog's practitioner articles. Marketr-original words; factual attribution to CXL.*

## The research-first doctrine

Most A/B tests fail because they test opinions. The experimentation discipline that produces winners inverts the process: **research → hypothesis → prioritization → test → analyze → archive the learning.** Testing without research is gambling with extra steps.

### Research before you touch anything

1. **Heuristic analysis.** Walk the funnel like a first-time visitor and document friction: unclear value proposition, weak visual hierarchy, competing CTAs, anxiety points (shipping costs hidden, no trust signals), and distraction (popups, autoplay, clutter). Heuristics generate hypotheses; they don't validate them.
2. **Analytics.** Find where the money leaks: pages with high traffic and low conversion, funnel steps with the biggest drop-offs, segments that underperform (device, traffic source, new vs. returning). A page nobody visits doesn't need a test — it needs traffic.
3. **Voice of customer.** On-site polls ("what's stopping you?"), session recordings, exit surveys, support tickets, reviews. Users tell you exactly what's broken if you ask at the moment of friction.
4. **Technical audit.** Broken elements, slow pages, cross-browser issues, form validation errors. A surprising share of "conversion problems" are bugs.

## Hypotheses that deserve tests

A testable hypothesis has three parts: **because [research insight], changing [element] to [variation] will cause [metric] to [direction].** "Change the button color" is not a hypothesis. "Because polls show visitors don't notice the pricing CTA below the fold, moving it above the fold will increase pricing-page visits" is.

Prioritize with a simple framework — **PIE** (Potential, Importance, Ease) or **ICE** (Impact, Confidence, Ease): score each idea 1–10 on the dimensions, run the highest scorers first. A brilliant test you can't ship for six months loses to a good test you ship Friday.

## Test design: the rules that keep results honest

1. **One primary metric, decided in advance.** Revenue per visitor for e-commerce, lead conversion rate for B2B — pick the metric the business actually optimizes and write it down before launch. Peeking at secondary metrics to declare victory is how losing tests become "learnings."
2. **Sample size and duration, pre-committed.** Calculate required sample size from baseline conversion rate and minimum detectable effect *before* the test; run for full business cycles (at least 1–2 weeks, covering weekday/weekend patterns) even if significance arrives early. Stopping early on a lucky streak is the classic way to ship false winners.
3. **Statistical hygiene.** Use proper significance thresholds (95% is the standard), account for multiple-comparison inflation when testing many variants (champion/challenger with several challengers needs correction), and never restart a test to "get a better result" — that's p-hacking with extra steps.
4. **QA like a pessimist.** Test the variants on real devices, check analytics firing, verify the control still works, confirm no flicker. Broken tests produce broken "insights" that poison the roadmap for quarters.

## What to test, in priority order

1. **The offer and value proposition** — headline clarity, the "why you" statement, pricing presentation. Offer beats design: a 10% discount framed well outperforms a redesigned page with a weak offer.
2. **Friction removal** — form fields (fewer wins), checkout steps, forced registration, surprise costs. Every removed friction point is a conversion rate gift that keeps giving.
3. **Anxiety reducers** — guarantees, reviews near the CTA, security badges, clear return/shipping policies, live chat at decision points. Anxiety is the silent conversion killer; the page that feels safest wins ties.
4. **Urgency and scarcity (honest only)** — real deadlines, real stock limits. Fake urgency ("only 3 left!" on digital goods) converts once and destroys trust forever.
5. **Personalization** — segment-specific experiences: returning visitors see what's new, geo-targeted offers, industry-specific social proof. Start with one high-traffic segment before building a personalization engine.

## Beyond A/B: the experimentation toolkit

- **A/B/n and multivariate** for comparing multiple variants or isolating element interactions — but multivariate needs serious traffic; most sites should stick to A/B.
- **Pre/post and interrupted time series** when randomization isn't possible (pricing changes, site-wide launches) — weaker causal claims, but better than no measurement.
- **Qualitative validation** of winning tests: a variant can win for the wrong reason (confusion that accidentally converts). Follow up with user feedback before rolling out.
- **The learning archive.** Every test — win, lose, or inconclusive — gets logged with hypothesis, result, and takeaway. The archive is the real asset: after 50 tests, patterns emerge that no single test reveals ("our audience responds to specificity, not urgency"). Teams that don't archive repeat their failures.

## Program metrics

Track the program, not just the tests: **win rate** (aim for 1 in 3, not 9 in 10 — a 90% win rate means you're testing trivialities), **average uplift per winner**, **testing velocity** (tests per month — velocity compounds), and **revenue attributed to the program** (uplift × traffic × time). Report quarterly to leadership in money terms, not test counts.

*Attribution: strategic knowledge learned from the CXL blog (CXL). Playbook text is Marketr-original.*
