// ShapesOS — Phase 19B (WS=panel): the page walk loop (the game master).
// Commercial layer (entitlement dress_rehearsal). Licence boundary: CONTRIBUTING.md (open vs commercial; company-authored).
//
// Ported from the prototype's src/simulation/gamemaster.ts. One persona walks
// the page-as-world:
//   1. the persona runtime: memory (retrieval over ITS OWN interviews and
//      reflections plus what it saw and thought earlier in this walk),
//      instructions (the spec rendered as a system prompt), plan (first goal);
//   2. each step: the persona answers with a structured step (thinkAloud +
//      intent) → the PageMaster resolves it against the real page → an
//      observation; observation + thought nodes go to the memory stream;
//      proposition hooks run;
//   3. behaviour signals per step: dwell, scroll depth, clicks, rage-click
//      bursts, hover dwell;
//   4. the loop ends on a finish signal, a step cap, the run's credit cap, or
//      a model failure.
//
// What changed versus the prototype:
//   * outcomes: "goal-complete" is its own outcome (the prototype counted it
//     as checkout-attempted), and "cap-stopped" / "failed" end a walk honestly
//     with the steps it has;
//   * a cap stop inside a hook is NOT swallowed (the prototype turned every
//     hook error, its own cost-cap error included, into a flag and kept
//     going); other hook errors are recorded as monitor errors, never as a
//     contradiction of the persona;
//   * dwellMs excludes the model's thinking time (modelMs is kept apart), so
//     "attention died" measures the page, not the model's latency;
//   * memory retrieval is scoped to this persona (its transcripts, this run).

import { describeIntent, STEP_TOOL, type Intent } from "./intents";
import { isCapReached } from "./budget";
import type { MemoryStore } from "./memory";
import { PanelModelOutputError, type PanelModel } from "./model";
import type { PersonaSpec } from "./persona";
import { landingObservation, resolveIntent, type Observation, type SaveShot, type WalkPage } from "./pagemaster";
import { detectRageClicks, humanDwellMs, sleep, type TrackerState } from "./tracker";

export type StepCheckKind = "persona_adherence" | "self_consistency";

export interface StepFlag {
  check: StepCheckKind;
  passed: boolean;
  detail: string;
}

export type StepHook = (step: WalkthroughStep) => StepFlag[] | Promise<StepFlag[]>;

export interface StepSignals {
  /** Time the page held the persona this step (action + simulated reading), excluding the model's thinking. */
  dwellMs: number;
  /** The model call's wall-clock for this step. */
  modelMs: number;
  scrollDepthPct: number;
  clicks: number;
  rageClickBursts: number;
  hoverDwellMs: number;
  url: string;
}

export interface WalkthroughStep {
  stepIndex: number;
  startedAt: number;
  endedAt: number;
  intent: Intent | null;
  thinkAloud: string;
  observation: Observation;
  signals: StepSignals;
  flags: StepFlag[];
  /** Hook failures other than a cap stop (advisory monitors only). */
  monitorErrors?: string[];
}

export interface WalkthroughSignals {
  totalDwellMs: number;
  maxScrollDepthPct: number;
  totalClicks: number;
  rageClickBursts: number;
  totalHoverDwellMs: number;
  sectionsVisited: string[];
  dropOff: { url: string; section?: string };
  llmCalls: number;
}

export type WalkthroughOutcome = "checkout-attempted" | "goal-complete" | "bounced" | "step-capped" | "cap-stopped" | "failed";

/** Outcomes where the walk ended on its own (a verdict may be read off it). */
export const COMPLETE_OUTCOMES: readonly WalkthroughOutcome[] = ["checkout-attempted", "goal-complete", "bounced", "step-capped"];

export interface WalkthroughResult {
  runId: string;
  personaKey: string;
  personaName: string;
  outcome: WalkthroughOutcome;
  steps: WalkthroughStep[];
  signals: WalkthroughSignals;
  /** Why the walk stopped early (cap-stopped / failed). */
  stopReason?: string;
}

