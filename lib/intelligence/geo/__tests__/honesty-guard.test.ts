// Marketr — Phase 10 M3: the no-single-score guard test.
//
// Fails the suite if any registered metric function in honesty.ts returns a
// bare number without CI metadata. This is the build gate behind the
// honest-labeling contract: a single-score regression breaks the build.
// Run: npx tsx --test lib/intelligence/geo/__tests__/honesty-guard.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as honesty from "../honesty";
import { assertMetricCarriesCi, METRIC_FIXTURES } from "../honesty";

describe("honesty guard: every metric function carries CI metadata", () => {
  for (const [name, args] of Object.entries(METRIC_FIXTURES)) {
    it(`${name} returns an honest metric, never a bare number`, () => {
      const fn = (honesty as Record<string, unknown>)[name];
      assert.equal(typeof fn, "function", `${name} is not exported as a function`);
      const result = (fn as (...a: unknown[]) => unknown)(...args);
      assertMetricCarriesCi(result, name); // throws on bare numbers
    });
  }

  it("the registry covers every metric-shaped export", () => {
    const helpers = new Set(["wilsonCI", "formatEstimatedRange", "assertMetricCarriesCi"]);
    const consts = new Set([
      "WILSON_Z",
      "CONFIDENCE_LEVEL",
      "UNSTABLE_SHARE_THRESHOLD",
      "API_UI_VARIANCE_THRESHOLD",
      "METRIC_FIXTURES",
    ]);
    for (const name of Object.keys(honesty)) {
      if (helpers.has(name) || consts.has(name)) continue;
      const v = (honesty as Record<string, unknown>)[name];
      if (typeof v === "function") {
        assert.ok(
          name in METRIC_FIXTURES,
          `${name} is a metric function but has no fixture in METRIC_FIXTURES — the guard cannot see it. Register it.`,
        );
      }
    }
  });
});

describe("assertMetricCarriesCi (the guard itself)", () => {
  it("throws on a bare number", () => {
    assert.throws(() => assertMetricCarriesCi(0.62, "rogueScore"), /bare number/);
  });

  it("throws on a bare string", () => {
    assert.throws(() => assertMetricCarriesCi("62%", "rogueLabel"), /bare string/);
  });

  it("throws when the honestMetric brand is missing", () => {
    assert.throws(
      () => assertMetricCarriesCi({ share: 0.62, confidenceInterval: [0.5, 0.7], n: 10 }, "unbranded"),
      /honestMetric brand/,
    );
  });

  it("throws when confidenceInterval is malformed", () => {
    assert.throws(
      () => assertMetricCarriesCi({ honestMetric: true, confidenceInterval: [0.5], n: 10 }, "badCi"),
      /confidenceInterval/,
    );
  });

  it("throws when n is missing", () => {
    assert.throws(
      () =>
        assertMetricCarriesCi(
          { honestMetric: true, confidenceInterval: [0.5, 0.7] },
          "noN",
        ),
      /sample size n/,
    );
  });

  it("passes a well-formed honest metric", () => {
    assert.doesNotThrow(() =>
      assertMetricCarriesCi(
        { honestMetric: true, confidenceInterval: [0.3, 0.7], n: 10, confidenceLevel: 0.95 },
        "good",
      ),
    );
  });
});
