// Marketr — Phase 10 M3: honesty.ts math tests.
// Run: npx tsx --test lib/intelligence/geo/__tests__/honesty.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  wilsonCI,
  perEngineShare,
  nRepStability,
  leaderFlipRate,
  unstableShareReport,
  apiUiVarianceReport,
  formatEstimatedRange,
  UNSTABLE_SHARE_THRESHOLD,
  API_UI_VARIANCE_THRESHOLD,
} from "../honesty";

describe("wilsonCI", () => {
  it("is centered near the point estimate at large n", () => {
    const { lower, upper } = wilsonCI(600, 1000);
    assert.ok(lower < 0.6 && upper > 0.6, `expected bracket around 0.6, got [${lower}, ${upper}]`);
    assert.ok(upper - lower < 0.07, "large-n interval should be tight");
  });

  it("never exceeds [0,1]", () => {
    for (const [k, n] of [[0, 3], [3, 3], [1, 2], [0, 1]] as Array<[number, number]>) {
      const { lower, upper } = wilsonCI(k, n);
      assert.ok(lower >= 0 && upper <= 1, `k=${k} n=${n} escaped [0,1]`);
    }
  });

  it("widens at small n (uncertainty is honest)", () => {
    const small = wilsonCI(1, 2);
    const large = wilsonCI(500, 1000);
    assert.ok(small.upper - small.lower > large.upper - large.lower);
  });

  it("handles n=0 without NaN", () => {
    const { lower, upper } = wilsonCI(0, 0);
    assert.equal(lower, 0);
    assert.equal(upper, 0);
  });
});

describe("perEngineShare", () => {
  it("carries the honest-metric brand + CI metadata", () => {
    const s = perEngineShare("openai", 6, 10);
    assert.equal(s.honestMetric, true);
    assert.equal(s.share, 0.6);
    assert.equal(s.n, 10);
    assert.equal(s.confidenceInterval.length, 2);
    assert.ok(s.confidenceInterval[0] <= 0.6 && s.confidenceInterval[1] >= 0.6);
    assert.equal(s.confidenceLevel, 0.95);
  });
});

describe("nRepStability", () => {
  it("scores 1.0 when all reps agree", () => {
    const r = nRepStability([true, true, true]);
    assert.equal(r.stability, 1);
    assert.equal(r.flipRate, 0);
    assert.equal(r.modalOutcome, true);
  });

  it("scores 2/3 on a 2-of-3 split", () => {
    const r = nRepStability([true, true, false]);
    assert.ok(Math.abs(r.stability - 2 / 3) < 1e-9);
    assert.ok(Math.abs(r.flipRate - 1 / 3) < 1e-9);
  });

  it("handles empty reps without NaN", () => {
    const r = nRepStability([]);
    assert.equal(r.stability, 0);
    assert.equal(r.n, 0);
  });
});

describe("leaderFlipRate", () => {
  it("counts flips between consecutive runs", () => {
    const r = leaderFlipRate(["openai", "anthropic", "openai"]);
    assert.equal(r.flips, 2);
    assert.equal(r.pairs, 2);
    assert.equal(r.flipRate, 1);
  });

  it("is 0 when the leader never changes", () => {
    const r = leaderFlipRate(["openai", "openai", "openai"]);
    assert.equal(r.flipRate, 0);
  });

  it("handles a single run (no pairs)", () => {
    const r = leaderFlipRate(["openai"]);
    assert.equal(r.pairs, 0);
    assert.equal(r.flipRate, 0);
  });
});

describe("unstableShareReport", () => {
  it("flags unstable when unmentioned share exceeds 30%", () => {
    assert.equal(unstableShareReport("openai", 4, 10).unstable, true);
    assert.equal(UNSTABLE_SHARE_THRESHOLD, 0.3);
  });

  it("does not flag at or below 30%", () => {
    assert.equal(unstableShareReport("openai", 3, 10).unstable, false);
  });
});

describe("apiUiVarianceReport", () => {
  it("raises a data-quality event when variance exceeds 15%", () => {
    const r = apiUiVarianceReport("openai", 0.6, 0.4);
    assert.ok(Math.abs(r.variance - 0.2) < 1e-9);
    assert.equal(r.isDataQualityEvent, true);
    assert.equal(API_UI_VARIANCE_THRESHOLD, 0.15);
  });

  it("stays quiet at 15% or below", () => {
    assert.equal(apiUiVarianceReport("openai", 0.6, 0.45).isDataQualityEvent, false);
    assert.equal(apiUiVarianceReport("openai", 0.5, 0.5).isDataQualityEvent, false);
  });
});

describe("formatEstimatedRange", () => {
  it("never renders a bare score", () => {
    const s = perEngineShare("openai", 6, 10);
    const label = formatEstimatedRange(s);
    assert.match(label, /–/);
    assert.match(label, /n=10/);
  });
});