export interface RunWalkthroughArgs {
  model: PanelModel;
  store: MemoryStore;
  personaSpec: PersonaSpec;
  /** Stable id of the persona inside the run (the persona row id). */
  personaKey: string;
  page: WalkPage;
  runId: string;
  stepCap: number;
  onStepHooks?: StepHook[];
  /** Sleep a human reading time between steps. Default true; tests set false. */
  humanTiming?: boolean;
  saveShot?: SaveShot;
  /** Called after every step (the runner persists it). */
  onStep?: (step: WalkthroughStep) => void | Promise<void>;
}

export const STEP_MAX_TOKENS = 500;

function skepticismLabel(s: number): string {
  if (s >= 0.8) return "very high";
  if (s >= 0.5) return "high";
  if (s >= 0.25) return "moderate";
  return "low";
}

/** The instructions component: the spec as a system prompt. */
export function renderPersonaInstructions(spec: PersonaSpec): string {
  const id = spec.identity;
  const who = `${id.name}, a ${id.role}${id.company ? ` at ${id.company}` : ""} (${spec.occupation})`;
  const lines = [
    `You are ${who}. You are a SYNTHETIC customer built from real interviews, walking a page so its founder can learn from your reactions.`,
    `Your goals: ${spec.goals.join("; ")}.`,
    `Budget: up to ${spec.budget.currency} ${spec.budget.monthlyMax}/month${spec.budget.hardCap ? " (HARD CAP — never exceed this)" : ""}.${spec.budget.notes ? ` ${spec.budget.notes}` : ""}`,
    `Skepticism level: ${skepticismLabel(spec.skepticism)} (${spec.skepticism}).`,
  ];
  if (spec.beliefs.length > 0) lines.push(`You believe: ${spec.beliefs.join("; ")}.`);
  if (spec.knownObjections.length > 0) lines.push(`Objections you hold from past experience: ${spec.knownObjections.map((o) => o.text).join(" | ")}`);
  lines.push(
    "Each step: think aloud honestly, in character, then choose ONE action:",
    "- scroll or read a section (target = its heading as shown, or #id); click a button or link (target = its name as shown); fill a field (target = its label, value = what you type); go back;",
    "- finish: checkout-attempted (you would pay or sign up), bounced (the page lost you — say why), goal-complete (you got what you came for without buying).",
    "RULES: Only describe page content you have been shown in observations. Never invent prices, features, or testimonials. If you cannot find something, say so and move on or bounce.",
  );
  return lines.join("\n");
}

function sectionName(o: Observation): string | undefined {
  return o.sectionMeta?.heading ?? o.sectionMeta?.sectionId;
}

