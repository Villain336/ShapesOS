// Marketr — Phase 10 M6 tests: band-not-point invariant + circuit breaker.
// Run: npx tsx --test lib/intelligence/providers/__tests__/invariant.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VOLUME_BANDS, isVolumeBand, pointToBand } from "../types";
import { budgetAllows, summarizeMeter } from "../meter";

const POINT_RE = /^\d+(\.\d+)?$/; // a bare number — the forbidden shape

describe("band-not-point invariant", () => {
  it("every band in VOLUME_BANDS is a band, never a bare point", () => {
    assert.ok(VOLUME_BANDS.length >= 7);
    for (const band of VOLUME_BANDS) {
      assert.ok(!POINT_RE.test(band), `band "${band}" must not be a bare number`);
      assert.ok(isVolumeBand(band), `"${band}" must be a registered band`);
    }
  });

  it("isVolumeBand rejects points and unknown strings", () => {
    assert.equal(isVolumeBand("4521"), false);
    assert.equal(isVolumeBand("12,300"), false);
    assert.equal(isVolumeBand(""), false);
    assert.equal(isVolumeBand("1K–10K"), true);
    assert.equal(isVolumeBand("1M+"), true);
  });

  it("pointToBand always returns a registered band, never a point", () => {
    for (const point of [0, 1, 9, 10, 99, 100, 999, 1000, 4521, 9999, 10_000, 50_000, 999_999, 1_000_000, 50_000_000]) {
      const band = pointToBand(point);
      assert.ok(!POINT_RE.test(band), `pointToBand(${point}) → "${band}" must not be a point`);
      assert.ok(isVolumeBand(band), `pointToBand(${point}) → "${band}" must be a registered band`);
    }
  });

  it("pointToBand boundary behavior is sane", () => {
    assert.equal(pointToBand(9), "0–10");
    assert.equal(pointToBand(10), "10–100");
    assert.equal(pointToBand(999), "100–1K");
    assert.equal(pointToBand(1000), "1K–10K");
  });
});

describe("circuit breaker (budgetAllows)", () => {
  it("throws when spend + estimate exceeds the cap", () => {
    assert.equal(budgetAllows(9_999, 10_000, 2), false); // 9999c + 2c > 10000c
  });

  it("allows when exactly at the cap", () => {
    assert.equal(budgetAllows(9_998, 10_000, 2), true);
  });

  it("allows everything when no cap is configured", () => {
    assert.equal(budgetAllows(1_000_000, null, 500_000), true);
  });

  it("zero-cost calls never trip the breaker", () => {
    assert.equal(budgetAllows(10_000, 10_000, 0), true);
  });
});

describe("summarizeMeter — cost summary aggregation", () => {
  it("aggregates by vendor × meter and totals correctly", () => {
    const s = summarizeMeter(
      [
        { vendor: "serper", meter: "serp_call", quantity: 1, costUsd: 0.001 },
        { vendor: "serper", meter: "serp_call", quantity: 1, costUsd: 0.001 },
        { vendor: "dataforseo", meter: "volume_lookup", quantity: 1, costUsd: 0.000132 },
      ],
      "2026-09",
    );
    assert.equal(s.totalCalls, 3);
    assert.ok(Math.abs(s.totalCostUsd - 0.002132) < 1e-9);
    assert.equal(s.rows.length, 2);
    const serper = s.rows.find((r) => r.vendor === "serper")!;
    assert.equal(serper.calls, 2);
    assert.equal(serper.quantity, 2);
  });

  it("computes the volume cache hit rate from vendor=volume_cache rows", () => {
    const s = summarizeMeter(
      [
        { vendor: "volume_cache", meter: "volume_lookup", quantity: 1, costUsd: 0 },
        { vendor: "volume_cache", meter: "volume_lookup", quantity: 1, costUsd: 0 },
        { vendor: "volume_cache", meter: "volume_lookup", quantity: 1, costUsd: 0 },
        { vendor: "vendor", meter: "volume_lookup", quantity: 1, costUsd: 0.000132 },
      ],
      "2026-09",
    );
    assert.equal(s.volumeCacheHitRate, 0.75);
  });

  it("returns null hit rate when there are no volume lookups", () => {
    const s = summarizeMeter([{ vendor: "serper", meter: "serp_call", quantity: 1, costUsd: 0.001 }], "2026-09");
    assert.equal(s.volumeCacheHitRate, null);
  });
});
