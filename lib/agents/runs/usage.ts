// ShapesOS — Phase 7: a run's model usage and estimated cost (PURE).
//
// Every metered chat() call made for an AgentRun appends a `usage` event
// (lib/llm/usage.ts, payload RunUsagePayload). This sums them for the run
// viewer. Usage events are bookkeeping, not steps: the timeline skips them
// (isUsageEvent). A call whose price is unknown is counted as unpriced — the
// total is then a lower bound and says so; nothing is guessed.

import { formatMicroUsd } from "@/lib/llm/pricing";

export interface RunUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum over priced calls. */
  costMicroUsd: number;
  /** Calls whose cost is unknown (no price for the model / token class). */
  unpricedCalls: number;
  models: string[];
}

interface EventLike {
  type: string;
  payload?: unknown;
}

export function isUsageEvent(e: EventLike): boolean {
  return e.type === "usage";
}

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

export function runUsageTotals(events: readonly EventLike[]): RunUsageTotals {
  const t: RunUsageTotals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicroUsd: 0,
    unpricedCalls: 0,
    models: [],
  };
  const models = new Set<string>();
  for (const e of events) {
    if (!isUsageEvent(e)) continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (p.kind !== "llm_usage") continue;
    t.calls++;
    t.inputTokens += int(p.inputTokens);
    t.outputTokens += int(p.outputTokens);
    t.cacheReadTokens += int(p.cacheReadTokens);
    t.cacheWriteTokens += int(p.cacheWriteTokens);
    if (typeof p.costMicroUsd === "number" && Number.isFinite(p.costMicroUsd)) t.costMicroUsd += Math.round(p.costMicroUsd);
    else t.unpricedCalls++;
    if (typeof p.model === "string" && p.model) models.add(p.model);
  }
  t.models = [...models].sort();
  return t;
}

/** "About this run" facts: cost and tokens, in plain words. */
export function runUsageFacts(t: RunUsageTotals): Array<[string, string]> {
  if (t.calls === 0) return [["Model cost", "No model calls recorded"]];
  const cost =
    t.unpricedCalls === 0
      ? `${formatMicroUsd(t.costMicroUsd)} (estimated)`
      : t.unpricedCalls === t.calls
        ? "Unknown (no price for this model)"
        : `At least ${formatMicroUsd(t.costMicroUsd)} (${t.unpricedCalls} of ${t.calls} calls unpriced)`;
  const n = (v: number) => v.toLocaleString("en-US");
  const cached = t.cacheReadTokens + t.cacheWriteTokens;
  return [
    ["Model cost", cost],
    ["Model calls", `${n(t.calls)} on ${t.models.join(", ") || "unknown model"}`],
    ["Tokens", `${n(t.inputTokens + cached)} in · ${n(t.outputTokens)} out${cached ? ` · ${n(t.cacheReadTokens)} read from cache` : ""}`],
  ];
}
