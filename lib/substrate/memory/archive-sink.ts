// Marketr — Growth Memory archive sink: real Prisma implementation (Phase 8 G3).
//
// Implements the GrowthMemorySink port from F3 (lib/flywheel/testlab/memory-sink)
// against the real memory tables: archiving a closed test writes BOTH a
// memory_episodes row (the closure event, durable history) and a
// memory_learnings row (the structured learning future optimizers recall).
// Secrets are scrubbed before persistence; verdict maps winner→worked,
// loser→failed, inconclusive/compromised→inconclusive.

import {
  GROWTH_MEMORY_SINK_SCHEMA,
  type GrowthLearning,
  type GrowthMemorySink,
} from "@/lib/flywheel/testlab/memory-sink";
import { recordEpisode, recordLearning } from "./write";
import type { MemoryLearningResult } from "./types";

const VERDICT_MAP: Record<string, MemoryLearningResult> = {
  winner: "worked",
  loser: "failed",
  inconclusive: "inconclusive",
  compromised: "inconclusive",
};

/** True when the caller explicitly wants the fake sink (tests, fixtures). */
export function useFakeMemorySink(): boolean {
  return process.env.MEMORY_TEST_MODE === "1";
}

/** Real sink: persists the learning + closure episode under tenant RLS. */
export function createPrismaMemorySink(): GrowthMemorySink {
  return {
    schema: GROWTH_MEMORY_SINK_SCHEMA,
    async archive(learning: GrowthLearning) {
      if (learning.schema !== GROWTH_MEMORY_SINK_SCHEMA) {
        throw new Error(`GrowthMemorySink: schema mismatch (got ${learning.schema})`);
      }
      const ws = learning.workspaceId;
      const result = VERDICT_MAP[learning.result.verdict] ?? "inconclusive";
      const episode = await recordEpisode(ws, {
        actor: "agent",
        episodeType: "run",
        summary:
          `Test Lab experiment ${learning.experimentId} archived with verdict ` +
          `${learning.result.verdict}. Primary metric ${learning.metrics.primaryMetric}; ` +
          `expected uplift ${learning.result.expectedUplift}; chance to beat ` +
          `${learning.result.chanceToBeat}. Follow-ups: ${learning.followUps.join(" ")}`.slice(0, 4000),
        refs: {
          growthMemorySchema: GROWTH_MEMORY_SINK_SCHEMA,
          experimentId: learning.experimentId,
          learningId: learning.learningId,
          archivedAt: learning.archivedAt,
          sink: "testlab",
        },
      });
      const stored = await recordLearning(ws, {
        hypothesis: learning.hypothesis.slice(0, 4000),
        action:
          `Ran experiment ${learning.experimentId} (${learning.metrics.primaryMetric}) ` +
          `over ${learning.context.minRuntimeDays}d on ${learning.context.channel}; ` +
          `variants: ${learning.context.variants.map((v) => v.name).join(", ")}`.slice(0, 4000),
        result,
        sourceEpisodeId: episode.id,
        source: "test_lab",
        contextRefs: {
          experimentId: learning.experimentId,
          learningId: learning.learningId,
          archivedAt: learning.archivedAt,
          expectedUplift: learning.result.expectedUplift,
          credibleInterval: learning.result.credibleInterval,
          chanceToBeat: learning.result.chanceToBeat,
          expectedLossRelative: learning.result.expectedLossRelative,
          terminal: learning.result.terminal,
          guardrailChecks: learning.metrics.guardrailChecks,
          audience: learning.context.audience,
          statedMde: learning.context.statedMde,
          pieIceScore: learning.context.pieIceScore,
          followUps: learning.followUps,
          caveats: learning.caveats,
        },
      });
      return { stored: true, ref: `memory://${ws}/${stored.id}` };
    },
  };
}
