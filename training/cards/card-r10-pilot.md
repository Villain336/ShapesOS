# Data Card — R10 pilot batch (measurement with ground truth)

**Recipe:** R10 — measurement with ground truth (simulated marketing-measurement scenarios with planted, labeled-simulated ground truths; reasoning traces show the math step by step; outputs give exact numeric answers + recommendations).
**Date pulled / generated:** 2026-09-26
**Generator:** `~/workspace/marketr/training/r10-generator.py` (deterministic, seeded RNG; verifier runs in-generator with rejection-resample)
**Output:** [traces-r10-pilot.jsonl](../traces/traces-r10-pilot.jsonl) — 300 records, verified line count 300

## License classes
| Class | Records | Basis |
|---|---|---|
| TIER-1S-SYNTH | 220 | Traces grounded in Tier 1S corpus chunks (Marketr's own CC-BY-4.0 syntheses of platform curricula) |
| TIER-2-OPEN | 80 | Traces grounded in Grayson Foundations in Digital Marketing (CC BY 4.0) chunks |

All records: `origin: synthetic`, `reviewer_type: agent (Z7) + spot-check`, `constitution_section: global hard rules`, `language: en`, `market: US`, `created_at: 2026-09-26`.

## Source clusters + filters
Primary clusters: `1s-google-skillshop`, `1s-meta-blueprint`, `1s-amazon-ads-learning`, `1s-ahrefs-blog`, `1s-tiktok-academy`, `1s-linkedin-marketing-labs`, `grayson-foundations-digital-marketing` (analytics/KPI/attribution sections).
Filter: only the 18 chunk IDs actually read in full/skim were cited (no blind citation). Chunks read: `1s-meta-blueprint#3,#6,#7`; `1s-google-skillshop#5,#7`; `1s-tiktok-academy#5`; `1s-linkedin-marketing-labs#5`; `1s-ahrefs-blog#6`; `1s-amazon-ads-learning#6,#8`; `grayson-foundations-digital-marketing#375,#378,#387,#397,#406,#408,#412,#417`.

## Counts
- **Total: 300** (15 scenario families × 20 instances)
- **Train: 260** (13 families) / **Held-out: 40** (2 families: `r10-funnel-cvr`, `r10-tt-window`)
- Split assigned by whole `duplicate_family` — no family appears in both splits.
- Dedupe: `sha256(reasoning_trace + "\n" + output)` unique across all 300 (verified).
- `record_id`: `trace-r10-000001` … `trace-r10-000300`, sequential, train first.

Scenario families (metric in parentheses): `r10-ab-landing-cvr` (CVR lift), `r10-ab-email-ctr` (CTR lift, send-day confounding), `r10-geo-holdout` (revenue lift, diff-in-diff), `r10-conversion-lift` (incremental ROAS), `r10-attribution-realloc` (position-based credit → budget), `r10-branded-cannibal` (harvest rate → incremental ROAS), `r10-channel-mix` (marginal-CAC equalization), `r10-amazon-buckets` (branded/category/conquesting split), `r10-cac-payback` (payback, LTV:CAC), `r10-seo-decomp` (brand vs non-brand growth), `r10-funnel-cvr` (stage rates) [held-out], `r10-hygiene-dedupe` (duplicate-conversion correction), `r10-tt-window` (attribution-window reconciliation) [held-out], `r10-b2b-pipeline` (pipeline CAC), `r10-ntb-display` (new-to-brand share).

## Verifier
`r10-numeric-tolerance+honest-labeling+realism` applied to every candidate in-generator:
1. Exact numeric answer within ±10% of planted simulated ground truth (recomputed, not eyeballed; resample on miss).
2. Honest labeling: scenario framed simulated; every output number carries a simulated/modeled/estimated tag; banned phrases (`measured`, `real-world`, `actual results`, `in production`, `case study`, …) rejected.
3. ≥1 realism complication (noise, seasonality, confounding, missing data) present and handled in the trace.
4. Recommendation follows the math (decision keyword checked); spend scenarios stop at the approval gate (propose/execute separation, autopilot-never-buys).

**Final run:** 300/300 written, all verifier-pass. Rejections during final run (all resampled clean): `t_geo_holdout` NUMERIC ×2, `t_funnel_cvr` NUMERIC ×1.
Calibration notes (earlier runs, fixed before final): (a) ±10% relative tolerance on small lifts was statistically unachievable at small samples — fixed by scaling simulated samples to realistic big-test sizes (diagnosed via empirical-vs-theoretical variance check); (b) two deterministic templates produced hash collisions — fixed by parametrizing per-instance inputs; (c) one funnel record claimed planted truth was "inside the modeled range" when it sat just outside — fixed by reporting the corrected activation estimate with a proper 95% CI.

## Chunk-usage summary (records citing each chunk)
| Chunk | Records |
|---|---|
| 1s-google-skillshop#7 | 120 |
| 1s-meta-blueprint#6 | 100 |
| 1s-amazon-ads-learning#6 | 60 |
| 1s-amazon-ads-learning#8 | 60 |
| 1s-meta-blueprint#3 | 40 |
| grayson-foundations-digital-marketing#375 | 40 |
| grayson-foundations-digital-marketing#378 | 40 |
| 1s-meta-blueprint#7 | 20 |
| 1s-google-skillshop#5 | 20 |
| 1s-tiktok-academy#5 | 20 |
| 1s-linkedin-marketing-labs#5 | 20 |
| 1s-ahrefs-blog#6 | 20 |
| grayson-foundations-digital-marketing#387 | 20 |
| grayson-foundations-digital-marketing#397 | 20 |
| grayson-foundations-digital-marketing#406 | 20 |
| grayson-foundations-digital-marketing#408 | 20 |
| grayson-foundations-digital-marketing#412 | 20 |
| grayson-foundations-digital-marketing#417 | 20 |

## Thin spots noticed (for future R10 scale-up)
1. **No corpus chunk teaches the statistics.** z-tests, CIs, delta method, diff-in-diff, stratification, inverse-variance weighting — all implemented from first principles in the generator; the corpus only grounds "test one variable at a time," "kill rules in writing," and "lift studies for truth." A Tier-2 openly-licensed experimentation/statistics source would strengthen grounding.
2. **Incrementality is one bullet.** Only `1s-meta-blueprint#6` mentions lift studies; no geo-experiment design or holdout mechanics in the corpus.
3. **No MMM / media-mix modeling content** anywhere in the corpus — out of scope for this batch, would need new sources.
4. **Grayson attribution chunks are pedagogical** (H5P exercises); good for definitions, thin for real reallocation math.
5. **`grayson#451` (predictive analytics) is a paragraph** — deliberately not used; insufficient to ground forecasting traces.
6. **Payback/LTV math extends beyond the chunks.** Grayson defines CAC and ROAS/ROI formulas; payback period and LTV:CAC bars are generator-side extensions, labeled as such.
7. **Sample-size/power planning absent** from corpus — sample sizes were set from statistical requirements, not from a cited chunk.
8. Short 1s chunks (`1s-tiktok-academy#5`, `1s-linkedin-marketing-labs#5`) carry limited measurement content; those traces lean on general KPI chunks.
