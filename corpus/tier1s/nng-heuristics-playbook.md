<!--
  Marketr Tier 1S synthesis playbook — ORIGINAL EXPRESSION.
  Synthesized from: Nielsen Norman Group's ten usability heuristics (learn-only; not licensed for redistribution).
  License: CC-BY-4.0 (Marketr original synthesis).
  Synthesis date: 2026-09-26. Author: Marketr (original: true).
  This text is Marketr-original and carries no verbatim source content —
  ideas and standard industry practices expressed in our own words, with
  factual attribution to the source of the knowledge.
-->

# The Heuristic Audit: A Field Method for Evaluating Interfaces

*Original synthesis of knowledge learned from Nielsen Norman Group's ten usability heuristics. Ideas are expressed in Marketr's own words; factual attribution to Nielsen Norman Group's research and guidance.*

## What this is and why it matters

A heuristic evaluation is a structured way for someone who understands design principles to walk through a product and flag the places where it fights its users. It is cheap, fast, and catches the vast majority of serious usability problems long before you can recruit test participants. It does not replace watching real users struggle with your product — nothing replaces that — but it turns a vague feeling that "this page is confusing" into a specific, fixable diagnosis.

Nielsen Norman Group distilled decades of usability research into ten broad principles — guidelines about how interfaces should behave that hold up across platforms and decades. The value is not in memorizing them as slogans. The value is in learning to see through them: to look at any screen and interrogate what it is doing to the person in front of it. This playbook teaches each principle as an operational question you ask during an audit, then gives you a process for running the audit and converting findings into a prioritized fix list.

## The ten principles, as audit questions

**1. Does the interface keep people informed about what is happening?**
Every action should produce feedback that arrives quickly enough and clearly enough that nobody wonders whether something worked. When a form submits, show a loading state. When a file uploads, show progress. When a background job completes minutes later, say so. The check is simple: perform an action and ask whether a distracted user, glancing at the screen, would know the current state. Silence is the enemy. Note the balance — feedback should be visible without being noisy. A subtle spinner for a fast operation, a clear confirmation for an irreversible one.

**2. Does the interface speak the user's language, not the system's?**
Words, icons, and the order in which things happen should follow the mental model of the person using the product, not the vocabulary of the database or the engineering team. If your users call it a "project," never label it an "entity." If an action deletes data, say so in plain terms rather than hiding it behind technical jargon. Check also that sequences match real-world expectations: a checkout that asks for payment before shipping address will feel wrong even if the engineering is sound. The audit question: would a non-technical user describe this screen using the words it shows them?

**3. Can people get out of wherever they landed, easily and without damage?**
Humans click the wrong thing constantly. Every state the user can reach needs a clearly marked way back: an undo for text edits, a cancel for multi-step flows, a back path from modal dialogs, a way to recover from an accidental destructive action. During the audit, do something "wrong" on purpose — trigger a delete, start a flow you don't intend to finish — and see how hard the interface makes it to retreat. If leaving costs the user their entered data or forces them through a confirmation maze, that's a finding.

**4. Does it follow the conventions people already learned elsewhere?**
Users arrive with habits formed by every other product they use. Common actions should look and behave the way the rest of the platform does: navigation where the platform puts navigation, search where people expect search, swipe and scroll behaviors that match the operating system. This is not about stifling creativity — distinctive design lives in branding and content, not in moving the close button. In the audit, ask for each unfamiliar control: is there a standard version of this, and is the deviation earning its cost? Inconsistency inside the product is even worse than inconsistency with the platform: the same word should never mean two things in two places.

**5. Does the design prevent mistakes instead of merely punishing them?**
The cheapest error is the one that never happens. Look for designs that make invalid actions impossible (greying out unavailable options, constraining input formats with pickers instead of free text), that set sensible defaults so the most common path works untouched, and that require confirmation before destructive acts — while avoiding confirmation fatigue for trivial ones. The audit mindset: for every error message you can imagine, ask whether the interface could have made that error structurally impossible. Scolding users with red text is a design failure wearing the costume of thoroughness.

