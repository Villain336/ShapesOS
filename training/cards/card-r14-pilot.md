# Data Card — R14 pilot batch: voice-of-customer → copy

**Recipe:** R14 (voice-of-customer → copy). Each trace: synthetic review set (9 reviews,
labeled synthetic, varied voices) → extraction reasoning (jobs-to-be-done, ranked benefits,
objections with grounded answers, steal-worthy customer phrases, explicit anti-claims) →
positioning statement → ads/landing copy built ONLY from the review set, with an explicit
claim→review citation map in `validation.checks`.

**License classes:** TIER-2-OPEN (240 traces, grounded in openly-licensed corpus chunks:
Scientific Advertising, My Life in Advertising, Scott's Psychology of Advertising,
marketing-without-money, NSCC intro marketing, Wikipedia marketing clusters BY-SA) and
TIER-1S-SYNTH (180 traces, grounded in 1s-* Tier 1S synthesis chunks:
1s-reddit-for-business, 1s-youtube-creator-academy). No Tier 3, no pirated material.

**Date pulled:** 2026-09-26. Corpus: manifest v7 (`data/corpus/main/chunks.jsonl` 2,523 chunks,
`data/corpus/by-sa/chunks.jsonl` 155 chunks).

**Source clusters + filters:** All cited chunk IDs were read (skimmed via grep/python) before
use — no blind citation. Cited chunks and what they ground:
- `scientific-advertising#14/#15/#70` — interview customers before writing; sell what they want
- `scientific-advertising#43/#46/#48/#50` — specificity beats superlatives; definite statements
  accepted at full weight; learn appealing claims by tests
- `scientific-advertising#77` — study the typical individual using a rival brand
- `my-life-in-advertising#124` — no reckless claims; risk-reversal appeal ("try it; if it fails it is free")
- `scott-psychology-of-advertising#260` — reliability is the #1 ad-response driver; testimonials noticed
- `marketing-without-money#32` — referral/word-of-mouth mechanics
- `nscc-intro-marketing#2` — promotion includes customers' own reviews
- `wikipedia-marketing-clusters#82` (BY-SA, ideas only, never reproduced) — social media as market
  intelligence: analyze customer voices
- `1s-reddit-for-business#7` — comment quality/sentiment as the leading indicator a message lands
- `1s-youtube-creator-academy#0/#9` — one-sentence audience promise; re-verify against the actual audience

**Constitution:** `global hard rules` on every trace — honest labeling (reviews marked
[SYNTHETIC]; copy marked DRAFT for approval), propose/execute (copy is a draft, never
presented as published), no invented proof (invented stats/ratings rejected by the verifier).

**Counts:** 420 traces written — 350 train / 70 held-out. Split assigned by whole
`duplicate_family` (30 families; 5 held-out: ember-roast-coffee, inboxcalm-saas,
joey-carrier, ledgerly-b2b, ridgeline-socks) — no family leaks across the split.
Dedupe via sha256(content_hash) of reasoning_trace+output (0 natural duplicates found).

**Verifier:** `r14-faithfulness-claim-to-review-mapping`. 450 candidates generated → 420
passed, 30 rejected. Rejection reasons (all 30 were deliberately fault-injected candidates,
proving each rule fires — no genuine candidates were lost to false rejects after alignment):
- invented statistic/proof in output ("10,000 happy customers" / "4.9 stars"): 8
- missing synthetic label on review set: 8
- citation to unknown review id (R99): 7
- untraceable claim in output (injected off-set claim): 7

The verifier also enforces: 5–12 reviews per set; every check cites a real review ID;
every check's text appears in the output; every factual sentence in the output matches a
cited claim/answer/phrase/positioning; no hype adjectives (per constitution voice restraint);
no emoji in user-facing copy.

**Chunk-usage summary:** 16 distinct chunks cited across the batch; usage is spread
(44–128 cites each), heaviest on the 1s-* sentiment/audience chunks and the
specificity cluster (scientific-advertising#43/#46/#48).

**Thin spots noticed:**
1. **No real VoC corpus — the load-bearing gap.** The corpus has no actual customer-review
   corpora (no Amazon reviews, no G2/Capterra, no review-site dumps). Every review set in
   this batch is synthetic, authored from consumer-psychology and advertising principles in
   the sources. Synthetic sets teach the *reasoning pattern* (extract → cite → refuse
   ungrounded claims) but not the messiness of real VoC: slang, typos, contradictory
   experiences, review-bombing, fake-review tells. A future sweep should license or scrape
   (ToS-permitting) a real review corpus; until then R14 traces are reasoning-pattern
   training, not VoC-distribution training.
2. **Objection coverage is shallow by construction.** Each family has 4 authored objections;
   real review sets surface objections the brand never anticipated. The traces model
   "refuse to answer ungrounded objections" correctly, but the objection *discovery* skill
   is under-trained.
3. **Sentiment skews positive.** Real sets for struggling products run complaint-heavy;
   only ~1/3 of traces here lead with a complaint-dominant mix. Future batches should
   include turnaround/negative-dominant sets (copy that addresses a real reputation problem).
4. **No multi-language VoC.** All traces en/US. The recipe generalizes, but non-English
   review idiom is untested.
5. **B2B review voice is thin.** Only 3 of 30 families are B2B services; B2B VoC (longer,
   ROI-framed, multi-stakeholder) deserves its own sub-batch.

**Generator:** `~/workspace/r14_gen.py` (reproducible; seed 20260926). Reviewer: agent (Z7) + spot-check.
