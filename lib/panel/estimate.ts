// ShapesOS — Phase 19B (WS=panel): the up-front credit estimate and the
// parallel caps. Commercial layer (entitlement dress_rehearsal). Licence
// boundary: CONTRIBUTING.md (open vs commercial; company-authored).
//
// THE CAP MATHS (shown to the person, who confirms a cap before anything runs):
//   step call    = credits(model, in ≈ STEP_PROMPT_CHARS, out = STEP_MAX_TOKENS)
//   judge call   = credits(model, in ≈ JUDGE_PROMPT_CHARS, out = JUDGE_MAX_TOKENS)   × 2 per step
//   verdict call = credits(model, in ≈ VERDICT_PROMPT_CHARS(stepCap), out = VERDICT_MAX_TOKENS)
//   fix call     = credits(model, in ≈ FIX_PROMPT_CHARS, out = FIX_MAX_TOKENS)       × 5 per run
//   per persona  = stepCap × (step + 2 × judge) + verdict
//   run          = personas × per persona + 5 × fix
// credits(model, in, out) is the router's billing rule (lib/panel/budget.ts):
// llmTokenCredits(billable cost) with in = chars / 3 × 1.2. Every term is a
// worst case (every persona uses every step; every reply is max length), so
// a real run normally spends well under the estimate. Prompt sizes are the
// ceilings the prompts are truncated to (lib/panel/walk.ts, verdicts.ts).
//
// Derivation (interviews → personas) is estimated the same way:
//   per transcript = 4 reflection calls (transcript + lens prompt) + 1 derive call.

import { worstCaseCallCredits } from "./budget";
import { STEP_MAX_TOKENS } from "./walk";
import { JUDGE_MAX_TOKENS } from "./trust";
import { VERDICT_MAX_TOKENS } from "./verdicts";
import { FIX_CLUSTER_CAP, FIX_MAX_TOKENS } from "./aggregate";
import { REFLECTION_LENSES, REFLECTION_MAX_TOKENS } from "./reflections";
import { DERIVE_MAX_TOKENS } from "./derive";

/** Prompt ceilings in characters (system + user + the tool's schema). */
export const STEP_PROMPT_CHARS = 7_000;
export const JUDGE_PROMPT_CHARS = 3_500;
export const FIX_PROMPT_CHARS = 2_500;
export const VERDICT_PROMPT_BASE_CHARS = 5_000;
/** Each step adds a think-aloud + an observation excerpt (≤ 500 chars each) to the verdict's evidence. */
export const VERDICT_PROMPT_CHARS_PER_STEP = 1_000;
export const REFLECTION_PROMPT_OVERHEAD_CHARS = 1_200;
export const DERIVE_PROMPT_CHARS = 14_000;

export const STEP_CAP_BOUNDS = [2, 15] as const;
export const DEFAULT_STEP_CAP = 8;
export const MAX_PERSONAS_PER_RUN = 12;

export interface RunEstimate {
  model: string;
  personas: number;
  stepCap: number;
  perCall: { step: number; judge: number; verdict: number; fix: number };
  perPersona: number;
  fixes: number;
  total: number;
  /** Plain-words formula for the confirm screen. */
  formula: string;
}

export function clampStepCap(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : DEFAULT_STEP_CAP;
  return Math.min(STEP_CAP_BOUNDS[1], Math.max(STEP_CAP_BOUNDS[0], v));
}

export function estimateRun(model: string, personas: number, stepCapRaw: number): RunEstimate {
  const stepCap = clampStepCap(stepCapRaw);
  const step = worstCaseCallCredits(model, STEP_PROMPT_CHARS, STEP_MAX_TOKENS);
  const judge = worstCaseCallCredits(model, JUDGE_PROMPT_CHARS, JUDGE_MAX_TOKENS);
  const verdict = worstCaseCallCredits(model, VERDICT_PROMPT_BASE_CHARS + stepCap * VERDICT_PROMPT_CHARS_PER_STEP, VERDICT_MAX_TOKENS);
  const fix = worstCaseCallCredits(model, FIX_PROMPT_CHARS, FIX_MAX_TOKENS);
  const perPersona = stepCap * (step + 2 * judge) + verdict;
  const fixes = FIX_CLUSTER_CAP * fix;
  const total = Math.max(0, personas) * perPersona + fixes;
  return {
    model,
    personas,
    stepCap,
    perCall: { step, judge, verdict, fix },
    perPersona,
    fixes,
    total,
    formula: `${personas} personas × (${stepCap} steps × (${step} + 2 × ${judge}) + ${verdict}) + ${FIX_CLUSTER_CAP} × ${fix} = ${total} credits`,
  };
}

export interface DeriveEstimate {
  model: string;
  transcripts: number;
  total: number;
  formula: string;
}

export function estimateDerivation(model: string, transcriptChars: number[]): DeriveEstimate {
  let total = 0;
  for (const chars of transcriptChars) {
    total += REFLECTION_LENSES.length * worstCaseCallCredits(model, chars + REFLECTION_PROMPT_OVERHEAD_CHARS, REFLECTION_MAX_TOKENS);
    total += worstCaseCallCredits(model, DERIVE_PROMPT_CHARS, DERIVE_MAX_TOKENS);
  }
  return {
    model,
    transcripts: transcriptChars.length,
    total,
    formula: `${transcriptChars.length} interviews × (${REFLECTION_LENSES.length} reflection calls + 1 persona call) = ${total} credits at most`,
  };
}

// ---------------------------------------------------------------------------
// Parallel caps (Phase 16 style: per run and per workspace)
// ---------------------------------------------------------------------------

export interface PanelLimits {
  /** Personas of one run walking at the same time. */
  maxParallelPerRun: number;
  /** Page walk runs working at the same time in one workspace. */
  maxLiveRunsPerWorkspace: number;
}

export const DEFAULT_PANEL_LIMITS: Readonly<PanelLimits> = Object.freeze({ maxParallelPerRun: 3, maxLiveRunsPerWorkspace: 1 });
export const PANEL_LIMIT_BOUNDS = { maxParallelPerRun: [1, 6], maxLiveRunsPerWorkspace: [1, 4] } as const;

/** The limits in force: PANEL_MAX_PARALLEL_PERSONAS (1–6), and never more browsers than the recorder allows. */
export function panelLimits(env: Record<string, string | undefined> = process.env, browserSlots = Infinity): PanelLimits {
  const raw = Number.parseInt(env.PANEL_MAX_PARALLEL_PERSONAS ?? "", 10);
  const [lo, hi] = PANEL_LIMIT_BOUNDS.maxParallelPerRun;
  const par = Number.isFinite(raw) ? Math.min(hi, Math.max(lo, raw)) : DEFAULT_PANEL_LIMITS.maxParallelPerRun;
  return { maxParallelPerRun: Math.max(1, Math.min(par, browserSlots)), maxLiveRunsPerWorkspace: DEFAULT_PANEL_LIMITS.maxLiveRunsPerWorkspace };
}

/** Run `tasks` with at most `limit` at a time; results in input order. */
export async function runPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
