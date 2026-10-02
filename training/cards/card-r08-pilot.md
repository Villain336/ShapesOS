# Data Card — R08 pilot batch (brief→strategy→concept→execution chains)

**Recipe:** R08 — brief → strategy → concept → execution chains
**Date pulled / generated:** 2026-09-26
**Output file:** `~/workspace/marketr/training/traces/traces-r08-pilot.jsonl`
**Generator:** `/tmp/r08/generate.py` (seeds in `/tmp/r08/seeds_1.py`, `seeds_2.py`, `seeds_3.py`; pools in `/tmp/r08/gen_pools.py`)
**Author/reviewer:** agent (Z7) + spot-check

## License classes
- `TIER-2-OPEN`: 440 traces — grounded in openly-licensed Tier 2 corpus chunks (Grayson Foundations of Digital Marketing, SBA marketing guides, Hopkins *Scientific Advertising*, Claude Hopkins' *My Life in Advertising* — all public-domain/CC0/CC-BY style sources used as ideas, never reproduced text).
- `TIER-1S-SYNTH`: 160 traces — original synthesis grounded in Marketr-original Tier 1S chunks (`1s-hubspot-academy`, `1s-cxl-blog`, `1s-demand-curve-blog`; CC-BY-4.0 Marketr syntheses). Traces are original team-authored reasoning, not reproductions of chunk text.
- No Tier 3 material used anywhere. No by-sa chunks cited.

## Source clusters + filters
Primary clusters (per assignment): `grayson-foundations-digital-marketing`, `sba-marketing-guides`, `my-life-in-advertising`, `1s-hubspot-academy`, `1s-demand-curve-blog`, `1s-cxl-blog`. (`calkins-business-of-advertising` sampled but not cited — see thin spots.)
Filter: chunk IDs cited only if the author actually read the chunk text during this task (57-chunk read palette; 43 cited). No blind citations.

## Recipe description
Grid over product type (30) × objective (acquire / convert / reactivate / launch / expand) × single channel × budget tier. Each trace: (1) a brief (objective with metric+baseline+target+timeframe, narrow audience, constraints incl. budget and approval-gate rules); (2) strategist reasoning in the Chief Strategy Agent's mandatory order — positioning (one-sentence wedge) → audience → offer (value-equation lens) → channel economics (ONE channel, modeled CAC/payback/what-must-be-true) → measurement (one metric that matters); (3) a creative platform; (4) three concrete channel executions consistent with the strategy. Includes 4 redirect families (40 traces) where the expert declines the brief's tactic and redirects to the structural fix first (negative-trace behavior). All numbers labeled illustrative estimates; all brand scenarios synthetic.

## Counts
- Total: **600** traces, `trace-r08-000001` … `trace-r08-000600`
- Train: **510** (51 families) / Held-out: **90** (9 families) — split assigned by whole `duplicate_family`, zero cross-split family leaks (verified)
- Markets: US 420 / UK 60 / CA 60 / AU 60
- Avg length: ~469 words reasoning_trace, ~286 words output
- Dedupe: sha256 over canonical reasoning_trace+output; 600/600 unique

## Verifier results
Pass: **600** / Reject: **0**.
Per-trace verifier `r08-specific-insight+measurable-objective+strategy-execution-consistency` checks:
1. specific-insight present (>120 chars, verbatim seed insight, no generic markers like "run targeted ads"/"increase awareness")
2. measurable-objective (metric, baseline, target, timeframe all present in brief.objective)
3. strategy-execution-consistency (executions run via the chosen channel, echo wedge/audience; redirect families noted)
4. corpus-citations (all chunk IDs from the read palette)
5. hard-rules (autopilot/propose/honest-labeling addressed; estimates labeled; no invented proof)
6. voice (no emoji, no hype adjectives — banned-word scan)

Top rejection reasons: none (two generator bugs caught and fixed pre-write: metric/baseline mismatch on 2 redirect seeds; duplicated timeframe phrasing in launch objectives).

## Chunk-usage summary
43 distinct chunks cited across 600 traces (~2,580 citations). Heaviest: `1s-demand-curve-blog#1` (channel menu, 190), `#4` (retention/leaky bucket, 130), `#3` (unit economics, 120); `grayson#234` (email ROI, 120); `1s-hubspot-academy#2` (topic clusters, 100); `1s-cxl-blog#4` (what to test, 90); `my-life-in-advertising#229` (old-customer profit, 90); `scientific-advertising#50` (one-reading rule, 80). Lightest: `grayson#377` (vanity metrics), `#125` (curated content), `sba#108` (marketing plan) at 10 each.

## Thin spots noticed (for the M9 source-research sweep / future batches)
1. **Calkins (business of advertising) unused for R08** — its chunks are advertising-history/industry-structure; little directly applicable to brief→execution chains. Could ground creative-originality arguments (e.g. `#346` "be different") in future creative-platform-heavy recipes.
2. **Modern paid-media tactical depth is thin** (matches constitution §6 gap #1): no open corpus for current Meta/Google Ads mechanics, so paid-channel traces lean on unit-economics reasoning rather than practitioner method. `1s-meta-blueprint`/`1s-google-skillshop` chunks exist but were outside this batch's assigned clusters.
3. **Pricing/packaging as offer lever** is under-cited (only via `1s-demand-curve#5`); the corpus lacks an open rigorous pricing-research treatment (constitution §6 gap #5).
4. **B2B/enterprise motion is thin** — all 30 product types skew SMB/DTC/local; ABM and sales-led growth have no grounding chunks in the assigned clusters.
5. **Lifecycle/retention craft beyond win-back** (onboarding drips, activation modeling) rests on 3 chunks; deeper coverage would strengthen convert/reactivate traces.
6. Within-batch repetition risk: 10 variants per family share one insight verbatim — fine for SFT (family-grouped splits), but a future batch should add more seeds rather than more variants per seed.
