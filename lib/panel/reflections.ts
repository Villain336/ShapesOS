// ShapesOS — Phase 19B (WS=panel): expert reflections (the 4 lenses).
// Commercial layer (entitlement dress_rehearsal). See lib/panel/README.md.
//
// Ported from the prototype's src/calibration/reflections.ts (genagents
// "expert reflections"): four domain-expert lenses — price skeptic,
// workflow-fit analyst, trust auditor, competitor comparer — each read the
// FULL verbatim transcript and emit up to 20 short observations, stored as
// kind "reflection" memory nodes linked to the transcript (and the lens), so
// the walk's memory can surface the right lens at query time.
//
// Changed: structured output (a submit_observations tool) instead of JSON
// mode; every call is reserved on the run ledger (a cap stop propagates).

import { z } from "zod";
import { heuristicImportanceScorer, type MemoryNode, type MemoryStore } from "./memory";
import type { PanelModel } from "./model";

export interface ReflectionLens {
  id: string;
  name: string;
  systemPrompt: string;
}

const RULE = "Each observation must be ONE sentence, max 25 words, grounded in something the interviewee actually said.";

/** The four lenses. */
export const REFLECTION_LENSES: readonly ReflectionLens[] = [
  {
    id: "price-skeptic",
    name: "Price skeptic",
    systemPrompt: [
      "You are a pricing skeptic reading a customer interview transcript.",
      "Extract up to 20 short observations about: price sensitivity, budget constraints, ROI demands,",
      "billing/pricing objections, what the interviewee considers fair or outrageous pricing, and what would justify spending more.",
      RULE,
    ].join("\n"),
  },
  {
    id: "workflow-fit",
    name: "Workflow-fit analyst",
    systemPrompt: [
      "You are a workflow-fit analyst reading a customer interview transcript.",
      "Extract up to 20 short observations about: the interviewee's current workflow and tools, pain points,",
      "workarounds they use today, what 'good' looks like for them, and where a new tool would slot in or clash.",
      RULE,
    ].join("\n"),
  },
  {
    id: "trust-auditor",
    name: "Trust auditor",
    systemPrompt: [
      "You are a trust auditor reading a customer interview transcript.",
      "Extract up to 20 short observations about: skepticism toward vendor claims, past bad experiences,",
      "what proof or guarantees the interviewee would need, trust signals they mention, and red flags that would make them walk away.",
      RULE,
    ].join("\n"),
  },
  {
    id: "competitor-comparer",
    name: "Competitor comparer",
    systemPrompt: [
      "You are a competitor analyst reading a customer interview transcript.",
      "Extract up to 20 short observations about: alternatives and competitors the interviewee mentions,",
      "why the current tool won or lost, switching costs and migration fears, and what would make them switch.",
      RULE,
    ].join("\n"),
  },
];

/** genagents' cap: up to 20 observations per expert. */
export const MAX_OBSERVATIONS_PER_LENS = 20;

export const ObservationsSchema = z.object({
  observations: z.array(z.string()).describe("Short observations, one sentence each."),
});

export const REFLECTION_TOOL = {
  name: "submit_observations",
  description: "Submit the observations this lens found in the interview.",
  schema: ObservationsSchema,
};

export const REFLECTION_MAX_TOKENS = 1500;

export interface LensReflections {
  lensId: string;
  nodes: MemoryNode[];
}

export interface RunReflectionsOptions {
  model: PanelModel;
  store: MemoryStore;
  transcriptId: string;
  lenses?: readonly ReflectionLens[];
  /** Ledger run the calls are reserved on. */
  runId: string;
  maxPerLens?: number;
}

/** Run every lens over the transcript and store each observation as a reflection node. */
export async function runReflections(options: RunReflectionsOptions): Promise<LensReflections[]> {
  const { model, store, transcriptId, lenses = REFLECTION_LENSES, runId, maxPerLens = MAX_OBSERVATIONS_PER_LENS } = options;
  const transcript = await store.getTranscript(transcriptId);
  if (!transcript) throw new Error(`No transcript with id ${JSON.stringify(transcriptId)}`);
  const results: LensReflections[] = [];
  for (const lens of lenses) {
    const res = await model.structured(runId, {
      purpose: "reflect",
      system: lens.systemPrompt,
      user: `INTERVIEW TRANSCRIPT (verbatim):\n\n${transcript.text}`,
      tool: REFLECTION_TOOL,
      maxTokens: REFLECTION_MAX_TOKENS,
    });
    const observations = res.value.observations
      .map((o) => o.trim())
      .filter((o) => o.length > 0)
      .slice(0, Math.max(0, maxPerLens));
    const nodes: MemoryNode[] = [];
    for (const [i, content] of observations.entries()) {
      nodes.push(
        await store.addNode({
          id: `${transcriptId}:reflection:${lens.id}:${i}`,
          transcriptId,
          kind: "reflection",
          lens: lens.id,
          content,
          importance: heuristicImportanceScorer(content),
          chunkIndex: i,
        }),
      );
    }
    results.push({ lensId: lens.id, nodes });
  }
  return results;
}
