// ShapesOS — Phase 19B (WS=panel): in-character proposition monitors.
// Commercial layer (entitlement dress_rehearsal). See lib/panel/README.md.
//
// Ported from the prototype's src/trust/propositions.ts (TinyTroupe-style
// checks). Each walk step, a model-as-judge answers one proposition:
//   persona_adherence — does this step contradict the persona's established
//     traits (a $50/mo hard cap thinking "the $500/mo plan looks fine")?
//   self_consistency  — does it contradict the persona's OWN earlier stated
//     positions in this walk, with nothing new on the page to explain it?
// A passing step is silent ([]), so the friction timeline isn't noise.
//
// Monitoring is advisory: a judge answer that fails its schema twice
// (PanelModelOutputError) degrades to silence. A CAP STOP is not advisory:
// PanelCapReachedError always propagates out of the hook and stops the walk.
// (The prototype's game master caught every hook error — including its own
// cost-cap error — and turned it into a step flag, so a run kept spending
// past its cap. lib/panel/walk.ts rethrows it.)

import { z } from "zod";
import type { PanelModel } from "./model";
import { PanelModelOutputError } from "./model";
import type { PersonaSpec } from "./persona";
import type { StepFlag, StepHook, WalkthroughStep } from "./walk";
import { describeIntent } from "./intents";

export const JudgeSchema = z.object({
  passed: z.boolean().describe("true when the step is consistent; false on a clear contradiction"),
  detail: z.string().describe("One sentence naming the contradiction (empty when passed)"),
});

export const JUDGE_TOOL = {
  name: "submit_judgement",
  description: "Submit whether the step passes the proposition.",
  schema: JudgeSchema,
};

export const JUDGE_MAX_TOKENS = 200;

function renderTraitCard(spec: PersonaSpec): string {
  const lines = [
    `Name: ${spec.identity.name} (${spec.identity.role})`,
    `Budget: up to ${spec.budget.currency} ${spec.budget.monthlyMax}/month${spec.budget.hardCap ? " — HARD CAP, will never exceed" : ""}${spec.budget.notes ? ` (${spec.budget.notes})` : ""}`,
    `Skepticism: ${spec.skepticism}`,
  ];
  if (spec.beliefs.length > 0) lines.push(`Beliefs: ${spec.beliefs.join("; ")}`);
  if (spec.knownObjections.length > 0) lines.push(`Known objections: ${spec.knownObjections.map((o) => o.text).join(" | ")}`);
  if (spec.preferences.dislikes.length > 0) lines.push(`Dislikes: ${spec.preferences.dislikes.join("; ")}`);
  return lines.join("\n");
}

function renderStepCard(step: WalkthroughStep): string {
  return [
    `Intent: ${describeIntent(step.intent)}`,
    `Think-aloud: ${step.thinkAloud.slice(0, 1000) || "(empty)"}`,
    `Observed on page: ${step.observation.textExcerpt.slice(0, 600) || "(nothing yet)"}`,
  ].join("\n");
}

/** One judge call. Schema failures → null (advisory); cap stops and provider errors propagate. */
async function runJudge(model: PanelModel, runId: string, system: string, user: string): Promise<z.infer<typeof JudgeSchema> | null> {
  try {
    const res = await model.structured(runId, { purpose: "judge", system, user, tool: JUDGE_TOOL, maxTokens: JUDGE_MAX_TOKENS });
    return res.value;
  } catch (err) {
    if (err instanceof PanelModelOutputError) return null;
    throw err;
  }
}

export interface PersonaAdherenceHookArgs {
  model: PanelModel;
  personaSpec: PersonaSpec;
  runId: string;
}

/** Per-step: one judge call on whether the step contradicts established traits. */
export function personaAdherenceHook(args: PersonaAdherenceHookArgs): StepHook {
  const { model, personaSpec, runId } = args;
  const traitCard = renderTraitCard(personaSpec);
  const system = [
    "You are a proposition monitor for an AI customer simulation.",
    "Given the customer's established traits and one step of their page walkthrough, decide whether",
    "the customer's thinking or intent clearly contradicts an established trait (e.g. a hard-cap budget ignored, a core belief violated).",
    "Be conservative: flag only clear contradictions, not tone or emphasis. Keep detail to one sentence.",
  ].join("\n");
  return async (step) => {
    const verdict = await runJudge(model, runId, system, `[Established traits]\n${traitCard}\n\n[This step]\n${renderStepCard(step)}`);
    if (!verdict || verdict.passed) return [];
    return [{ check: "persona_adherence", passed: false, detail: verdict.detail || "step contradicts an established persona trait" }];
  };
}

export interface SelfConsistencyHookArgs {
  model: PanelModel;
  runId: string;
  /** How many previous think-alouds to compare against. Default 3. */
  windowN?: number;
}

/**
 * Per-step: one judge call on whether the think-aloud contradicts the
 * persona's own earlier positions (a sliding window). The first step has no
 * history: no call, no flag.
 */
export function selfConsistencyHook(args: SelfConsistencyHookArgs): StepHook {
  const { model, runId } = args;
  const windowN = args.windowN ?? 3;
  const history: Array<{ stepIndex: number; thinkAloud: string }> = [];
  const system = [
    "You are a self-consistency monitor for an AI customer simulation.",
    "Given the customer's earlier stated positions (in order) and their current thinking, decide whether the",
    "current thinking clearly contradicts an earlier position with no new evidence explaining the change.",
    "A change of mind is fine when the page gave new information — flag only unexplained flip-flops",
    "(e.g. 'too expensive' then 'seems reasonable' with nothing new shown). Be conservative. One sentence.",
  ].join("\n");
  return async (step) => {
    const prior = history.slice(-Math.max(0, windowN));
    let verdict: z.infer<typeof JudgeSchema> | null = null;
    if (prior.length > 0 && step.thinkAloud.trim().length > 0) {
      const earlier = prior.map((h) => `Step ${h.stepIndex}: ${h.thinkAloud.slice(0, 500)}`).join("\n");
      verdict = await runJudge(model, runId, system, `[Earlier positions]\n${earlier}\n\n[Current thinking (step ${step.stepIndex})]\n${step.thinkAloud.slice(0, 1000)}`);
    }
    if (step.thinkAloud.trim().length > 0) {
      history.push({ stepIndex: step.stepIndex, thinkAloud: step.thinkAloud });
      while (history.length > windowN) history.shift();
    }
    if (!verdict || verdict.passed) return [];
    const flag: StepFlag = { check: "self_consistency", passed: false, detail: verdict.detail || "step contradicts the persona's earlier stated position" };
    return [flag];
  };
}
