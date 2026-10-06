// Marketr — Wave 2 context.dev slice 3: agent-facing "research a question" tool.
//
// Kind "spend": each call burns Context.dev credits (10 fast / 100 ultra),
// so the agent framework holds it behind the confirmation gate — the same
// governed `run_research` posture as the HTTP API. The daily workspace
// budget gates the call before the vendor is hit; over-budget calls throw
// BUDGET_EXCEEDED (denials are never silent).

import type { ToolDef, ToolContext } from "@/lib/chat/tools";
import {
  runResearch,
  ResearchError,
  DEFAULT_RESEARCH_MODE,
} from "@/lib/knowledge/contextdev/research";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export const research_question: ToolDef = {
  name: "research_question",
  description:
    "Research a question on the live web (Context.dev): structured JSON plus cited source URLs. Costs credits (fast 10, ultra 100) against the daily budget — prefer fast. Uncited answers are refused.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The research question, e.g. \"What are Acme's current pricing plans?\".",
      },
      jsonFormat: {
        type: "string",
        description:
          "JSON describing the answer shape, e.g. '{\"plans\": [{\"name\": \"\", \"price\": \"\"}]}'. Keys become the fields the researcher fills in.",
      },
      mode: {
        type: "string",
        description: "\"fast\" (default, ≤30s, 10 credits) or \"ultra\" (≤50s, 100 credits, deeper research).",
      },
      locale: {
        type: "string",
        description: "Locale hint for the answer, e.g. \"en\", \"de\". Defaults to \"en\".",
      },
    },
    required: ["question", "jsonFormat"],
  },
  async execute(ctx: ToolContext, args: Record<string, unknown>) {
    const question = str(args.question);
    if (!question) throw new Error("question is required");
    let jsonFormat: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(str(args.jsonFormat) ?? "");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      jsonFormat = parsed as Record<string, unknown>;
    } catch {
      throw new Error("jsonFormat must be a JSON object describing the answer shape");
    }
    const modeRaw = str(args.mode)?.toLowerCase();
    const mode = modeRaw === "ultra" ? "ultra" : modeRaw === "fast" || !modeRaw ? "fast" : undefined;
    if (!mode) throw new Error('mode must be "fast" or "ultra"');
    try {
      const task = await runResearch(
        ctx.workspaceId,
        { question, jsonFormat, mode, locale: str(args.locale) ?? "en" },
      );
      const sources = task.sources as string[];
      return {
        summary: `Research ${task.status} (${task.confidence} confidence, ${task.creditsUsed} credits): ${question} — ${sources.length} source${sources.length === 1 ? "" : "s"} cited.`,
        details: {
          taskId: task.id,
          mode: task.mode,
          status: task.status,
          confidence: task.confidence,
          creditsUsed: task.creditsUsed,
          jsonContent: task.jsonContent,
          sources,
        },
      };
    } catch (err) {
      if (err instanceof ResearchError) throw new Error(err.message);
      throw err;
    }
  },
};

export { DEFAULT_RESEARCH_MODE };
