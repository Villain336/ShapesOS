# Marketr Training Data — Trace Dataset Plan (Pilot)

**Status:** PILOT RUNNING (started 2026-09-26)
**Owner:** Tico / Z7
**Source inputs:** `~/workspace/user/files/` (data plan xlsx, source catalog xlsx, source guide PDF, `sources_manifest.jsonl`), corpus manifest v7 (`~/workspace/marketr/data/corpus/`), `EXPERT-CONSTITUTION.md` v1

## Scope decision (read first)

Tico's data plan describes a full lab-scale program: Stage A continued pre-training (150B tokens), Stage B SFT (1.5M examples), Stage C preference (400K pairs), Stage D RL (200K episodes).

**What is STARTING now:** the SFT trace-dataset pilot — step 2 of the approved Marketr training route (corpus → reasoning traces → fine-tune small open model → RAG stays for fresh facts). This matches Build Plan Phase 2 in the data plan itself: *"Small, high-quality pilot… Build a useful baseline and measure errors by task category."*

**What is PARKED and why:**
- **Stage A (continued pre-training, 150B tokens):** lab-scale. Roughly tens of thousands of H100-hours and $60K+ in compute for a 30B-class model, plus months of engineering. It is not the approved route, not the budget, and not needed for Marketr — the base model already knows language; Marketr needs *marketing judgment*, which is an SFT problem, not a pre-training problem. Revisit only with dedicated funding.
- **Stage C (preference pairs):** derived later from Stage B outputs (best-vs-worst pairs per recipes R01/R04). Not started until the SFT pilot passes evals.
- **Stage D (RL environments):** later. Render-in-the-loop and tool-use RL need the SFT model first.

## Pilot target

~2,000–5,000 high-quality SFT traces across priority recipes. Eval-gated: nothing scales until the pilot beats the baseline on held-out evals. (Full-plan buckets — 1.5M SFT examples etc. — are the *program* target, not the pilot.)

## Recipe priority for Marketr (marketing/growth first, design second)

| Priority | Recipe | Bucket | Notes |
|---|---|---|---|
| 1 | R08 brief→strategy→concept→execution chains | Campaign strategy | Least covered skill in public data (H05); core Marketr moat |
| 2 | R04 critique distillation (region-grounded) | Design critique & audits | Seed from UICrit-style; penalize generic feedback |
| 3 | R07 headline & hook pairs | Copywriting | Outcome labels where available; condition on brand voice |
| 4 | R14 voice-of-customer → copy | Copywriting | Faithfulness check: every claim traceable to source |
| 5 | R10 measurement with ground truth | Marketing analytics | Simulated campaigns, exact numeric answers; verifiable |
| 6 | R09 compliance-aware copy | Compliance & ethics | FTC/ASA rule labels; tag each example with market |
| 7 | Constitution exemplars (expand the 12) | Strategy agents | Chief Strategy Agent, mission planner, playbook generator reasoning traces |
| 8 | R03 screenshot→code inversion (later) | Web/UI generation | Design pillar; needs render pipeline — phase 2 of pilot |

## Trace record schema (JSONL, one record per line)

Slimmed from the data plan's shared Data Schema for text SFT:

```json
{
  "record_id": "trace-r08-000123",
  "recipe": "R08",
  "license_class": "TIER-1S-SYNTH",
  "origin": "synthetic",
  "reviewer_type": "agent (Z7) + spot-check",
  "corpus_chunk_ids": ["v7-main-01823", "v7-main-09112"],
  "constitution_section": "global hard rules",
  "language": "en",
  "market": "US",
  "split": "train",
  "content_hash": "sha256:…",
  "duplicate_family": "r08-acme-fitness-q3",
  "brief": { "objective": "…", "audience": "…", "constraints": "…" },
  "reasoning_trace": "…step-by-step expert reasoning…",
  "output": "…final artifact (strategy, copy, critique, code)…",
  "validation": { "checks": ["…"], "verifier": "…" },
  "created_at": "2026-09-26"
}
```

Hard rules:
- **Every trace cites its corpus chunk IDs.** No chunk IDs = no trace. This is the provenance chain back to manifest v7.
- **`license_class` is always one of:** `TIER-1S-SYNTH` (traces authored from Tier 1S corpus), `TIER-2-OPEN` (derived from openly-licensed material), `TIER-3-PRIVATE` (personal-purchase overlay — never ships in public artifacts). Ripped/pirated sources: never, per the locked clean-sourcing tiers.
- **Split discipline:** group by project/brand/template — no near-duplicate leaks between train and held-out. `duplicate_family` enforced at write time.
- **No frontier-model distillation:** traces are team-authored synthesis grounded in Tico's own corpus + constitution, not reproductions of another lab's model outputs.

## Generation method

1. Pull relevant chunks from corpus v7 (`data/corpus/main`, `by-sa`, `synthesis`) per recipe.
2. Author reasoning traces in the EXPERT-CONSTITUTION.md register (global hard rules apply: zero custody, autopilot-never-buys, propose/execute, honest labeling).
3. Apply recipe-specific verifiers (R07 outcome significance, R10 numeric tolerance, R14 faithfulness/citation, R09 rule classifier).
4. Dedupe via `content_hash` + `duplicate_family`; write JSONL to `traces/`.
5. Spot-check 5% human-style review (Z7) before eval.

## Eval gating (before any scale-up)

- Extend `scripts/eval-corpus.mts` (currently 22/22 on corpus) with trace-quality evals: faithfulness (claims traceable), rule adherence (constitution hard rules), specificity (no generic feedback), held-out task performance by recipe.
- Pilot passes → propose scale-up volumes per bucket with Tico's approval.

## Directory layout

```
~/workspace/marketr/training/
  TRACE-DATASET-PLAN.md   (this file)
  traces/                 (JSONL output, split by recipe)
  evals/                  (trace eval results)
  cards/                 (data card per recipe batch: license, date, filters)
```
