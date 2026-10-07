// Phase 19B (WS=engine) — results: RANGES over N seeded runs (never a single
// number), the A/B comparison with testlab-style badges (underpowered →
// inconclusive), and "no calibration → no verdict".

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareVariants, rangeOf, seriesRanges } from "../results";

describe("rangeOf", () => {
  it("min, quartiles, median, max, mean and sample sd of the seeds", () => {
    const r = rangeOf([3, 1, 2, 5, 4]);
    assert.deepEqual({ min: r.min, p25: r.p25, median: r.median, p75: r.p75, max: r.max, mean: r.mean, n: r.n }, { min: 1, p25: 2, median: 3, p75: 4, max: 5, mean: 3, n: 5 });
    assert.ok(Math.abs(r.sd - Math.sqrt(2.5)) < 1e-12);
  });

  it("interpolates quartiles between seeds, and a single seed has no spread to report", () => {
    const r = rangeOf([10, 20]);
    assert.equal(r.median, 15);
    assert.equal(r.p25, 12.5);
    const one = rangeOf([7]);
    assert.deepEqual([one.min, one.median, one.max, one.sd, one.n], [7, 7, 7, 0, 1]);
    assert.throws(() => rangeOf([]), /at least one seed/);
  });
});

describe("seriesRanges", () => {
  it("one range per day across seeds; a seed that stopped early only counts for the days it ran", () => {
    const out = seriesRanges([
      [1, 2, 3],
      [3, 4, 5],
      [2, 3],
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual([out[0]!.min, out[0]!.median, out[0]!.max, out[0]!.n], [1, 2, 3, 3]);
    assert.deepEqual([out[2]!.min, out[2]!.max, out[2]!.n], [3, 5, 2]);
  });
});

describe("compareVariants (paired by seed)", () => {
  const A = [0.1, 0.12, 0.11, 0.09, 0.1];
  const B = [0.2, 0.22, 0.19, 0.21, 0.23];

  it("B ahead in every seed, enough seeds and residents, calibrated → a verdict, with the spread shown", () => {
    const c = compareVariants({ a: A, b: B, residents: 500, calibration: { launches: 2, score: 0.04 }, calibratedResidents: 300 });
    assert.equal(c.verdict, "b_ahead");
    assert.equal(c.badges.power, "powered");
    assert.ok(c.difference.min > 0);
    assert.equal(c.withheld, null);
  });

  it("no calibration data → no verdict (the ranges still show)", () => {
    const c = compareVariants({ a: A, b: B, residents: 500, calibration: { launches: 0, score: null }, calibratedResidents: 300 });
    assert.equal(c.verdict, null);
    assert.equal(c.withheld, "no_calibration");
    assert.ok(c.difference.min > 0);
  });

  it("no calibrated residents (sliders only) → no verdict either", () => {
    assert.equal(compareVariants({ a: A, b: B, residents: 500, calibration: { launches: 3, score: 0.02 }, calibratedResidents: 0 }).withheld, "no_calibration");
  });

  it("fewer than 3 seeds is underpowered → inconclusive", () => {
    const c = compareVariants({ a: [0.1, 0.1], b: [0.3, 0.3], residents: 500, calibration: { launches: 2, score: 0.04 }, calibratedResidents: 300 });
    assert.equal(c.badges.power, "underpowered");
    assert.equal(c.verdict, "inconclusive");
  });

  it("a small town can't detect a small lift → underpowered → inconclusive, even when B wins every seed", () => {
    const c = compareVariants({ a: [0.1, 0.1, 0.1, 0.1], b: [0.12, 0.12, 0.12, 0.12], residents: 50, calibration: { launches: 2, score: 0.04 }, calibratedResidents: 50 });
    assert.equal(c.badges.power, "underpowered");
    assert.equal(c.verdict, "inconclusive");
  });

  it("seeds that disagree on the sign → inconclusive", () => {
    const c = compareVariants({ a: [0.1, 0.3, 0.1, 0.3, 0.2], b: [0.3, 0.1, 0.3, 0.1, 0.2], residents: 500, calibration: { launches: 2, score: 0.04 }, calibratedResidents: 300 });
    assert.equal(c.verdict, "inconclusive");
  });
});
