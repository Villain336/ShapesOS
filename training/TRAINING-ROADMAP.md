# Marketr Model Training Roadmap — alongside frontier, ahead of the SaaS pack

**Status:** DRAFT for Tico's review (2026-09-26)
**Companion docs:** `TRACE-DATASET-PLAN.md` (trace pilot), `~/workspace/marketr/EXPERT-CONSTITUTION.md`

## 1. The architecture: two tiers, one brain

Marketr does not replace frontier models. It *demotes* them to the job only they can do.

| Layer | Model | Job |
|---|---|---|
| **Strategy tier** | Frontier via API (Claude/GPT-class) | Chief Strategy Agent, mission planning, novel orchestration — work that needs the best reasoning on earth |
| **Volume tier** | Marketr's fine-tuned open model (30B-class) | Content drafts, briefs, critiques, scoring, measurement writeups — high-volume, repeatable, on-brand |
| **Fact layer** | RAG over corpus v8+ (growing) | Fresh truth: platform specs, benchmarks, outcomes — never baked into weights |
| **Conscience layer** | Expert Constitution | Prompt layer in front of *both* tiers: zero custody, autopilot-never-buys, propose/execute, honest labeling |

The frontier model is the general; the tuned model is the army. Nobody else in marketing SaaS fields an army — they rent generals for everything and pay per order.

## 2. How this beats Jasper, Copy.ai, and the rest

**What they do:** Jasper is LLM-agnostic (GPT-4 + Anthropic + Google mix) with Jasper IQ as a workflow/brand layer on top. Copy.ai is frontier + GTM workflows. The pattern is universal: rent the same models everyone rents, differentiate on workflows, brand voice, and feedback loops. When frontier models improve, every competitor improves equally — there is no compounding advantage in the model itself.

**Where Marketr pulls away — reasoning:**

1. **Judgment in the weights, not in the prompts.** Everyone else bolts prompt templates onto rented models. Marketr's fine-tune bakes marketing reasoning patterns into the model itself — positioning → audience → offer → channel economics → measurement as *reflex*, not instruction. Prompts can be copied in an afternoon; a weights-level strategist trained on a proprietary trace dataset cannot.
2. **The trace dataset is the moat.** 2,730 traces today, scaling to 50K+. Every user correction, every mission outcome, every winning campaign becomes new training data. Jasper's own CEO named the game: *"the folks that will win at generative AI will be the ones that have the best feedback loops."* Their loop improves prompts. Ours improves the model.
3. **Outcome grounding.** "Marketing's moat is outcomes" — the data plan's core thesis. Stage C preference pairs come from *measured results* (what converted, what didn't), and verifiable rewards (render checks, a11y, numeric measurement) punish plausible-sounding wrongness. Incumbents optimize for copy that *reads* well; Marketr optimizes for copy that *worked*.

**Where Marketr pulls away — execution:**

4. **Cost structure.** The volume tier runs on an owned open model at a fraction of a cent per task instead of frontier API pricing. At $29/$79/$199 hosted tiers targeting ~90% gross margin, this is the difference between a business and a reseller. Competitors' margins are permanently capped by their API bills; Marketr's *improve* with scale.
5. **White-label + self-host.** Agencies — the wedge — can run the model inside their own walls; client data never leaves. Nobody built on rented frontier APIs can offer that.
6. **GrowthOS vs point tools.** Jasper does content workflows; Copy.ai does GTM workflows. Marketr runs the whole loop — strategy → missions → playbooks → measurement → memory — with the frontier strategist directing a fleet of tuned executors. It's the difference between hiring a copywriter and hiring a growth department.

**Honest counterweight:** Jasper has years of feedback loops, brand trust, enterprise distribution, and a 2026 MCP-server governance play. A better model does not beat distribution on launch day. The model is a *compounding* advantage — it widens every quarter while their architecture stays flat. Speed to distribution remains the moat for everything else.

## 3. Timeline

| Phase | Weeks | Work | Gate |
|---|---|---|---|
| **Eval gate** | 1–2 (now) | 5% human spot-check of pilot; extend eval suite with trace-quality evals (faithfulness, rule adherence, specificity); augmentation ingest lands (corpus v9) | Pilot beats baseline on held-out evals, or recipes get fixed |
| **Experiment** | 3–4 | Small LoRA fine-tune on pilot traces (Muse Glimmer 30B or shortlisted base); rented GPUs, few hundred $ — needs Tico's spend approval | **Go/no-go:** do the traces move evals? If no, fix recipes before scaling data 20x |
| **Scale-up** | 5–8 | Trace generation to 50K+: more seeds not variants, design-pillar recipes (screenshot→code, render-in-the-loop — needs render pipeline), augmentation round 2, real VoC partnerships | Volume + coverage targets per bucket |
| **Production train** | 8–10 | Full SFT fine-tune, then DPO on preference pairs derived from SFT outputs | Beats base+RAG on held-out marketing tasks; constitution refusal tests green |
| **Wire-in** | 10–12 | Tuned model takes the volume tier in Marketr; A/B vs frontier-only on quality, latency, cost | Margin measured; quality parity-or-better on volume tasks |
| **Flywheel** | ongoing | Every mission outcome → new traces; periodic re-tunes; Stage D RL envs only if SFT+DPO justifies it | Compounding, not a project |

Total: ~12 weeks to a production tuned model serving real traffic, consistent with the original estimate. Data remains the long pole — the GPU runs are the short, cheap tail.

## 4. Decision points for Tico

1. **Eval gate + spot-check** — approve the eval criteria, or do the human pass yourself.
2. **GPU spend** — the experiment fine-tune needs rented GPUs (hundreds, not thousands). Exact numbers before booking, per the red lane.
3. **Base model pick** — recommendation is Muse Glimmer 30B (Apache 2.0, agentic-distilled); finalists Qwen 3.6-35B-A3B, Mistral Small 4. Lock before the experiment.
4. **Design pillar timing** — render pipeline for screenshot→code recipes: build in scale-up phase, or defer to v2 of the model.
5. **VoC partnerships** — real review/outcome data is the hardest thin spot; agency/brand data partnerships (H12 in the data plan) may need your outreach, not just mine.
