// Marketr — shared raw SERP pull (standalone SERP/keyword paths).
//
// DELIBERATELY UN-METERED: this helper imports nothing from lib/metering
// (pinned by battery — T14). Metering lives ONLY at the seams:
//   - POST /api/serp/analyze            → action "serp_analysis"
//   - MCP tool analyze_serp             → mcp_tool_call passthrough (serp_analysis credits)
//   - brief generation / rank checks    → parent actions only (content_brief, rank_check)
// Internal pulls inside other flows call pullSerp() and must NEVER add a
// serp_analysis charge for the same pull — one intent, one charge.

import { getSeoProvider, providerStatus } from "@/lib/providers";
import type {
  SerpResultsParams,
  SerpSnapshot,
} from "@/lib/providers/types";

export interface PulledSerp {
  snapshot: SerpSnapshot;
  provider: { name: string; isLive: boolean; configured: boolean };
}

/** Raw SERP pull. No metering, no authz — the caller owns both. */
export async function pullSerp(
  params: SerpResultsParams,
): Promise<PulledSerp> {
  const provider = getSeoProvider();
  const snapshot = await provider.serpResults(params);
  return { snapshot, provider: providerStatus() };
}