export async function runWalkthrough(args: RunWalkthroughArgs): Promise<WalkthroughResult> {
  const { model, store, personaSpec, personaKey, page, runId, stepCap, onStepHooks = [], humanTiming = true, saveShot, onStep } = args;
  const instructions = renderPersonaInstructions(personaSpec);
  const plan = personaSpec.goals[0] ?? "explore the page";
  const steps: WalkthroughStep[] = [];
  let outcome: WalkthroughOutcome = "step-capped";
  let stopReason: string | undefined;
  let llmCalls = 0;

  let lastIntent = "(just landed)";
  let lastObservation = await landingObservation(page);
  let lastSection: string | undefined;

  for (let stepIndex = 0; stepIndex < stepCap; stepIndex += 1) {
    const startedAt = Date.now();
    const before: TrackerState = await page.trackerState();

    // Memory: this persona's interviews and reflections + this walk so far.
    const focal = `${lastIntent} ${lastObservation.textExcerpt.slice(0, 300)} ${lastSection ?? ""}`.trim();
    const mem = await store.retrieve(focal, {
      k: 6,
      weights: { recency: 1, relevance: 2, importance: 1.5 },
      kinds: ["interview", "reflection", "observation", "thought"],
      transcriptIds: personaSpec.sourceTranscriptIds,
      runId,
      personaKey,
    });
    const memoryBlock = mem
      .map((s) => `- [${s.node.kind}] ${s.node.content.slice(0, 300)}`)
      .join("\n")
      .slice(0, 2000);
    const prompt = [
      `[Page] ${page.url()}`,
      `[Your current goal] ${plan}`,
      `[What you remember]\n${memoryBlock || "(nothing yet)"}`,
      `[Last observation] (${lastObservation.type}) ${lastObservation.textExcerpt.slice(0, 1200)}`,
    ].join("\n\n");

    let intent: Intent | null = null;
    let thinkAloud = "";
    let unparsedReason: string | undefined;
    const modelStart = Date.now();
    try {
      const res = await model.structured(runId, { purpose: "step", system: instructions, user: prompt, tool: STEP_TOOL, maxTokens: STEP_MAX_TOKENS });
      llmCalls += 1;
      intent = res.value.intent;
      thinkAloud = res.value.thinkAloud;
    } catch (err) {
      if (isCapReached(err)) {
        outcome = "cap-stopped";
        stopReason = (err as Error).message;
        break;
      }
      if (err instanceof PanelModelOutputError) {
        llmCalls += 2;
        unparsedReason = err.reason;
      } else {
        outcome = "failed";
        stopReason = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    const modelMs = Date.now() - modelStart;

    const observation = await resolveIntent({ page, intent, stepIndex, saveShot, unparsedReason });
    let sleptMs = 0;
    if (humanTiming && observation.textExcerpt && observation.type !== "unparsed") {
      sleptMs = humanDwellMs(observation.textExcerpt, { maxMs: 6_000 });
      await sleep(sleptMs);
    }
    const endedAt = Date.now();
    const after = await page.trackerState();
    const newClicks = after.clicks.slice(before.clicks.length);
    const newHovers = after.hovers.slice(before.hovers.length);
    const step: WalkthroughStep = {
      stepIndex,
      startedAt,
      endedAt,
      intent,
      thinkAloud,
      observation,
      signals: {
        dwellMs: Math.max(0, endedAt - startedAt - modelMs),
        modelMs,
        scrollDepthPct: Math.round(after.maxScrollDepthPct),
        clicks: newClicks.length,
        rageClickBursts: detectRageClicks(newClicks).length,
        hoverDwellMs: newHovers.reduce((s, h) => s + h.dwellMs, 0),
        url: observation.url,
      },
      flags: [],
    };

    await store.addNode({
      id: `${runId}:${personaKey}:step:${stepIndex}:observation`,
      kind: "observation",
      runId,
      personaKey,
      content: JSON.stringify({ intent: describeIntent(intent), type: observation.type, excerpt: observation.textExcerpt.slice(0, 500), url: observation.url }),
      importance: 0.6,
      chunkIndex: stepIndex,
    });
    if (thinkAloud.trim()) {
      await store.addNode({ id: `${runId}:${personaKey}:step:${stepIndex}:thought`, kind: "thought", runId, personaKey, content: thinkAloud.slice(0, 1000), importance: 0.5, chunkIndex: stepIndex });
    }

    let capInHook: unknown = null;
    for (const hook of onStepHooks) {
      try {
        step.flags.push(...(await hook(step)));
      } catch (err) {
        if (isCapReached(err)) {
          capInHook = err;
          break;
        }
        (step.monitorErrors ??= []).push(err instanceof Error ? err.message : String(err));
      }
    }
    steps.push(step);
    await onStep?.(step);

    if (capInHook) {
      outcome = "cap-stopped";
      stopReason = (capInHook as Error).message;
      break;
    }
    lastIntent = describeIntent(intent);
    lastObservation = observation;
    lastSection = sectionName(observation);
    if (observation.type === "finished") {
      outcome = observation.finishSignal ?? "goal-complete";
      break;
    }
  }

  const final = await page.trackerState();
  const lastStep = steps[steps.length - 1];
  return {
    runId,
    personaKey,
    personaName: personaSpec.identity.name,
    outcome,
    steps,
    ...(stopReason ? { stopReason } : {}),
    signals: {
      totalDwellMs: steps.reduce((s, x) => s + x.signals.dwellMs, 0),
      maxScrollDepthPct: steps.reduce((m, x) => Math.max(m, x.signals.scrollDepthPct), 0),
      totalClicks: steps.reduce((s, x) => s + x.signals.clicks, 0),
      rageClickBursts: steps.reduce((s, x) => s + x.signals.rageClickBursts, 0),
      totalHoverDwellMs: steps.reduce((s, x) => s + x.signals.hoverDwellMs, 0),
      sectionsVisited: Object.keys(final.sections),
      dropOff: { url: lastStep?.observation.url ?? page.url(), ...(lastStep && sectionName(lastStep.observation) ? { section: sectionName(lastStep.observation) } : {}) },
      llmCalls,
    },
  };
}
