// Marketr — Wave 2 context.dev slice 3: ResearchTask execution.
//
// Agent-facing "research a question" runs through runResearch:
//   1. Budget gate (checkAndReserve) BEFORE the API is hit — the governed
//      `run_research` action; over-budget routes to approval, never charges.
//   2. POST /v1/web/answers with the question, answer-shape jsonFormat,
//      mode (fast default — ultra is 10x the price and needs explicit
//      opt-in), and locale hint.
//   3. Citation contract enforced: a sourced answer with zero sources is a
//      contract violation — the task is stored as failed (audit trail kept)
//      and a NO_SOURCES error is thrown, never a silent uncited answer.
//   4. The ResearchTask row records question, locale, json_content, source
//      URLs, confidence, and credits — "what did the agent know and when".
//
// Errors never carry the API key.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  createContextDevClient,
  ContextDevError,
  type ResearchAnswerMode,
  type ResearchAnswerResult,
} from "./client";
import { contextDevCreditsFor } from "./costs";
import { checkAndReserve } from "./budget-store";
import { resolveContextDevKey } from "./keys";

export class ResearchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ResearchError";
    this.code = code;
  }
}

export const RESEARCH_MODES: readonly ResearchAnswerMode[] = ["fast", "ultra"];
export const DEFAULT_RESEARCH_MODE: ResearchAnswerMode = "fast";

/**
 * Heuristic confidence for a sourced answer. Documented as heuristic —
 * the vendor does not return a confidence score.
 */
export function confidenceForAnswer(sourceCount: number, partial: boolean): number {
  if (sourceCount <= 0) return 0.2;
  if (partial) return 0.4;
  if (sourceCount >= 3) return 0.85;
  return 0.7;
}

/**
 * Citation contract: every stored answer must cite at least one source.
 * Throws NO_SOURCES on violation. Pure — unit-tested.
 */
export function validateAnswerContract(result: ResearchAnswerResult): void {
  if (!result.sources || result.sources.length === 0) {
    throw new ResearchError(
      "NO_SOURCES",
      "Research answer returned no source URLs — citation contract violated",
    );
  }
}

export interface RunResearchInput {
  question: string;
  jsonFormat: Record<string, unknown>;
  mode?: ResearchAnswerMode;
  locale?: string;
}

export async function runResearch(
  workspaceId: string,
  input: RunResearchInput,
  fetchImpl: typeof fetch = fetch,
) {
  const question = input.question.trim();
  if (!question) throw new ResearchError("BAD_QUESTION", "Research question is required");
  if (!input.jsonFormat || typeof input.jsonFormat !== "object" || Array.isArray(input.jsonFormat)) {
    throw new ResearchError("BAD_SHAPE", "jsonFormat must be a non-array object describing the answer shape");
  }
  const mode = input.mode ?? DEFAULT_RESEARCH_MODE;
  if (!RESEARCH_MODES.includes(mode)) {
    throw new ResearchError("BAD_MODE", `Research mode must be one of: ${RESEARCH_MODES.join(", ")}`);
  }
  const locale = input.locale?.trim() || "en";

  const cost = contextDevCreditsFor(mode === "ultra" ? "answers_ultra" : "answers_fast");
  const gate = await checkAndReserve(workspaceId, cost);
  if (gate.decision !== "allow") {
    throw new ResearchError("BUDGET_EXCEEDED", gate.reason);
  }

  const { apiKey } = await resolveContextDevKey(workspaceId);
  const client = createContextDevClient({ apiKey }, fetchImpl);

  let answer: ResearchAnswerResult;
  try {
    answer = await client.researchAnswer({ task: question, jsonFormat: input.jsonFormat, mode, locale });
  } catch (err) {
    const message =
      err instanceof ContextDevError
        ? `Context.dev ${err.code}`
        : err instanceof Error
          ? err.message
          : "Research failed";
    await prisma.researchTask.create({
      data: {
        workspaceId,
        question,
        locale,
        mode,
        status: "failed",
        jsonContent: {},
        sources: [],
        confidence: 0,
        creditsUsed: 0,
        error: message,
      },
    });
    throw new ResearchError(err instanceof ContextDevError ? err.code : "RESEARCH_FAILED", message);
  }

  try {
    validateAnswerContract(answer);
  } catch (err) {
    // Citation violation: keep the audit trail, refuse the answer.
    await prisma.researchTask.create({
      data: {
        workspaceId,
        question,
        locale,
        mode,
        status: "failed",
        jsonContent: answer.jsonContent as Prisma.InputJsonValue,
        sources: answer.sources,
        confidence: confidenceForAnswer(0, answer.partial),
        creditsUsed: cost,
        error: err instanceof ResearchError ? err.message : "Citation contract violated",
      },
    });
    throw err;
  }

  const confidence = confidenceForAnswer(answer.sources.length, answer.partial);
  const task = await prisma.researchTask.create({
    data: {
      workspaceId,
      question,
      locale,
      mode,
      status: answer.partial ? "partial" : "complete",
      jsonContent: answer.jsonContent as Prisma.InputJsonValue,
      sources: answer.sources,
      confidence,
      creditsUsed: cost,
    },
  });
  return task;
}

export async function listResearchTasks(workspaceId: string, limit = 50) {
  return prisma.researchTask.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
