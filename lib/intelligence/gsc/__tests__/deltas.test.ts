// Marketr — Phase 10 M1 tests: delta engine math.
// Run: npx tsx --test lib/intelligence/gsc/__tests__/deltas.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregateRows, diffAggregates, computeDeltas } from "../deltas";
import type { GscSnapshotRow } from "../types";

function row(
  query: string,
  page: string,
  clicks: number,
  impressions: number,
  position: number,
): GscSnapshotRow {
  return { query, page, country: "USA", device: "DESKTOP", clicks, impressions, ctr: 0.1, position };
}

describe("aggregateRows", () => {
  it("sums clicks/impressions and impression-weights position per page×query", () => {
    const agg = aggregateRows([
      row("dentist", "/a", 10, 100, 2.0),
      row("dentist", "/a", 10, 100, 4.0), // e.g. two hourly chunks
      row("dentist", "/b", 5, 50, 8.0),
    ]);
    assert.equal(agg.size, 2);
    const a = agg.get("/a␟dentist")!;
    assert.equal(a.clicks, 20);
    assert.equal(a.impressions, 200);
    assert.equal(a.position, 3.0); // (2*100 + 4*100) / 200
    const b = agg.get("/b␟dentist")!;
    assert.equal(b.position, 8.0);
  });

  it("handles zero-impression rows without dividing by zero", () => {
    const agg = aggregateRows([row("q", "/p", 0, 0, 5.0)]);
    assert.equal(agg.get("/p␟q")!.position, 0);
  });
});

describe("diffAggregates", () => {
  const pre = aggregateRows([
    row("dentist", "/a", 100, 1000, 5.0),
    row("implants", "/b", 50, 500, 3.0),
    row("gone", "/c", 20, 200, 9.0),
  ]);
  const post = aggregateRows([
    row("dentist", "/a", 150, 1200, 2.0), // improved: up 3 positions
    row("implants", "/b", 10, 400, 12.0), // declined: down 9 positions
    row("new", "/d", 5, 100, 4.0), // new pair, pre treated as zero
  ]);

  it("computes per-page×query deltas with the right signs", () => {
    const deltas = diffAggregates("proj1", pre, post);
    const byKey = new Map(deltas.map((d) => [`${d.page}|${d.query}`, d]));

    const dentist = byKey.get("/a|dentist")!;
    assert.equal(dentist.deltaClicks, 50);
    assert.equal(dentist.deltaImpressions, 200);
    assert.equal(dentist.deltaPosition, -3); // negative = moved UP
    assert.equal(dentist.projectId, "proj1");

    const implants = byKey.get("/b|implants")!;
    assert.equal(implants.deltaClicks, -40);
    assert.equal(implants.deltaPosition, 9); // positive = moved DOWN

    const gone = byKey.get("/c|gone")!;
    assert.equal(gone.deltaClicks, -20); // disappeared: post treated as zero
    assert.equal(gone.deltaImpressions, -200);

    const added = byKey.get("/d|new")!;
    assert.equal(added.deltaClicks, 5); // new: pre treated as zero
  });

  it("magnitude is 0–100 and the largest move scores highest", () => {
    const deltas = diffAggregates("proj1", pre, post);
    for (const d of deltas) {
      assert.ok(d.magnitude >= 0 && d.magnitude <= 100, `magnitude in range: ${d.magnitude}`);
    }
    const byKey = new Map(deltas.map((d) => [`${d.page}|${d.query}`, d]));
    // implants: biggest click+position move → highest magnitude
    assert.ok(byKey.get("/b|implants")!.magnitude >= byKey.get("/d|new")!.magnitude);
  });

  it("returns zero magnitudes when nothing moved", () => {
    const deltas = diffAggregates("proj1", pre, pre);
    assert.ok(deltas.every((d) => d.magnitude === 0));
    assert.ok(deltas.every((d) => d.deltaClicks === 0 && d.deltaPosition === 0));
  });
});

describe("computeDeltas signature", () => {
  it("exports the exact frozen signature M2 consumes", () => {
    // (workspaceId, projectId, pre, post) — 4 params.
    assert.equal(computeDeltas.length, 4);
    assert.equal(typeof computeDeltas, "function");
  });
});
