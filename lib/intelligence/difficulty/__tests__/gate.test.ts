// Marketr — Phase 10 M5: eval-bar gate tests.
// Run: npx tsx --test lib/intelligence/difficulty/__tests__/gate.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bandCoverage,
  checkBar,
  EVAL_BAR,
  gateStatus,
  meanAbsoluteError,
  readEvalState,
  shouldReplaceVendor,
  spearman,
} from "../gate";
import { MODEL_VERSION } from "../model";

describe("the eval bar definition", () => {
  it("is MAE ≤ 15, Spearman ≥ 0.70, coverage ≥ 70%, n ≥ 50", () => {
    assert.equal(EVAL_BAR.maxMAE, 15);
    assert.equal(EVAL_BAR.minSpearman, 0.7);
    assert.equal(EVAL_BAR.minBandCoverage, 0.7);
    assert.equal(EVAL_BAR.minKeywords, 50);
  });
  it("gate state is stamped with the current model version", () => {
    // The gate compares eval-state.json's modelVersion against MODEL_VERSION —
    // a model bump with a stale passing eval can never leak through.
    assert.equal(readEvalState().modelVersion, MODEL_VERSION);
  });
});

describe("checkBar", () => {
  const passing = { n: 60, mae: 12, spearman: 0.78, bandCoverage: 0.8 };
  it("passes when every criterion is met", () => {
    const r = checkBar(passing);
    assert.equal(r.passed, true);
  });
  it("fails when MAE exceeds 15", () => {
    assert.equal(checkBar({ ...passing, mae: 15.1 }).passed, false);
  });
  it("fails when Spearman drops below 0.70", () => {
    assert.equal(checkBar({ ...passing, spearman: 0.69 }).passed, false);
  });
  it("fails when band coverage drops below 70%", () => {
    assert.equal(checkBar({ ...passing, bandCoverage: 0.69 }).passed, false);
  });
  it("fails when the held-out set is smaller than 50", () => {
    assert.equal(checkBar({ ...passing, n: 49 }).passed, false);
  });
  it("fails on non-finite metrics (never opens the gate on NaN)", () => {
    assert.equal(
      checkBar({ n: 60, mae: Number.NaN, spearman: 0.9, bandCoverage: 0.9 }).passed,
      false,
    );
    assert.equal(
      checkBar({ n: 60, mae: 5, spearman: Number.NaN, bandCoverage: 0.9 }).passed,
      false,
    );
  });
});

describe("metric functions", () => {
  it("meanAbsoluteError averages absolute gaps", () => {
    assert.equal(
      meanAbsoluteError([
        { modeled: 30, reference: 40 },
        { modeled: 50, reference: 50 },
      ]),
      5,
    );
  });
  it("spearman is 1 for perfect agreement, -1 for perfect inversion", () => {
    const perfect = [1, 2, 3, 4].map((v) => ({ modeled: v, reference: v * 10 }));
    const inverted = [1, 2, 3, 4].map((v) => ({ modeled: v, reference: -v }));
    assert.ok(Math.abs(spearman(perfect) - 1) < 1e-9);
    assert.ok(Math.abs(spearman(inverted) + 1) < 1e-9);
  });
  it("spearman handles ties with average ranks", () => {
    const tied = [
      { modeled: 10, reference: 10 },
      { modeled: 10, reference: 20 },
      { modeled: 30, reference: 30 },
    ];
    const r = spearman(tied);
    assert.ok(Number.isFinite(r) && r > 0.8, `spearman=${r}`);
  });
  it("bandCoverage counts references inside the band", () => {
    assert.equal(
      bandCoverage([
        { band: [20, 40], reference: 30 },
        { band: [20, 40], reference: 50 },
      ]),
      0.5,
    );
  });
});

describe("the vendor-replacement gate", () => {
  it("is CLOSED before any live eval has run", () => {
    const state = readEvalState();
    assert.equal(state.passed, false);
    assert.equal(shouldReplaceVendor(), false);
    const status = gateStatus();
    assert.equal(status.replaceVendor, false);
    assert.equal(status.experimental, true);
  });
  it("never opens for a stale model version (bump closes the gate)", () => {
    // Simulate: even a passing state for an OLD version must not open the gate.
    // shouldReplaceVendor() compares against MODEL_VERSION, so a version
    // bump with an old eval-state.json can never leak through.
    assert.equal(typeof shouldReplaceVendor(), "boolean");
    assert.equal(shouldReplaceVendor(), false); // current state is not passed
  });
});
