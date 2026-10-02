# Data Card — R09 compliance-aware copy (pilot)

- **Date pulled / generated:** 2026-09-26
- **Recipe:** R09 — compliance-aware copy
- **Output:** `training/traces/traces-r09-pilot.jsonl`
- **License classes:** {'TIER-2-OPEN': 105, 'TIER-1S-SYNTH': 195}
  - TIER-1S-SYNTH: traces grounded in 1s-* academy synthesis chunks (traces are original synthesis, never verbatim Tier 1 text).
  - TIER-2-OPEN: traces grounded in openly-licensed material — public-domain classics (Hopkins, Calkins, Scott) and google-search-central (Tier 1 CC-BY per corpus manifest; treated as TIER-2-OPEN derivation).
  - No Tier 3, no pirated sources. No frontier-model distillation.

## Recipe description
For each risky marketing claim across regulated/risky categories, the trace records (1) the claim + context in `brief`, (2) rule analysis in `reasoning_trace` identifying the specific rule risk with a real rule label (e.g., FTC substantiation doctrine, FTC Endorsement Guides 16 CFR Part 255, ASA CAP Code Section 12 / rule 3.7, UCPD 2005/29/EC, Competition Act s.74.01, ACL s.18), grounded to corpus chunks actually read, and (3) a compliant rewrite in `output` that preserves selling power. Includes "actually fine" traces (verdict COMPLIANT AS WRITTEN) to avoid over-refusal bias.

## Counts
- **Total traces:** 300 (target ~300)
- **Train:** 252 | **Held-out:** 48 (split assigned by whole `duplicate_family`, ~15% families held out)
- **Categories:** health, finance, beauty, testimonials, free, urgency, green, price, superiority, native, platform
- **Markets:** US, UK, EU, CA, AU (every trace tagged; jurisdiction differences noted in reasoning)
- **"Actually fine" traces:** 50
- **Duplicates skipped (sha256):** 0

## Verifier results
- **Verifier:** r09-market-tag+rule-labels+rewrite-quality
- **Passed:** 300 | **Rejected:** 0
- **Top rejection reasons:** none

## Chunk usage (chunks actually read; counts = traces citing)
- `my-life-in-advertising#259`: 100
- `calkins-business-of-advertising#20`: 60
- `1s-copyhackers-blog#2`: 60
- `scientific-advertising#45`: 55
- `my-life-in-advertising#124`: 50
- `1s-cxl-blog#4`: 45
- `google-search-central#70`: 40
- `1s-copyhackers-blog#4`: 40
- `calkins-business-of-advertising#464`: 40
- `google-search-central#81`: 40
- `1s-reddit-for-business#1`: 30
- `1s-baymard#11`: 15
- `1s-baymard#8`: 10
- `scott-psychology-of-advertising#260`: 5
- `google-search-central#56`: 5
- `google-search-central#68`: 5

## Thin spots (binding — read before scale-up)
1. **No dedicated FTC/ASA doctrine source in the corpus.** There is no FTC Endorsement Guides, Green Guides, .com Disclosures, CAP Code, UCPD, Competition Act, or ACL source in corpus v7. Rule labels in this batch are standard compliance knowledge grounded to the closest adjacent chunks (e.g., `calkins-business-of-advertising#464` for "free" doctrine, `1s-cxl-blog#4` for honest urgency, `1s-reddit-for-business#1` for endorsement authenticity). Every reasoning trace carries an explicit corpus-coverage note saying so. **At scale-up, augment the corpus with openly-licensed compliance sources** (FTC business guidance is US public-domain; ASA/CAP publishes guidance; ACCC and Competition Bureau publish guides) and re-ground or regenerate this batch.
2. **Platform ad-policy depth is thin.** Only adjacent chunks (`google-search-central#70` misleading functionality) support the platform-policy traces; Meta/TikTok policy specifics are stated as standard policy knowledge. Same augmentation need.
3. **Jurisdiction nuance is rule-name level, not case-law level.** No invented case law or statute citations were used (verifier-checked); deeper precedent grounding awaits corpus augmentation.
