// ShapesOS — Phase 7: price table and cost math (pure).
// Run: npx tsx --test lib/llm/__tests__/pricing.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODEL_PRICES, estimateCostMicroUsd, formatMicroUsd, priceFor } from "../pricing";
import { ANTHROPIC_RETENTION_MODELS, ANTHROPIC_ZDR_MODELS, WORKLOAD_DEFAULTS, FAMILY_WORKLOAD_DEFAULTS } from "../router";

const u = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

describe("price table", () => {
  it("has the Phase 7 prices (USD per 1M tokens) and cache writes at 1.25× input", () => {
    assert.deepEqual(
      Object.fromEntries(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "gpt-5.5", "gpt-5-nano"].map((m) => {
        const p = priceFor(m)!;
        return [m, [p.input, p.output, p.cacheRead]];
      })),
      {
        "claude-fable-5-1": [10, 50, 0.25], // docs: 0.025× input on Fable 5.1
        "claude-opus-5-5": [4, 20, 0.2],
        "claude-sonnet-5-5": [2, 10, 0.2],
        "claude-haiku-4-5": [1, 5, 0.1],
        "gpt-5.5": [5, 30, 0.5],
        "gpt-5-nano": [0.05, 0.4, null],
      },
    );
    for (const [m, p] of Object.entries(MODEL_PRICES)) {
      if (p.source === "anthropic-docs") assert.equal(p.cacheWrite, Math.round(p.input! * 1.25 * 1000) / 1000, m);
    }
  });

  it("non-Anthropic prices are marked third-party; unknown ones are null, never guessed", () => {
    assert.equal(priceFor("gpt-5.5")!.source, "third-party");
    assert.equal(priceFor("gpt-5-nano")!.source, "third-party");
    assert.equal(priceFor("gpt-5-nano")!.cacheRead, null);
    assert.equal(priceFor("gpt-5.4-nano"), null);
    assert.equal(priceFor("gpt-5-nano:flex"), null, "flex is discounted by an unconfirmed amount");
  });

  it("every default agent model and every family agent default has a price", () => {
    for (const w of ["lead", "subagent", "code", "code_max"] as const) {
      assert.ok(priceFor(WORKLOAD_DEFAULTS[w]), w);
      assert.ok(priceFor(FAMILY_WORKLOAD_DEFAULTS.openai[w]), `openai ${w}`);
      assert.ok(priceFor(FAMILY_WORKLOAD_DEFAULTS.anthropic[w]), `anthropic ${w}`);
    }
    for (const m of [...ANTHROPIC_ZDR_MODELS, ...ANTHROPIC_RETENTION_MODELS]) assert.ok(priceFor(m), m);
  });
});

describe("estimateCostMicroUsd", () => {
  it("$/1M tokens is micro-USD per token", () => {
    assert.equal(estimateCostMicroUsd("claude-opus-5-5", u(1_000_000, 0)), 4_000_000);
    assert.equal(estimateCostMicroUsd("claude-opus-5-5", u(0, 1_000_000)), 20_000_000);
  });

  it("sums every token class", () => {
    // Opus 5.5: 1000×4 + 500×20 + 10000×0.2 + 2000×5 = 4000 + 10000 + 2000 + 10000
    assert.equal(estimateCostMicroUsd("claude-opus-5-5", u(1000, 500, 10_000, 2000)), 26_000);
    // Fable 5.1 cache read 0.25: 100000 × 0.25 = 25000
    assert.equal(estimateCostMicroUsd("claude-fable-5-1", u(0, 0, 100_000, 0)), 25_000);
    // gpt-5-nano: 0.05/0.40 — rounds to whole micro-USD
    assert.equal(estimateCostMicroUsd("gpt-5-nano", u(33, 7)), 4); // 1.65 + 2.8 = 4.45
  });

  it("the plan's typical coding task on Opus 5.5 is in the expected range", () => {
    // ~1.5M input with 90% cache hits, 60K output (no writes counted here).
    const micro = estimateCostMicroUsd("claude-opus-5-5", u(150_000, 60_000, 1_350_000, 0))!;
    assert.equal(micro, 150_000 * 4 + 60_000 * 20 + 1_350_000 * 0.2);
    assert.ok(micro / 1e6 > 1.5 && micro / 1e6 < 3.5, String(micro));
  });

  it("unknown model → null; a used token class with an unknown price → null; unused unknowns don't matter", () => {
    assert.equal(estimateCostMicroUsd("gpt-4o-mini", u(10, 10)), null);
    assert.equal(estimateCostMicroUsd("gpt-5-nano", u(10, 10, 5)), null);
    assert.equal(estimateCostMicroUsd("gpt-5-nano", u(10, 10, 0, 0)), 5); // 0.5 + 4
    assert.equal(estimateCostMicroUsd("gpt-5.5", u(0, 0, 0, 1)), null, "OpenAI has no cache-write price");
  });

  it("formats", () => {
    assert.equal(formatMicroUsd(0), "$0.00");
    assert.equal(formatMicroUsd(12_345), "$0.0123");
    assert.equal(formatMicroUsd(3_210_000), "$3.21");
  });
});
