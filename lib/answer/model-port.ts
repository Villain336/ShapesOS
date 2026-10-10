// ShapesOS — Phase 21A (WS=agentweb): the answer engine's language model, over the router.
//
// Planning and reranking run on the cheap "bulk" workload; writing the answer on
// the "subagent" workload (Sonnet-class). Every call is metered like any other
// model call (lib/llm/usage.ts, 1.5× provider cost; 0 credits on the workspace's
// own key). The credits the engine counts against its per-answer cap are worked
// out here with the SAME rule (llmCallCharge), so the cap and the bill agree.
// With no live model for a workload, canRun is false and the engine falls back
// to rules (plan) or an extract of the sources (writing).

import { llmTokenCredits } from "@/lib/metering/credits";
import { billableCostMicroUsd } from "@/lib/llm/pricing";
import { llmCallCharge } from "@/lib/llm/usage";
import { getLlmProviderForWorkspace, resolveWorkloadForWorkspace } from "@/lib/llm/workspace";
import type { LlmWorkload } from "@/lib/llm/router";
import type { ModelPort, ModelWorkload } from "./engine";

const WORKLOAD: Record<ModelWorkload, LlmWorkload> = { plan: "bulk", rerank: "bulk", synth: "subagent" };

export async function workspaceModelPort(ctx: { workspaceId: string; projectId?: string | null; userId: string; runId?: string | null }): Promise<ModelPort> {
  const resolved = {
    bulk: await resolveWorkloadForWorkspace("bulk", ctx.workspaceId),
    subagent: await resolveWorkloadForWorkspace("subagent", ctx.workspaceId),
  };
  const of = (w: ModelWorkload) => resolved[WORKLOAD[w] as "bulk" | "subagent"];
  return {
    canRun: (w) => of(w).provider.isLive,
    estimateCredits(w, inputChars, maxTokens) {
      const r = of(w);
      if (r.keySource && r.keySource !== "platform") return 0;
      const { costMicroUsd } = billableCostMicroUsd(r.requestedModel, { inputTokens: Math.ceil(inputChars / 3), outputTokens: maxTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
      return llmTokenCredits(costMicroUsd);
    },
    async complete(w, req) {
      const llm = await getLlmProviderForWorkspace(WORKLOAD[w], { workspaceId: ctx.workspaceId, projectId: ctx.projectId ?? null, actorId: ctx.userId, runId: ctx.runId ?? null, agentKey: "answer", billing: "tokens" });
      const res = await llm.chat({ system: req.system, messages: [{ role: "user", content: req.user }], maxTokens: req.maxTokens });
      const charge = llmCallCharge({ model: res.model, usage: res.usage, keySource: llm.keySource, serviceTier: res.serviceTier, billing: "tokens" });
      return { text: res.content.map((b) => (b.type === "text" ? b.text : "")).join(""), credits: charge.credits, costMicroUsd: res.costMicroUsd ?? charge.billableCostMicroUsd };
    },
  };
}