**6. Does it show options rather than demanding memory?**
People should not have to memorize anything to use your product. Every choice, every piece of information needed to make a decision, and every available action should be visible in context. Recently viewed items, autocomplete suggestions, visible menus instead of hidden commands, labels on icons that aren't universally understood — these all reduce the memory tax. A classic audit trick: cover the screen, then ask what the user needs to remember to complete the task. Whatever they had to hold in their head is a finding. Instructions should also live where the action happens, not on a separate documentation page.

**7. Does it serve both beginners and experts?**
A good interface lets a first-time user succeed on day one while letting a power user move fast on day one hundred. Check that new users get guidance — onboarding, clear labels, sensible defaults — without the interface feeling condescending or locked down. Check that experienced users get accelerators: keyboard shortcuts, customizable layouts, bulk actions, the ability to skip the guided flow. Critically, expert features must never get in a beginner's way. If adding a shortcut made the simple path harder to discover, the trade was wrong.

**8. Is every element earning its place?**
Each extra button, banner, badge, and decorative flourish competes for a finite pool of user attention, and the relative importance of what matters goes down with every addition. Strip the screen down mentally and ask what each element contributes to the task at hand. Marketing copy that interrupts workflows, redundant navigation paths, decorative graphics next to functional ones — flag them. Minimal does not mean empty; it means nothing present without a job. A good audit pass simply asks of each element: who needs this, and for what?

**9. When something goes wrong, does the message respect the human?**
Error messages should be written in plain language, describe the actual problem rather than an error code, and — most importantly — tell the person what to do next. "Submission failed" is a dead end; a good message names the cause and the remedy: what broke, why it matters, and how to fix it. Tone matters too: never blame the user, and never imply the user should have known better. During the audit, deliberately trigger failures — bad input, network loss, expired sessions — and read every message as if you were tired, rushed, and non-technical. That's your actual user.

**10. Is help available exactly when and where it is needed?**
Documentation should be findable, searchable, and written around the user's tasks rather than the system's architecture. But the deeper audit point is about context: the best help is the kind nobody has to go looking for. Empty states that explain what to do next, inline hints beside tricky fields, tooltips on ambiguous icons, progressive disclosure of advanced options. When you do audit formal documentation, check three things: can the user reach it from the point of confusion in one or two steps, does it answer in concrete steps rather than abstract description, and is it short enough to actually be read?

## Running the session

Assemble three to five evaluators if you can; a single evaluator finds roughly a third of problems, and returns diminish fast past five. Each person works alone first — group walkthroughs contaminate judgment. Give everyone a set of representative tasks (sign up, complete a purchase, find a specific setting), not just free browsing: task context reveals problems that casual clicking misses. Each evaluator walks the tasks and records every violation they spot, mapping it to the principle it breaks and noting the screen, the task, and what they expected versus what happened.

Then the group meets. Findings are merged, duplicates combined, and each unique problem gets a severity rating. A practical scale: cosmetic (fix when convenient), minor (low priority), major (high priority — fix soon), and catastrophic (blocks core tasks — fix before anything else). Severity comes from three factors: how often the problem will occur, how much damage it does when it occurs, and how hard it is to recover from. A rare but data-destroying bug outranks a frequent cosmetic annoyance.

## Turning findings into fixes

Sort the merged list by severity, then work top-down. For each major or catastrophic finding, write the fix as a concrete change ("add a confirm step before team deletion" beats "improve error prevention") and attach the screen or flow it affects. Fix the systemic patterns first: a violation of one principle that appears on twelve screens is one design change, not twelve bug tickets. Then schedule a re-audit of the fixed flows — heuristic evaluation is cheap precisely so you can run it repeatedly, after every meaningful redesign, not once at launch.

One honest caveat from the source research: evaluators who are not trained in usability find fewer real problems and more false positives. Pair junior evaluators with someone experienced, and always validate the highest-severity findings with real user observation before committing to expensive redesigns.

## Knowledge provenance
- Source: Nielsen Norman Group's ten usability heuristics (free-to-read; learn-only, not licensed for redistribution).
- Synthesis basis: original expression of ideas from the source; no source text reproduced.
