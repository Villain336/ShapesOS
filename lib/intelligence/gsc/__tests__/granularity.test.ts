// Marketr — Phase 10 M1 tests: hourly vs daily granularity handling.
// Run: npx tsx --test lib/intelligence/gsc/__tests__/granularity.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregateRows, chooseSnapshots } from "../deltas";
import { scoreFromQueryAggregates } from "../scoring";
import type { GscSnapshotRow } from "../types";

function row(
  query: string,
  page: string,
  clicks: number,
  impressions: number,
  position: number,
): GscSnapshotRow {
  return { query, page, country: null, device: null, clicks, impressions, ctr: 0.05, position };
}

describe("chooseSnapshots", () => {
  const h = { granularity: "hourly" as const };
  const d = { granularity: "daily" as const };

  it("prefers hourly when any hourly snapshot is present", () => {
    const chosen = chooseSnapshots([d, h, d]);
    assert.ok(chosen.length === 1 && chosen[0] === h);
  });

  it("falls back to daily when no hourly snapshots exist", () => {
    const chosen = chooseSnapshots([d, d]);
    assert.equal(chosen.length, 2);
  });

  it("returns empty for an empty window", () => {
    assert.deepEqual(chooseSnapshots([]), []);
  });
});

describe("hourly chunks aggregate to daily totals", () => {
  it("24 hourly chunks sum to the same aggregates as one daily pull", () => {
    // Simulate: same query×page split across 24 hourly chunks.
    const hourlyRows: GscSnapshotRow[] = [];
    for (let h = 0; h < 24; h++) {
      hourlyRows.push(row("dentist greenville", "/services", 4 + h, 40 + h * 2, 3.0 + h * 0.05));
    }
    const dailyRows: GscSnapshotRow[] = [
      row(
        "dentist greenville",
        "/services",
        hourlyRows.reduce((s, r) => s + r.clicks, 0),
        hourlyRows.reduce((s, r) => s + r.impressions, 0),
        hourlyRows.reduce((s, r) => s + r.position * r.impressions, 0) /
          hourlyRows.reduce((s, r) => s + r.impressions, 0),
      ),
    ];
    const hAgg = aggregateRows(hourlyRows).get("/services␟dentist greenville")!;
    const dAgg = aggregateRows(dailyRows).get("/services␟dentist greenville")!;
    assert.equal(hAgg.clicks, dAgg.clicks);
    assert.equal(hAgg.impressions, dAgg.impressions);
    assert.ok(Math.abs(hAgg.position - dAgg.position) < 1e-9);
  });
});

describe("scoreFromQueryAggregates (shared lib/rankings math)", () => {
  it("scores 100 when every query ranks #1", () => {
    assert.equal(scoreFromQueryAggregates([{ query: "a", impressions: 100, position: 1 }]), 100);
  });

  it("scores 0 when nothing ranks", () => {
    assert.equal(scoreFromQueryAggregates([{ query: "a", impressions: 100, position: 0 }]), 0);
    assert.equal(scoreFromQueryAggregates([]), 0);
  });

  it("weights by impressions (higher-impression queries dominate)", () => {
    const highAtTop = scoreFromQueryAggregates([
      { query: "big", impressions: 1000, position: 1 },
      { query: "small", impressions: 10, position: 50 },
    ]);
    const lowAtTop = scoreFromQueryAggregates([
      { query: "big", impressions: 1000, position: 50 },
      { query: "small", impressions: 10, position: 1 },
    ]);
    assert.ok(highAtTop > lowAtTop, `impression weighting holds: ${highAtTop} > ${lowAtTop}`);
  });
});
