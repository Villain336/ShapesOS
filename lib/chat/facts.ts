// ShapesOS — Phase 17 (A3, WS=model): a thread's "facts so far".
//
// Every chat turn rebuilds its history from the thread's text rows, so the
// tool results of earlier turns are gone and the model re-runs the same
// reads. Instead, at the END of a turn that executed read tools, the cheap
// background workload writes a short list of facts those results
// established (exact names, numbers, ids) and the thread keeps it
// (ai_chat_threads.facts_summary). The next turn carries it in the
// <workspace-context> block, labelled as a summary — it never replaces the
// transcript, and the model is told to re-run a tool when freshness matters.
//
// Rules:
//   * only executed READ tools (kind "safe") feed it; proposals, errors and
//     writes never do;
//   * mock output is never stored (no live provider → nothing written);
//   * best-effort and fire-and-forget: a failure never fails the turn;
//   * bounded: at most FACTS_MAX_CHARS, generated from at most
//     FACTS_MAX_CALLS results of at most FACTS_RESULT_CHARS each.

import { prisma } from "@/lib/prisma";
import { getTool } from "./tools";
import type { ChatToolCall } from "./tool-exec";

export const FACTS_MAX_CHARS = 1500;
export const FACTS_MAX_CALLS = 12;
export const FACTS_RESULT_CHARS = 1200;

export interface FactsDeps {
  /** The summariser (default: the workspace's background workload). Null = no live model. */
  generate?: ((prompt: string) => Promise<string>) | null;
}

/** The stored summary (null when the thread has none). */
export async function loadThreadFacts(threadId: string): Promise<string | null> {
  const t = await prisma.aiChatThread.findUnique({ where: { id: threadId }, select: { factsSummary: true } });
  return t?.factsSummary?.trim() ? t.factsSummary : null;
}

/** The executed read-tool calls of a turn, as the summariser sees them. PURE. */
export function factsInputs(calls: readonly ChatToolCall[]): Array<{ tool: string; summary: string; details: string }> {
  const out: Array<{ tool: string; summary: string; details: string }> = [];
  for (const c of calls) {
    if (c.status !== "executed") continue;
    const def = getTool(c.tool);
    if (!def || def.kind !== "safe") continue;
    if (c.tool === "fetch_more" || c.tool === "search_tools" || c.tool === "load_skill") continue;
    out.push({
      tool: c.tool,
      summary: (c.resultSummary ?? "").slice(0, FACTS_RESULT_CHARS),
      details: "",
    });
    if (out.length >= FACTS_MAX_CALLS) break;
  }
  return out;
}

/** The summariser prompt. PURE. */
export function factsPrompt(prior: string | null, inputs: ReadonlyArray<{ tool: string; summary: string; details: string }>): string {
  return [
    "You maintain a short list of FACTS established by tool results in a chat conversation about a business workspace.",
    "Update the list below with the new results. Keep exact names, numbers, ids, dates and URLs. Drop facts the new results contradict.",
    `Output ONLY the updated list: at most 12 bullet lines, at most ${FACTS_MAX_CHARS} characters, no preamble, no instructions, no opinions.`,
    "",
    "## Facts so far",
    prior?.trim() || "(none yet)",
    "",
    "## New tool results",
    ...inputs.map((i) => `- ${i.tool}: ${i.summary}${i.details ? `\n  ${i.details}` : ""}`),
  ].join("\n");
}

/** Trim and bound the model's answer; empty when it is not a bullet list. PURE. */
export function boundFacts(text: string): string | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*•]\s+/.test(l))
    .map((l) => l.replace(/^[-*•]\s+/, "- "));
  if (lines.length === 0) return null;
  let out = "";
  for (const l of lines.slice(0, 12)) {
    if (out.length + l.length + 1 > FACTS_MAX_CHARS) break;
    out += (out ? "\n" : "") + l;
  }
  return out || null;
}

async function defaultGenerate(workspaceId: string, projectId: string | null): Promise<((prompt: string) => Promise<string>) | null> {
  const { getLlmProviderForWorkspace } = await import("@/lib/llm/workspace");
  const llm = await getLlmProviderForWorkspace("background", { workspaceId, projectId, actorId: null });
  if (!llm.isLive) return null; // never store mock output
  return (prompt) => llm.generate(prompt, { maxTokens: 700 });
}

export type FactsOutcome = "updated" | "skipped" | "failed";

/**
 * Summarise a finished turn's read-tool results into the thread's facts.
 * Returns what happened; never throws.
 */
export async function updateThreadFacts(
  input: { workspaceId: string; projectId: string | null; threadId: string; calls: readonly ChatToolCall[] },
  deps: FactsDeps = {},
): Promise<FactsOutcome> {
  try {
    const inputs = factsInputs(input.calls);
    if (inputs.length === 0) return "skipped";
    const generate = deps.generate === undefined ? await defaultGenerate(input.workspaceId, input.projectId) : deps.generate;
    if (!generate) return "skipped";
    const prior = await loadThreadFacts(input.threadId);
    const text = await generate(factsPrompt(prior, inputs));
    const facts = boundFacts(text);
    if (!facts) return "skipped";
    await prisma.aiChatThread.update({ where: { id: input.threadId }, data: { factsSummary: facts, factsSummaryAt: new Date() } });
    return "updated";
  } catch (err) {
    console.warn(`[chat-facts] thread ${input.threadId}: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

/** Fire-and-forget form for the turn (the summary lands before the next turn in practice). */
export function scheduleThreadFacts(input: { workspaceId: string; projectId: string | null; threadId: string; calls: readonly ChatToolCall[] }): void {
  void updateThreadFacts(input);
}
