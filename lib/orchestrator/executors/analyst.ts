// Marketr — Phase 9 M2: Analyst executor (SPEC §P9A).
//
// Reads results, attributes outcomes, and writes to Growth Memory
// (memory_learnings) — this is the learning-loop feed. Tools:
// substrate.context (read), memory.read, memory.write. No external side
// effects: the only write the analyst performs is the memory write, which
// is tenant-scoped, secret-scrubbed, and append-only per Phase 8 G3.

import { memoryRecall } from "../../substrate/memory/recall";
import { recordLearning } from "../../substrate/memory/write";
import type { LearningInput, RecallHit } from "../../substrate/memory/types";
import {
  assertToolAllowed,
  checkKillSwitchesFirst,
  estimateCostCents,
  type Citation,
  type GuardDeps,
} from "./_guard";

export const ANALYST_TOOLS = Object.freeze([
  "substrate.context",
  "memory.read",
  "memory.write",
]) as readonly string[];

export type AttributionResult = "worked" | "failed" | "inconclusive";

export interface AnalystInput {
  workspaceId: string;
  missionId?: string | null;
  hypothesis: string;
  action: string;
  result: AttributionResult;
  metricDelta?: Record<string, unknown>;
  contextRefs?: Record<string, unknown>;
  sourceEpisodeId?: string | null;
}

export interface AnalystDeps extends GuardDeps {
  /** Memory read. Default: the real recall path. */
  recall?: (workspaceId: string, query: string) => Promise<RecallHit[]>;
  /** Memory write. Default: the real Phase 8 write path (scrubbed, scoped). */
  writeLearning?: (
    workspaceId: string,
    input: LearningInput,
  ) => Promise<{ id: string; redactions: number }>;
}

export interface AnalystResult {
  executor: "analyst";
  learningId: string;
  attribution: string;
  citations: Citation[];
  costCents: number;
}

export async function runAnalyst(
  input: AnalystInput,
  deps: AnalystDeps = {},
): Promise<AnalystResult> {
  await checkKillSwitchesFirst(input, deps);
  assertToolAllowed("analyst", ANALYST_TOOLS, "memory.read");
  if (!input.hypothesis?.trim()) throw new Error("analyst: hypothesis is required.");
  if (!input.action?.trim()) throw new Error("analyst: action is required.");

  const recall = deps.recall ?? ((ws, q) => memoryRecall(ws, { query: q, topK: 5 }));
  const writeLearning = deps.writeLearning ?? recordLearning;

  // Read: what does Growth Memory already know about this hypothesis?
  const hits = await recall(input.workspaceId, `${input.hypothesis} ${input.action}`);
  const citations: Citation[] = hits.slice(0, 10).map((h) => ({
    type: "memory",
    id: h.refId,
    label: h.title,
  }));

  const priorNote =
    hits.length > 0
      ? `Growth Memory holds ${hits.length} related record(s); top: "${hits[0].title}".`
      : "No related records in Growth Memory — this is a first observation.";

  // Write: the attributed learning (selective, scrubbed, tenant-scoped by the write path).
  assertToolAllowed("analyst", ANALYST_TOOLS, "memory.write");
  const { id: learningId } = await writeLearning(input.workspaceId, {
    hypothesis: input.hypothesis,
    action: input.action,
    result: input.result,
    metricDelta: input.metricDelta ?? {},
    contextRefs: {
      ...(input.contextRefs ?? {}),
      missionId: input.missionId ?? null,
      attributedBy: "chief-strategy-agent",
    },
    // "campaign" is the closest existing source enum for mission-attributed
    // outcomes (M5 may add an orchestrator-specific source).
    source: "campaign",
    sourceEpisodeId: input.sourceEpisodeId ?? null,
  });

  const attribution =
    `Attributed outcome "${input.result}" for action "${input.action.slice(0, 120)}" ` +
    `against hypothesis "${input.hypothesis.slice(0, 120)}". ${priorNote} ` +
    `Learning recorded as memory_learnings:${learningId.slice(-8)}.`;

  return {
    executor: "analyst",
    learningId,
    attribution,
    citations,
    costCents: estimateCostCents(
      input.hypothesis.length + input.action.length,
      attribution.length,
    ),
  };
}
