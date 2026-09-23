// Marketr — LLM provider factory (Phase D: Direction B routing).
//
// New code should call getLlmProviderFor(workload) from ./router:
//   "copy"       → client-facing articles, briefs, refreshes (claude-haiku-4-5)
//   "bulk"       → agent loop, skill runs, summaries, reports (gpt-5-nano)
//   "background" → digests, decay checks (gpt-5-nano:flex)
//
// getLlmProvider() is kept for back-compat and now resolves the "bulk"
// workload (the old single-provider default), honoring legacy LLM_MODEL as a
// bulk override. llmStatus() keeps its old top-level shape (based on bulk,
// the historical default) and adds per-workload routing detail.

import { getLlmProviderFor, llmRoutingStatus, resolveWorkload } from "./router";
import type { LlmProvider } from "./types";
import type { LlmWorkload } from "./router";

export type { LlmProvider, LlmWorkload };
export { getLlmProviderFor, llmRoutingStatus, WORKLOAD_DEFAULTS, WORKLOAD_MAX_TOKENS } from "./router";

/** Back-compat factory. Resolves the "bulk" workload (the pre-D default). */
export function getLlmProvider(): LlmProvider {
  return getLlmProviderFor("bulk");
}

export function llmStatus() {
  const routing = llmRoutingStatus();
  const bulk = routing.bulk;
  // Top-level shape is unchanged for existing consumers (mock banners,
  // Settings → Providers, API responses). isLive is true when ANY workload
  // is live so the mock banner never misleads (T7).
  return {
    name: bulk.name,
    isLive:
      routing.copy.isLive || routing.bulk.isLive || routing.background.isLive,
    configured: bulk.configured,
    model: bulk.model,
    routing,
  };
}

/** Resolve detail for one workload (test/ops visibility). */
export function llmWorkloadStatus(workload: LlmWorkload) {
  return resolveWorkload(workload);
}
