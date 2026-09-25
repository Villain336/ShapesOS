// Marketr — A1 AEO: weekly run orchestrator.
// N=3 reps per prompt per engine; cost estimator verifies the $1–5/mo/brand
// envelope before a run starts and flags (never hides) a breach.
// The orchestrator is dependency-injected so batteries can run it fully
// in-memory; the prisma sink wires it to the migrated tables.

import { prisma } from "@/lib/prisma";
import {
  AEO_ENGINES, NANO_GEN_COST_USD, JUDGE_CALL_COST_USD, AEO_MONTHLY_ENVELOPE_USD,
  type AeoEngineName, type AeoEngineClient, type EngineGeneration,
} from "./engines";
import { judgeResponse, type LlmJudge } from "./judge";

export const AEO_REPS_DEFAULT = 3;
export const WEEKS_PER_MONTH = 4.33; // weekly cadence → monthly envelope math

export interface RunCostEstimate {
  promptCount: number;
  engines: AeoEngineName[];
  reps: number;
  generations: number;
  judgeCalls: number;
  perEngine: Record<AeoEngineName, { generations: number; genCostUsd: number; judgeCostUsd: number; totalUsd: number }>;
  weeklyUsd: number;
  monthlyUsd: number;
  envelopeUsd: number;
  withinEnvelope: boolean;
}

/** Pure cost estimate for a run plan. Flags when the monthly envelope is breached. */
export function estimateRunCost(input: {
  promptCount: number;
  engines?: AeoEngineName[];
  reps?: number;
}): RunCostEstimate {
  const engines = input.engines ?? AEO_ENGINES;
  const reps = input.reps ?? AEO_REPS_DEFAULT;
  const perEngine = {} as RunCostEstimate["perEngine"];
  let weeklyUsd = 0;
  for (const engine of engines) {
    const generations = input.promptCount * reps;
    const genCostUsd = generations * NANO_GEN_COST_USD[engine];
    const judgeCostUsd = generations * JUDGE_CALL_COST_USD;
    const totalUsd = genCostUsd + judgeCostUsd;
    perEngine[engine] = { generations, genCostUsd, judgeCostUsd, totalUsd };
    weeklyUsd += totalUsd;
  }
  const monthlyUsd = weeklyUsd * WEEKS_PER_MONTH;
  return {
    promptCount: input.promptCount,
    engines,
    reps,
    generations: input.promptCount * engines.length * reps,
    judgeCalls: input.promptCount * engines.length * reps,
    perEngine,
    weeklyUsd,
    monthlyUsd,
    envelopeUsd: AEO_MONTHLY_ENVELOPE_USD,
    withinEnvelope: monthlyUsd <= AEO_MONTHLY_ENVELOPE_USD,
  };
}

export interface RunJob {
  promptIdx: number;
  rep: number;
  engine: AeoEngineName;
}

/** The full job list for a run: every (prompt × rep × engine) pair, engine-major. */
export function buildRunPlan(promptCount: number, engines: AeoEngineName[], reps: number): RunJob[] {
  const plan: RunJob[] = [];
  for (const engine of engines) {
    for (let promptIdx = 0; promptIdx < promptCount; promptIdx += 1) {
      for (let rep = 0; rep < reps; rep += 1) {
        plan.push({ promptIdx, rep, engine });
      }
    }
  }
  return plan;
}

export interface MentionRecord {
  promptIdx: number;
  rep: number;
  mentioned: boolean;
  position: number | null;
  sentiment: string | null;
  competitors: string[];
  citedSources: string[];
  judgeModel: string;
  judgeConfidence: number;
}

export interface MentionSink {
  record(m: MentionRecord): Promise<void>;
}

/** Memory twin of the aeo_mentions table (batteries). */
export function createMemoryMentionSink(): MentionSink & { mentions: MentionRecord[] } {
  const mentions: MentionRecord[] = [];
  return {
    mentions,
    async record(m) {
      mentions.push(m);
    },
  };
}

/** Prisma sink — writes each judged rep to aeo_mentions. */
export function createPrismaMentionSink(runId: string): MentionSink {
  return {
    async record(m) {
      await prisma.aeoMention.create({
        data: {
          runId,
          promptIdx: m.promptIdx,
          rep: m.rep,
          mentioned: m.mentioned,
          position: m.position,
          sentiment: m.sentiment,
          competitors: m.competitors,
          citedSources: m.citedSources,
          judgeModel: m.judgeModel,
          judgeConfidence: m.judgeConfidence,
        },
      });
    },
  };
}

export interface RunDeps {
  engineClients: Record<AeoEngineName, AeoEngineClient>;
  judge: LlmJudge;
  sink: MentionSink;
  brand: string;
  onProgress?: (done: number, total: number) => void;
}

export interface RunResult {
  mentionsRecorded: number;
  generations: number;
  costEstimate: RunCostEstimate;
  envelopeFlagged: boolean;
}

/**
 * Execute a full run plan: generate → judge → record. Each rep is
 * (prompt × engine), N reps; the judge parses every generation.
 * Cited sources merge native engine citations with judge-extracted ones.
 */
export async function executeRunPlan(
  deps: RunDeps,
  plan: RunJob[],
  prompts: string[],
  costEstimate: RunCostEstimate,
): Promise<RunResult> {
  let mentionsRecorded = 0;
  for (let i = 0; i < plan.length; i += 1) {
    const job = plan[i];
    const prompt = prompts[job.promptIdx];
    const client = deps.engineClients[job.engine];
    let generation: EngineGeneration;
    try {
      generation = await client.complete(prompt);
    } catch (err) {
      throw new Error(
        `Engine ${job.engine} failed on prompt ${job.promptIdx} rep ${job.rep}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const judgment = await judgeResponse(deps.judge, {
      engine: job.engine,
      prompt,
      responseText: generation.text,
      brand: deps.brand,
    });
    const cited = new Set<string>([...generation.nativeCitations, ...judgment.citedSources]);
    await deps.sink.record({
      promptIdx: job.promptIdx,
      rep: job.rep,
      mentioned: judgment.mentioned,
      position: judgment.position,
      sentiment: judgment.sentiment,
      competitors: judgment.competitors,
      citedSources: [...cited],
      judgeModel: deps.judge.name,
      judgeConfidence: judgment.confidence,
    });
    mentionsRecorded += 1;
    deps.onProgress?.(i + 1, plan.length);
  }
  return {
    mentionsRecorded,
    generations: plan.length,
    costEstimate,
    envelopeFlagged: !costEstimate.withinEnvelope,
  };
}
