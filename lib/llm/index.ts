// Marketr — LLM provider factory (Phase D: Direction B routing).
//
// New code should call getLlmProviderFor(workload) from ./router:
//   "copy"       → client-facing articles, briefs, refreshes (claude-haiku-4-5)
//   "bulk"       → agent loop, skill runs, summaries, reports (gpt-5-nano)
//   "background" → digests, decay checks (gpt-5-nano:flex)
//   Phase 7 agent workloads (chat() with native tools):
//   "lead"       → lead agent, planner (claude-opus-5-5, effort medium)
//   "subagent"   → researcher, writer, analyst, scheduler, operator (claude-sonnet-5-5)
//   "code"       → code agent (claude-opus-5-5, effort high)
//   "code_max"   → code agent escalation (claude-fable-5-1, opt-in retention)
//
// getLlmProvider() is kept for back-compat and now resolves the "bulk"
// workload (the old single-provider default), honoring legacy LLM_MODEL as a
// bulk override. llmStatus() keeps its old top-level shape (based on bulk,
// the historical default) and adds per-workload routing detail: the routed
// model, live/mock with the reason, single-key substitution and the armed
// failover model (Phase 6). Settings → Providers renders it.

import { getLlmProviderFor, llmRoutingStatus, resolveWorkload, LLM_WORKLOADS } from "./router";
import type { LlmProvider } from "./types";
import type { LlmWorkload, ResolveOptions } from "./router";

export type { LlmProvider, LlmWorkload };
export type {
  ChatContentBlock,
  ChatEffort,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStopReason,
  ChatStreamEvent,
  ChatToolDef,
  ChatUsage,
  ChatUsageContext,
} from "./types";
export type { LlmWorkloadStatus } from "./router";
export {
  getLlmProviderFor,
  llmRoutingStatus,
  workloadForAgent,
  AGENT_WORKLOADS,
  LLM_WORKLOADS,
  WORKLOAD_DEFAULTS,
  WORKLOAD_EFFORT,
  WORKLOAD_MAX_TOKENS,
} from "./router";
export { LlmProviderError, isRetryableLlmError } from "./errors";
export { estimateCostMicroUsd, formatMicroUsd, MODEL_PRICES } from "./pricing";
export { invalidToolResult } from "./tool-input";

/** Back-compat factory. Resolves the "bulk" workload (the pre-D default). */
export function getLlmProvider(): LlmProvider {
  return getLlmProviderFor("bulk");
}

/** Phase 15.1: pass a workspace's own keys to see routing as it sees it. */
export function llmStatus(opts: ResolveOptions = {}) {
  const routing = llmRoutingStatus(opts);
  const bulk = routing.bulk;
  // Top-level shape is unchanged for existing consumers (mock banners,
  // Settings → Providers, API responses). isLive is true when ANY workload
  // is live so the mock banner never misleads (T7).
  return {
    name: bulk.name,
    isLive: LLM_WORKLOADS.some((w) => routing[w].isLive),
    configured: bulk.configured,
    model: bulk.model,
    routing,
  };
}

/** Resolve detail for one workload (test/ops visibility). */
export function llmWorkloadStatus(workload: LlmWorkload) {
  return resolveWorkload(workload);
}
