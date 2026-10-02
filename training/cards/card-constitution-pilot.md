# Data Card — Constitution pilot batch: expert reasoning traces for the four GrowthOS agents

**Recipe:** CONSTITUTION. 200 SFT exemplars expanding the original 12 from
`EXPERT-CONSTITUTION.md`, evenly covering the four agent roles the constitution governs:
Chief Strategy Agent (50), mission planner (50), playbook generator (50), content/brief
agent (50). Each trace: a brief (the task) → reasoning trace (role-ordered deliberation
that applies the constitution's global hard rules to the task) → output (the agent's
deliverable in the constitution's voice: direct, opinionated, numbers-first, restrained).
33 traces (16.5%) are negatives that decline or redirect unsafe, deceptive, premature, or
strategically wrong requests.

**License classes:** TIER-1S-SYNTH (128 traces — authored from Tier 1S corpus chunks:
Marketr-original syntheses of platform/academy sources, CC-BY-4.0) and TIER-2-OPEN
(72 traces — grounded in openly-licensed chunks: CC0-1.0, public-domain, CC-BY-4.0, and
4 CC-BY-SA-4.0 Wikipedia chunks). No Tier 3, no pirated material. Note: 13 traces cite
CC-BY-SA-4.0 Wikipedia chunks (`wikipedia-marketing-clusters#10/#20/#30/#40`); per the
plan's taxonomy these are TIER-2-OPEN (openly-licensed), but the share-alike obligation
travels with those traces — they are ideas-level citations (concepts referenced, chunk
text never reproduced), and any redistribution of the batch should carry CC-BY-SA
attribution for that portion.

**Date pulled:** 2026-09-26. Corpus: manifest v7 (`data/corpus/main/chunks.jsonl` 2,523
chunks, `data/corpus/by-sa/chunks.jsonl` 155 chunks). Read log:
`data/corpus/chunk_read_log.jsonl` (86 entries — every cited chunk extracted, read in
full, and hash-recorded on 2026-09-27; zero blind citations).

**Source clusters + filters:** All 86 cited chunk IDs were read in full before acceptance.
Heaviest grounding: `1s-ahrefs-blog` (43 cites, 6 chunks — SERP/intent discipline, content
audits, honest SEO measurement), `1s-demand-curve-blog` (32 cites, 5 chunks — unit
economics, landing pages, retention), `marketing-without-money` (32 cites, 13 chunks —
zero-budget tactics, launch playbooks), `1s-hubspot-academy` (29 cites, 5 chunks —
topic clusters, conversion paths, nurture), `google-search-central` (22 cites, 4 chunks —
SEO starter guide, local trust signals). Long tail: growth-design, trailhead, wikipedia
clusters (BY-SA), copyhackers, meta-blueprint, linkedin-labs, cxl, bing-webmaster,
scientific-advertising, reddit-for-business, baymard, youtube-creator-academy,
tiktok-academy, amazon-ads-learning, google-skillshop, nscc, x-for-business, sba guides,
refactoring-ui, pinterest-academy.

**Constitution:** `EXPERT-CONSTITUTION.md` global hard rules enforced per trace via
declared `rules` and verifier anchors — zero custody of client spend (explicit
zero-custody language where money/payouts are relevant), autopilot never buys media
(explicit human-approval language where paid-media action is relevant),
propose-vs-execute (draft-first, "you decide" / "your call" approval boundaries),
honest labeling (measured vs. modeled vs. assumed vs. illustrative, labeled as such),
no invented proof (claims sourced to evidence or labeled hypotheses; refusals that
invent no statistics). Voice: direct, opinionated, numbers-first, restrained — no hype,
no emoji.

**Counts:** 200 traces — 170 train / 30 held-out. Split assigned by whole
`duplicate_family` (200 unique single-record families; seed 7) — no family crosses the
split. Negative families proportional in both (28 train / 5 held-out). Dedupe via
sha256 of canonical `reasoning_trace + output`: 0 duplicates. IDs sequential
`trace-cx-000001` … `trace-cx-000200`. `created_at`: 2026-09-26 on all records.

**Verifier:** `training/scripts/cx_lib.py::verify` — checks (1) role constitution/order
(strategy: positioning → audience → offer → channel economics → measurement; mission:
objective → baseline → target → kill condition → trust field → checkpoints → cost
budget; playbook: preconditions → executable step → approval gates → failure modes →
attribution; briefs: explicit SERP or draft/teardown template, or declared role order
with content-structure vocabulary; negatives exempt from positive structure but must
carry explicit decline/redirect language), (2) declared global hard rules present via
semantic anchors, (3) voice (no hype list, no emoji), (4) novelty vs. the original 12
(no family/brief overlap with the 12 exemplars). Final run: 200 candidates → 200
passed, 0 rejected. During development 35 candidates were rejected and every one was
manually repaired (substantive edits, never padding): the dominant fix classes were
missing `no-invented-proof` anchors on content traces (added claims inventories,
sourced-evidence requirements, "observed not invented" measurement language),
missing `honest-labeling` anchors (added measured/modeled/assumed/standard labels),
and missing `propose-execute` anchors (added draft-first / approval-before-publish /
"you decide" boundaries). No trace was accepted by weakening a check.

**Chunk-use summary:** 86 distinct chunks cited, 310 total citations. Usage is
concentrated on SEO/intent discipline (`1s-ahrefs-blog#2`: 14 traces) and spreads
across 25 source clusters; 26 chunks cited once. BY-SA (share-alike) chunks: 4 of 86.

**Thin spots noticed:**
1. **Paid-media tactical depth is thin.** The corpus's paid sources (meta-blueprint,
   google-skillshop, tiktok-academy, amazon-ads-learning) skew to doctrine over
   numbers; traces teach the propose/approve/kill-rule discipline well but carry few
   real bid/budget benchmarks. A future batch grounded in platform benchmark reports
   would harden this.
2. **Enterprise/ABM motion is shallow.** linkedin-labs chunks cover targeting doctrine,
   but multi-threaded enterprise cycles, procurement, and expansion playbooks are
   under-represented in both corpus and traces.
3. **Retention/activation frameworks beyond public summaries.** demand-curve and
   growth-design chunks give the shapes; traces lack deep lifecycle-email and
   onboarding-sequence craft (systematic lifecycle email is a named gap).
4. **Pricing research methodology.** Traces handle pricing-page honesty well; willingness-
   to-pay research, Van Westendorp, and packaging interviews are absent.
5. **Corpus skew toward SMB/founder scenarios.** Most traces assume a founder or small
   team with $1–50k budgets; mid-market/agency-white-label scenarios (Marketr's actual
   wedge) deserve a dedicated sub-batch.
6. **Design pillar not yet traced.** The training direction added design as a third
   pillar; this batch is marketing/growth only. Refactoring-ui chunks appear twice —
   design reasoning traces are a clear next batch.

**Generator:** `training/scripts/cx_{strategy,mission,playbook,content,content_b}.py`
(author modules) + `training/scripts/cx_build.py` (verify → dedupe → split → emit).
Reviewer: agent (Z7) + full manual repair pass on every rejection.
