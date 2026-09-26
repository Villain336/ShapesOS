# M5 — Modeled difficulty engine: the eval bar

**Model:** `KD = 0.50 × linkStrength + 0.30 × authorityGap + 0.20 × serpCrowding`
(see `lib/intelligence/difficulty/model.ts`). Output is always
`{ estimate, uncertaintyBand: [lower, upper], inputsProvenance, modelVersion }`
— never a bare score.

## The bar (gate.ts `EVAL_BAR`)

On a held-out set of **≥ 50 keywords** spanning the difficulty deciles, with
**DataForSEO `labs/bulk_keyword_difficulty`** ($0.132/1K) as the paid
reference, the model PASSES only if **all** hold:

| Criterion | Bar | Why |
|---|---|---|
| MAE vs. vendor | ≤ 15 (0–100 scale) | "within 15% of vendor" |
| Spearman rank correlation | ≥ 0.70 | ordering is what keyword-research UX shows; a misordering model is worse than useless |
| Uncertainty-band coverage | ≥ 70% | the band is the honest-attribution contract — precise but miscalibrated fails |

## The gate

`shouldReplaceVendor()` opens **only** when `eval-state.json` records a PASS
for the **current** `MODEL_VERSION` (`m5-v1`). A model bump automatically
closes the gate until re-evaluated. Until then:

- every user-facing path uses the **vendor** difficulty call;
- the UI shows the modeled value **marked EXPERIMENTAL** alongside the vendor value.

The vendor call site the model slots behind: `lib/providers/dataforseo.ts`
`competitionToDifficulty()` → consumed via `getSeoProvider().keywordIdeas()`
in `lib/keywords/research.ts` (marked with an `M5-GATE` comment).

## Running the eval

```bash
# Fixture mode — CI-safe, no API keys, no network (M7 runs this):
npx tsx scripts/eval-difficulty.mts

# Live mode — paid reference, ~$0.01 for the 60-keyword held-out set:
npx tsx scripts/eval-difficulty.mts --live --workspace <id>
# Record the result (the ONLY writer of eval-state.json):
npx tsx scripts/eval-difficulty.mts --live --workspace <id> --write-state
```

Live mode needs `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD` (reference),
a configured SERP vendor (M6), and optionally `OPENPAGERANK_API_KEY` /
`MOZ_ACCESS_ID`+`MOZ_SECRET_KEY` (authority inputs degrade gracefully
without them — which is itself part of what's evaluated).

## Authority inputs

| Source | Free tier | Key env | Notes |
|---|---|---|---|
| Open PageRank | 30k lookups/mo, no card | `OPENPAGERANK_API_KEY` | `API-OPR` header |
| Moz Links API | 2,500 rows/mo | `MOZ_ACCESS_ID` / `MOZ_SECRET_KEY` | HTTP Basic |
| CC hyperlink graph | $0/query | — | one-time ~16GB download → local SQLite index; see `scripts/cc-graph-download.sh`. CC weight **capped at 0.50** (quarterly, domain-level, no anchors) |

All three adapters are graceful-without-credentials: missing keys reduce
confidence and widen the band — they never throw, and the model never
invents authority.
