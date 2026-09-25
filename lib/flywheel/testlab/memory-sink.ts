// Marketr — Test Lab Growth Memory archive sink (F3).
//
// Growth Memory itself is Phase 8. This module builds the SINK: the
// forward-compatible structured-learning schema every closed test archives
// into. Phase 8 defines the store; this file defines the shape it will store.

import type { Experiment, ExperimentVerdict } from "./experiment";
import type { HonestyResult } from "./honesty";

/** Forward-compatible schema version. Bump only with a migration note. */
export const GROWTH_MEMORY_SINK_SCHEMA = "growth-memory.learning/v1" as const;

export interface GrowthLearning {
  schema: typeof GROWTH_MEMORY_SINK_SCHEMA;
  learningId: string;
  workspaceId: string;
  experimentId: string;
  archivedAt: string;
  /** what we believed and why */
  hypothesis: string;
  /** what happened, in honest-dashboard language */
  result: {
    verdict: ExperimentVerdict;
    expectedUplift: number;
    credibleInterval: [number, number];
    chanceToBeat: number;
    expectedLossRelative: number;
    terminal: boolean;
  };
  /** primary + guardrail metrics, all on the record */
  metrics: {
    primaryMetric: string;
    guardrailChecks: { name: string; violated: boolean }[];
  };
  /** context future optimizers need to avoid re-learning */
  context: {
    channel: string;
    audience: string;
    variants: { id: string; name: string; description?: string }[];
    minRuntimeDays: number;
    statedMde: number;
    pieIceScore: number;
  };
  /** hypotheses this result suggests (or kills) next */
  followUps: string[];
  /** integrity caveats travel with the learning — never silently dropped */
  caveats: string[];
}

/** Sink port: Phase 8 implements this against the real store. */
export interface GrowthMemorySink {
  readonly schema: typeof GROWTH_MEMORY_SINK_SCHEMA;
  archive(learning: GrowthLearning): Promise<{ stored: boolean; ref: string }>;
}

/** Fake sink: validates the schema and holds learnings in memory. */
export function createFakeMemorySink(): GrowthMemorySink & { learnings: GrowthLearning[] } {
  const learnings: GrowthLearning[] = [];
  return {
    schema: GROWTH_MEMORY_SINK_SCHEMA,
    learnings,
    async archive(learning: GrowthLearning) {
      if (learning.schema !== GROWTH_MEMORY_SINK_SCHEMA) {
        throw new Error(`GrowthMemorySink: schema mismatch (got ${learning.schema})`);
      }
      learnings.push(learning);
      return { stored: true, ref: `memory://${learning.workspaceId}/${learning.learningId}` };
    },
  };
}

export function buildGrowthLearning(
  exp: Experiment,
  result: HonestyResult,
  opts: { learningId?: string; archivedAt?: string } = {},
): GrowthLearning {
  const followUps: string[] = [];
  if (result.verdict === "winner") {
    followUps.push(`Roll out the winning variant to 100% and monitor for novelty decay over the next cycle.`);
    followUps.push(`Test the next-biggest lever in the same funnel — the win confirms this surface moves.`);
  } else if (result.verdict === "loser") {
    followUps.push(`Investigate WHY the treatment lost before re-testing this surface — do not re-run the same idea.`);
  } else if (result.verdict === "inconclusive") {
    followUps.push(`Do not re-run at the same size. Either increase the swing, increase the traffic, or switch to qualitative research.`);
  }
  if (result.badges.power.label === "underpowered") {
    followUps.push(`Traffic-floor note: ${result.badges.power.detail}`);
  }

  return {
    schema: GROWTH_MEMORY_SINK_SCHEMA,
    learningId: opts.learningId ?? `learn_${exp.id}_${Date.now()}`,
    workspaceId: exp.workspaceId,
    experimentId: exp.id,
    archivedAt: opts.archivedAt ?? new Date().toISOString(),
    hypothesis: exp.hypothesis,
    result: {
      verdict: result.verdict,
      expectedUplift: result.expectedUplift,
      credibleInterval: result.ci,
      chanceToBeat: result.chanceToBeat,
      expectedLossRelative: result.expectedLossRelative,
      terminal: result.terminal,
    },
    metrics: {
      primaryMetric: exp.primaryMetric,
      guardrailChecks: result.guardrailViolations.map((name) => ({ name, violated: true })),
    },
    context: {
      channel: exp.channel,
      audience: exp.audience,
      variants: exp.variants.map((v) => ({ id: v.id, name: v.name, description: v.description })),
      minRuntimeDays: exp.minRuntimeDays,
      statedMde: exp.statedMde,
      pieIceScore: exp.pieIceScore,
    },
    followUps,
    caveats: [
      ...result.guidance,
      ...(result.badges.integrity.label !== "clean" ? [result.badges.integrity.detail] : []),
    ],
  };
}
