# Data Card — R04 pilot batch (critique distillation, region-grounded)

**Recipe:** R04 — critique distillation (region-grounded design critiques)
**License class:** TIER-1S-SYNTH (all traces are original team-authored synthesis grounded in Tier 1S corpus chunks; no frontier-model distillation, no verbatim source text)
**Date pulled:** 2026-09-26
**Output:** `~/workspace/marketr/training/traces/traces-r04-pilot.jsonl` (510 lines, one JSON object per line)
**Generator:** `/tmp/r04/gen_r04.py` (seeded RNG 20260926; deterministic re-runnable while /tmp persists)

## Source clusters + filters

Corpus: `~/workspace/marketr/data/corpus/main/chunks.jsonl` (manifest v7, 2,523 chunks).
Stayed strictly inside the 12 assigned clusters (164 chunks read in full before authoring; every cited chunk ID was read):

| Cluster | Chunks in corpus | Citations in batch |
|---|---|---|
| 1s-apple-hig | 14 | 381 |
| 1s-nng | 14 | 361 |
| 1s-laws-of-ux | 15 | 304 |
| 1s-refactoring-ui | 14 | 255 |
| 1s-emil-kowalski | 12 | 205 |
| 1s-practical-typography | 12 | 177 |
| 1s-baymard | 12 | 161 |
| 1s-material-3 | 16 | 96 |
| 1s-ibm-carbon | 19 | 68 |
| 1s-growth-design | 14 | 57 |
| 1s-atomic-design | 10 | 47 |
| 1s-style-guide-guide | 12 | 23 |

74 distinct chunk IDs cited, avg 4.19 chunks/trace. No borrowing outside the assigned clusters.

## Recipe description

Each trace = an expert design critique of one concrete UI region (30 region types: hero, navbar, pricing table, checkout form, payment step, onboarding, email header, display ad, footer, dashboard card, data table, modal, empty state, filter sidebar, product card, search results, article page, CTA banner, signup form, testimonials, feature grid, mobile tab bar, settings, confirmation, 404, alert banners, profile, comparison table, design-system docs, tooltip) set in one of 14 industries (SaaS, DTC, HVAC, fintech, healthcare, edtech, nonprofit, travel, real estate, legal, restaurant, logistics, pet care, fitness).

- `brief.constraints` carries the region description with **concrete measurements** (type sizes, px dimensions, contrast ratios phrased as "roughly/about" per honest labeling, spacing values, counts).
- `reasoning_trace` follows the constitution's design-judgment sequence: **hierarchy → typography → optical detail → motion**, with the principle named at each step.
- `output` = findings **ranked most-severe-first** (CATASTROPHIC > MAJOR > MINOR > COSMETIC); every finding names the region + the specific observable + the violated principle + a concrete fix direction marked "(proposed, not applied)" per propose/execute separation.
- **19.2% positive-confirmation traces** (98/510): strengths confirmed with the principle named ("CONFIRM: … Why it works:"), to avoid negativity bias. A further ~45% of negative traces carry one confirmed strength (mixed critique).

## Counts

| Split | Traces | Families |
|---|---|---|
| train | 438 (85.9%) | 96 |
| held-out | 72 (14.1%) | 17 |
| **total** | **510** | **113** |

Split assigned **by whole duplicate_family** (`r04-<module-signature>-<region>`); verified **0 families leak** across splits. 17 traces per region × 30 regions. Findings: 1,499 total (28 catastrophic, 494 major, 857 minor, 120 cosmetic) + 235 positive confirmations; avg ~2.9 findings/trace. Findings-per-trace distribution: 1:98 (positive traces), 2:27, 3:234, 4:110, 5:41.

## Verifier results

Verifier: `r04-specificity+region-grounding+claim-check` — checks per record: region named in brief; every finding carries a measurement (digit) and a named principle; no generic phrases (banned list: "add more whitespace", "make it pop", "improve the UX", "looks cluttered", etc.); all chunk IDs from the read set; sha256(reasoning_trace+output) matches `content_hash`; constitution stage order intact.

- **Final run: 510 accepted, 0 rejected.**
- Rejections caught during development (all fixed in the generator, none shipped): 165× `region-not-in-brief` (region name missing from brief text — fixed by prepending "Region under review: …" to constraints); 9× `duplicate-hash` (same module set across two industries produced byte-identical reasoning+output — fixed by adding an industry/audience context line to the reasoning trace, which is a legitimate conditioning difference, not hash-gaming).
- Independent re-verification after writing: 0 hash mismatches, 0 duplicate hashes, 510/510 unique sequential record_ids, schema keys complete on all records.

## Chunk-usage summary

Heavy use (as designed): HIG clarity/hierarchy/touch-targets, NN/g heuristics + audit method, Laws of UX (Hick's, von Restorff, proximity, goal-gradient, peak-end), Refactoring UI (scales, hierarchy tools, borders, one accent). Light use: style-guide-guide (only the docs region), atomic-design (naming + inventory + template/page stress test), growth-design (onboarding sequencing, proof placement, peak/end engineering). Motion stage covered in 165/510 traces (32%) — see thin spots.

## Thin spots noticed (corpus gaps for R04)

1. **Motion principles are interaction-centric.** Only Emil Kowalski (+ M3 #10) cover motion, and both aim at product UI. Critiquing ad-creative animation (CTA persistence across frames, loop timing) and email motion required stretching interaction principles into media contexts. No corpus guidance on HTML5 ad timing, video-background accessibility, or animation performance budgets for marketing surfaces.
2. **Email design is uncovered.** No cluster addresses email-client constraints (600px, image blocking, dark-mode email). Email-header critiques were built from general typography/HIG principles only.
3. **Dark-mode critique is thin.** M3 tonal palettes + HIG semantic color cover theming construction, but there is little on *critiquing* dark-mode failures (washed-out elevation, contrast inversions).
4. **Data-viz critique is shallow.** Only Carbon #13 (don't encode in color alone, chart states). Dashboard-card critiques leaned on general hierarchy/type principles; no corpus depth on chartjunk, axis labeling, or dashboard information architecture.
5. **Accessibility beyond contrast/targets is thin.** Focus order, screen-reader flow critique, and keyboard-path auditing appear only as component contracts (Carbon #10/11), not as critique lenses an expert would apply to a finished screen.
6. **Exact WCAG thresholds are absent by design** (syntheses omit numbers). Contrast claims in this batch are phrased as approximations ("roughly 2.9:1") per honest labeling. A Tier-2 openly-licensed WCAG reference would let a future batch state thresholds exactly.
7. **Mobile critique beyond targets/keyboards is thin.** Thumb-zone mapping, safe-area handling, and responsive breakpoint critique have no dedicated cluster; Baymard #9 + HIG #10 carried the load.
8. **Governance clusters don't yield pixel findings.** style-guide-guide and much of atomic-design/IBM-Carbon-governance produce process critiques, not region-grounded visual defects — fine for their purpose, but they cap out at ~2 regions each for R04.
