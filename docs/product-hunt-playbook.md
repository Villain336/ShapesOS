# Product Hunt launch playbook (STAGED — not executed)

**Status: staged.** This playbook is prepared as part of Phase 7 launch readiness
(F6) and is **not** executed in this phase. No public flip happens before the
open-core split is decided (SPEC-PHASE7 §12.5). When the split decision lands,
this playbook is the execution plan.

## The launch slot

- **Launch day: Tuesday, 12:01 AM PT sharp.** Tuesday maximizes the full-week
  voting window; the 12:01 AM PT start captures the entire day-one cycle.
- **Target band: ~450–600 upvotes.** That band is competitive-but-winnable for a
  dev-tool/marketing-OSS launch in 2026; below it you don't chart, above it
  you're fighting the day's whale.
- **What actually decides rank:** comment quality + first-4-hour velocity — not
  raw upvote totals. A launch with 500 upvotes and 3 comments loses to 400
  upvotes and 80 substantive comments.

## The iron rule

**Never solicit upvotes.** No "go upvote us" posts, no DM campaigns, no
incentivized voting. Product Hunt detects and penalizes it; worse, it poisons
the comment well that actually decides the ranking. You may announce the launch
("we're live on Product Hunt — come ask us anything"); you may not ask for the
click.

## 14-day prep timeline

| Day | Action |
|---|---|
| T-14 | Lock the tagline (one line), the 3-bullet what-it-does, and the first comment. Draft the maker comment now — it's the highest-leverage text of the launch. |
| T-13 | Ship the README/docs bar: tagline + bullets + hero screenshot + badges above the fold; open-vs-commercial table; 3–5 real-UI screenshots. |
| T-12 | Record the demo: 60–90 seconds, real UI, no slideware. GIF fallback for slow connections. |
| T-11 | Line up the hunter (or self-hunt — decide now; hunters with relevant audiences still move the needle in 2026). |
| T-10 | Prep the "ask me anything" roster: who answers comments in the first 4 hours, in shifts. Nobody launches alone. |
| T-9 | Write 5 launch-day social posts (X, LinkedIn, relevant communities) — announce, don't solicit. |
| T-8 | Dry-run the launch checklist: staging deploy of the public repo state, docs links, demo video embeds. |
| T-7 | One week out: soft-announce to the waitlist/community ("launching next Tuesday") with the *problem*, not the ask. |
| T-6 | Finalize pricing/packaging page — hunters' first question is always "how do you make money." |
| T-5 | Prepare the comparison one-pager (vs. the incumbents) for comment-thread questions. |
| T-4 | Rehearse answers to the 10 hardest questions (license, moat, pricing, "why not just use X"). |
| T-3 | Freeze code. Only docs/copy changes after this point. |
| T-2 | Schedule everything. Confirm the AMA roster and time zones. Sleep. |
| T-1 | Pre-write the first comment, the maker story, and the "thank you" evening update. Stage assets. |
| T-0 | **12:01 AM PT: launch.** Post the first comment immediately. Work the comments for 4 hours straight — every question answered within the hour. Evening: post the day-one update comment. |

## Launch-day operations

1. **First 4 hours = the election.** Maker team in the comments continuously. Every
   question gets a substantive answer; every skeptic gets respect, not defensiveness.
2. **Comment quality over volume:** one thoughtful technical answer beats ten
   "thanks!" replies. Seed 3–5 deep questions from friendly experts if the thread
   is quiet (genuine questions, not plants).
3. **Social:** announce once per channel in the morning, once with the day-one
   numbers in the evening. Never "upvote us" — "we're live, come grill us."
4. **Track:** upvotes/hour, comment count, referral sources, signups. If velocity
   dies after hour 6, the evening update comment + founder story post is the
   recovery lever.

## Assets checklist (all staged before T-0)

- [ ] Tagline (≤60 chars) + 3 bullets
- [ ] Hero screenshot (real UI, current build)
- [ ] 60–90s demo video + GIF fallback
- [ ] Maker first comment (story + ask-me-anything framing)
- [ ] Pricing/packaging page live
- [ ] Open-vs-commercial table (matches the split decision)
- [ ] Docs: install, config, architecture, API reference, licensing
- [ ] 10 hardest questions + answers (rehearsed)

## Kill criteria (do NOT launch if…)

- The open-core split is undecided (it is, as of 2026-09-25).
- CI is not green on a clean clone.
- The credential-free smoke test doesn't pass.
- SECURITY.md's reporting channel is still a placeholder.
- CLA-vs-DCO is unsettled.
