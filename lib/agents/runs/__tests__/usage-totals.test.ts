// ShapesOS — Phase 7: a run's model usage and cost for the run viewer (pure).
// Run: npx tsx --test lib/agents/runs/__tests__/usage-totals.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isUsageEvent, runUsageFacts, runUsageTotals } from "../usage";

const usage = (model: string, cost: number | null, tokens = { i: 100, o: 10, r: 0, w: 0 }) => ({
  type: "usage",
  payload: {
    kind: "llm_usage",
    provider: "anthropic",
    model,
    workload: "lead",
    inputTokens: tokens.i,
    outputTokens: tokens.o,
    cacheReadTokens: tokens.r,
    cacheWriteTokens: tokens.w,
    costMicroUsd: cost,
    usageEventId: "ue1",
  },
});

describe("runUsageTotals", () => {
  it("sums usage events only, by token class, and lists models", () => {
    const t = runUsageTotals([
      { type: "agui", payload: { inputTokens: 999 } },
      usage("claude-opus-5-5", 1250, { i: 100, o: 20, r: 1000, w: 50 }),
      usage("claude-sonnet-5-5", 300),
      { type: "usage", payload: { kind: "something_else", inputTokens: 5 } },
    ]);
    assert.deepEqual(t, {
      calls: 2,
      inputTokens: 200,
      outputTokens: 30,
      cacheReadTokens: 1000,
      cacheWriteTokens: 50,
      costMicroUsd: 1550,
      unpricedCalls: 0,
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
    });
    assert.equal(isUsageEvent({ type: "usage" }), true);
    assert.equal(isUsageEvent({ type: "note" }), false);
  });

  it("facts: none / priced / partly unpriced (a lower bound, said so) / all unpriced", () => {
    assert.deepEqual(runUsageFacts(runUsageTotals([])), [["Model cost", "No model calls recorded"]]);
    const priced = Object.fromEntries(runUsageFacts(runUsageTotals([usage("claude-opus-5-5", 12_345, { i: 1000, o: 50, r: 4000, w: 0 })])));
    assert.equal(priced["Model cost"], "$0.0123 (estimated)");
    assert.equal(priced["Model calls"], "1 on claude-opus-5-5");
    assert.equal(priced.Tokens, "5,000 in · 50 out · 4,000 read from cache");
    const partial = Object.fromEntries(runUsageFacts(runUsageTotals([usage("a", 1000), usage("b", null)])));
    assert.equal(partial["Model cost"], "At least $0.0010 (1 of 2 calls unpriced)");
    const none = Object.fromEntries(runUsageFacts(runUsageTotals([usage("b", null)])));
    assert.match(none["Model cost"], /Unknown/);
  });
});
