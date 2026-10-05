// ShapesOS — Phase 7: price table and cost math (pure).
// Run: npx tsx --test lib/llm/__tests__/pricing.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODEL_PRICES, billableCostMicroUsd, estimateCostMicroUsd, fallbackPrice, formatMicroUsd, priceFor } from "../pricing";
import { ANTHROPIC_RETENTION_MODELS, ANTHROPIC_ZDR_MODELS, OPENAI_ZDR_MODELS, WORKLOAD_DEFAULTS, FAMILY_WORKLOAD_DEFAULTS } from "../router";

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
        "gpt-5-nano": [0.05, 0.4, 0.005],
      },
    );
    for (const [m, p] of Object.entries(MODEL_PRICES)) {
      if (p.source === "anthropic-docs") assert.equal(p.cacheWrite, Math.round(p.input! * 1.25 * 1000) / 1000, m);
    }
  });

  it("OpenAI prices come from OpenAI's own pricing page (Phase 15.2, checked 2026-10-05)", () => {
    for (const m of ["gpt-5.5", "gpt-5.4-nano", "gpt-5-nano", "gpt-5-nano:flex"]) {
      assert.equal(priceFor(m)!.source, "openai-docs", m);
      assert.equal(priceFor(m)!.cacheWrite, null, `${m}: OpenAI bills no cache-write premium`);
    }
    assert.deepEqual([priceFor("gpt-5.4-nano")!.input, priceFor("gpt-5.4-nano")!.output, priceFor("gpt-5.4-nano")!.cacheRead], [0.2, 1.25, 0.02]);
    // Flex = 50% of Standard on every class.
    const std = priceFor("gpt-5-nano")!;
    const flex = priceFor("gpt-5-nano:flex")!;
    assert.deepEqual([flex.input, flex.output, flex.cacheRead], [std.input! / 2, std.output! / 2, std.cacheRead! / 2]);
  });

  it("every routable text model has a price (nothing routable is billed at the fallback)", () => {
    for (const m of [...ANTHROPIC_ZDR_MODELS, ...ANTHROPIC_RETENTION_MODELS, ...OPENAI_ZDR_MODELS]) assert.ok(priceFor(m), m);
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
    assert.equal(estimateCostMicroUsd("claude-haiku-4-5", u(10, 10, 5)), 61); // 10 + 50 + 0.5 → 61 (rounded)
    assert.equal(estimateCostMicroUsd("gpt-5-nano", u(10, 10, 0, 0)), 5); // 0.5 + 4
    assert.equal(estimateCostMicroUsd("gpt-5.5", u(0, 0, 0, 1)), null, "OpenAI has no cache-write price");
  });

  it("formats", () => {
    assert.equal(formatMicroUsd(0), "$0.00");
    assert.equal(formatMicroUsd(12_345), "$0.0123");
    assert.equal(formatMicroUsd(3_210_000), "$3.21");
  });
});

describe("billableCostMicroUsd (Phase 15.2: never 0 for an unknown price)", () => {
  it("a priced model bills its estimate", () => {
    assert.deepEqual(billableCostMicroUsd("claude-opus-5-5", u(1000, 200, 5000, 400)), { costMicroUsd: 11_000, priced: true });
  });

  it("an unknown model bills at the most expensive known rate per class", () => {
    const fb = fallbackPrice();
    // The dearest known model is Fable 5.1 ($10 / $50); no class is below it.
    assert.ok(fb.input >= MODEL_PRICES["claude-fable-5-1"].input! && fb.output >= MODEL_PRICES["claude-fable-5-1"].output!);
    for (const p of Object.values(MODEL_PRICES)) {
      for (const c of ["input", "output", "cacheRead", "cacheWrite"] as const) if (p[c] !== null) assert.ok(fb[c] >= p[c]!, c);
    }
    const r = billableCostMicroUsd("some-unpriced-model", u(1000, 1000));
    assert.equal(r.priced, false);
    assert.equal(r.costMicroUsd, 1000 * fb.input + 1000 * fb.output);
    assert.ok(r.costMicroUsd > 0);
  });

  it("an unknown token-class price on a known model bills that class at the fallback (OpenAI cache writes)", () => {
    const r = billableCostMicroUsd("gpt-5.5", u(0, 0, 0, 10));
    assert.equal(r.priced, false);
    assert.equal(r.costMicroUsd, Math.ceil(10 * fallbackPrice().cacheWrite));
  });

  it("zero tokens cost zero", () => {
    assert.deepEqual(billableCostMicroUsd("nope", u(0, 0)), { costMicroUsd: 0, priced: false });
  });
});
