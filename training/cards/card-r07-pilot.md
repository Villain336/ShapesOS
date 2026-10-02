# Recipe Card — R07 Pilot: Headline & Hook Pairs

**Recipe:** R07 — headline & hook pairs (landing heroes, email subject lines, paid/social hooks, awareness-stage matches)
**Date pulled / built:** 2026-09-26
**Records:** 400 (`traces-r07-pilot.jsonl`, verified 400 lines via `wc -l`)
**Split:** 340 train / 60 held-out, assigned by whole `duplicate_family` (85 train families / 15 held-out families; no family crosses splits)
**License classes:** TIER-2-OPEN (200 records — landing hero duels + paid/social hooks, citing public-domain clusters only) and TIER-1S-SYNTH (200 records — email subjects + awareness-stage matches, citing the Copyhackers synthesis cluster alongside public-domain material; strictest license wins on mixed citations)
**Origin:** synthetic (100 fictional campaign briefs; all brand names, numbers, prices, and proof are synthetic scenario inputs, never real-world claims)

## Source clusters and filters

Corpus: `~/workspace/marketr/data/corpus/main/chunks.jsonl` (2,523 chunks). Only chunks actually read during the 2026-09-26 digest were cited; every cited ID was existence-checked against the corpus at build time.

| Cluster | Chunks in corpus | Chunks cited | Citations |
|---|---|---|---|
| scott-psychology-of-advertising | 452 | 0 (read for theory; headline-specific chunks were thin) | — |
| scientific-advertising | 126 | 13 | 586 |
| my-life-in-advertising | 306 | 7 | 213 |
| 1s-copyhackers-blog | 6 | 4 | 300 |

24 distinct chunks cited, 1,099 total citations (~2.75 per trace). Top cited: `scientific-advertising#29` (100), `1s-copyhackers-blog#4` (100), `#1` (100), `#3` (100), `scientific-advertising#31` (80), `#33` (80), `#50` (60), `my-life-in-advertising#263` (60), `#214` (53), `scientific-advertising#66` (53), `#34` (40), `scientific-advertising#110` (33).

## Recipe description

Each of 100 campaign briefs (local services, DTC, SaaS, apps, professional services, health, education) yields 4 traces, one per slot:

1. **T1 — Landing hero mechanism duel.** 5 headline variants, each running on a different named mechanism (specificity, curiosity-gap, headline-hails, benefit-first, proof-in-headline, mechanism-naming, desire-over-fear, plain-salesmanship, irresistible-offer, test-verdict). Winner picked with a voice-grounded rationale.
2. **T2 — Email subject lines.** 5 subjects; in 25 of 100 families one slot is a sensational clickbait variant explicitly marked `rejected` with a voice/trust rationale (never the winner). Curiosity or clarity, never clickbait.
3. **T3 — Paid/social hooks.** 4 hook variants; in 35 of 100 families a `MODELED A/B RESULT` block names two finalists with simulated CTRs, labeled simulated/illustrative with a `p<0.05 (simulated)` significance note. Where the winner runs on `test-verdict`, the rationale practices Hopkins-style humility: judgment proposes, keyed returns dispose.
4. **T4 — Awareness-stage match.** 5 variants, one per Schwartz stage (unaware → most-aware); the winner is the variant matching the brief's stage, each variant carrying its stage's mechanism. Teaches stage discipline over cleverness.

Every trace: brand voice card in the brief constraints (16 voices), 3–6 variants (4–5 in practice), mechanism named per variant, winner consistent with voice, reasoning trace with explicit Step 1 (awareness) → Step 4 (verdict) structure. Winner position is rotated across traces to avoid first-position bias (observed: 68/145/82/65/40 across positions 1–5).

## Verifier results

Verifier: `r07_build/r07_verify.py` — checks brand voice card present, winner consistent with voice (rationale names the voice), no hype adjectives in endorsed copy, no emoji, A/B numbers labeled simulated with significance note, every variant's mechanism from the taxonomy, license/chunk-tier consistency, split integrity, sequential IDs, unique content hashes.

- **PASS: 400 / REJECT: 0**
- Families leaking across splits: 0
- Duplicate content hashes: 0
- Record IDs: `trace-r07-000001` … `trace-r07-000400`, sequential, no gaps
- Template-collision sweep (doubled phrases, bad articles): 0 remaining after fixes

## Rejection reasons during the build (fixed, not shipped)

| Reason | Count | Fix |
|---|---|---|
| `rationale-ignores-voice` | 110 | T4 and test-verdict rationales did not name the voice; appended voice-consistency sentence |
| doubled template phrases ("in one visit in one visit", "for agencies for agencies", "method method") | 5+32 | collision-aware `fill()` dedup; renamed "Reassuring parent-voice" → "Reassuring parent" |
| ungrammatical article ("a AC", "a mid-July breakdowns") | 1 class | article-aware `a_product` slot |
| backwards hail ("{desire}, {aud_short}") | 1 class | pattern changed to "{aud_short_cap}: {desire_short}" |
| winner always Variant 1 | 400 | winner position rotated per trace |
| generic weaknesses contradicting the mechanism | 400 | per-mechanism weakness pools |

## Chunk-usage summary

Headline theory grounded in `scientific-advertising` (headlines must hail the right reader; specificity beats adjectives; curiosity must pay off) and `my-life-in-advertising` (plain salesmanship; desire over fear; risk-reversal offers). Email/subject and awareness-stage material grounded in the `1s-copyhackers-blog` synthesis (curiosity vs clarity; subject's job is the open; stage-matched messaging). Keyed-testing tradition (Hopkins) grounds the modeled A/B blocks and test-verdict rationales.

## Thin spots

- The Copyhackers cluster is only 6 chunks, so modern email-subject and lifecycle-email depth is thin; the same 4 chunks are cited 300 times.
- Classical sources are strong on print headlines, specificity, curiosity, offers, and keyed testing but thin on current paid-social hook formats, platform character constraints, B2B SaaS headline conventions, and statistically rigorous digital experimentation.
- Scott's corpus is large (452 chunks) but only a few chunks discuss headlines directly; none were cited. Modern brand-voice systems and contemporary claim-compliance depth are thin across all clusters.
- All A/B numbers are simulated by construction; no trace contains real measured performance data.

## Build artifacts

- Generator: `~/workspace/marketr/training/r07_build/r07_generate.py`
- Data (voices, mechanisms, patterns, 100 briefs): `~/workspace/marketr/training/r07_build/r07_data.py`
- Verifier: `~/workspace/marketr/training/r07_build/r07_verify.py`
- Output: `~/workspace/marketr/training/traces/traces-r07-pilot.jsonl`
