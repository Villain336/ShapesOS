// ShapesOS Phase 13 (twincore): drafting a layout — the records-only
// fallback and the model-proposal validator (codes → ids, kinds, grid,
// overlaps). Pure.
//   npx tsx --test lib/twin/__tests__/twin-layout-draft.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autoLayout, describeContext, normaliseModelLayout, type DraftContext } from "../layout-draft";
import { footprintProblem, overlapWith } from "../derive";

const ctx: DraftContext = {
  kind: "warehouse",
  locations: [
    { id: "z1", parentId: null, kind: "zone", code: "A", name: "Storage" },
    { id: "r1", parentId: "z1", kind: "rack", code: "A-01", name: null },
    { id: "r2", parentId: "z1", kind: "rack", code: "A-02", name: null },
    { id: "z2", parentId: null, kind: "zone", code: "STG", name: "Staging" },
    { id: "d1", parentId: null, kind: "dock", code: "D1", name: "Dock 1" },
    { id: "d2", parentId: null, kind: "dock", code: "D2", name: null },
  ],
  workCenters: [{ id: "wc1", code: "CNC-1", name: "CNC" }],
  registers: [],
};

describe("autoLayout (no live model)", () => {
  it("lays out every record once, inside the grid, without overlaps", () => {
    const l = autoLayout(ctx);
    const bound = l.objects.filter((o) => o.bindingId).map((o) => o.bindingId).sort();
    assert.deepEqual(bound, ["d1", "d2", "r1", "r2", "wc1", "z2"], "racks, the rack-less zone, docks and the work centre (zone A holds racks)");
    for (const o of l.objects) assert.equal(footprintProblem(o, l), null, o.label);
    l.objects.forEach((o, i) => assert.equal(overlapWith({ id: String(i), kind: o.kind, label: o.label, footprint: o }, l.objects.map((p, j) => ({ id: String(j), kind: p.kind, label: p.label, footprint: p }))), null, o.label));
    assert.equal(l.objects.filter((o) => o.kind === "dock_door").every((o) => o.bindingType === "location"), true);
    assert.ok(l.notes.some((n) => /Equipment/.test(n)));
  });
  it("an empty warehouse gives an empty draft and says so", () => {
    const l = autoLayout({ kind: "store", locations: [], workCenters: [], registers: [] });
    assert.equal(l.objects.length, 0);
    assert.ok(l.notes.some((n) => /no racks/.test(n)));
  });
});

describe("normaliseModelLayout", () => {
  it("resolves codes to ids, refuses wrong kinds, drops off-grid and overlapping objects", () => {
    const l = normaliseModelLayout(
      {
        gridW: 30,
        gridD: 20,
        objects: [
          { kind: "rack", label: "Rack A-01", x: 1, z: 1, w: 3, d: 8, bind: "a-01" },
          { kind: "dock_door", label: "Dock 1", x: 1, z: 17, w: 4, d: 2, bind: "D1" },
          { kind: "dock_door", label: "Dock wrong", x: 6, z: 17, w: 4, d: 2, bind: "A-02" },
          { kind: "work_center", label: "CNC", x: 10, z: 1, w: 4, d: 4, bind: "CNC-1" },
          { kind: "rack", label: "On top", x: 2, z: 2, w: 2, d: 2 },
          { kind: "rack", label: "Off grid", x: 28, z: 1, w: 5, d: 2 },
          { kind: "spaceship", label: "?", x: 0, z: 0, w: 1, d: 1 },
          { kind: "path", label: "Aisle", x: 0, z: 10, w: 30, d: 1 },
        ],
      },
      ctx,
    );
    assert.deepEqual(
      l.objects.map((o) => [o.label, o.bindingType ?? null, o.bindingId ?? null]),
      [
        ["Rack A-01", "location", "r1"],
        ["Dock 1", "location", "d1"],
        ["Dock wrong", null, null],
        ["CNC", "work_center", "wc1"],
        ["Aisle", null, null],
      ],
    );
    assert.ok(l.notes.some((n) => /"Dock wrong" left unbound/.test(n)));
    assert.ok(l.notes.some((n) => /"On top": it overlaps "Rack A-01"/.test(n)));
    assert.ok(l.notes.some((n) => /"Off grid"/.test(n)));
    assert.ok(l.notes.some((n) => /unknown kind "spaceship"/.test(n)));
  });
  it("clamps the grid and survives garbage", () => {
    assert.deepEqual([normaliseModelLayout({ gridW: 9999, gridD: 1 }, ctx).gridW, normaliseModelLayout({ gridW: 9999, gridD: 1 }, ctx).gridD], [400, 4]);
    assert.equal(normaliseModelLayout(null, ctx).objects.length, 0);
  });
  it("the model sees codes, never ids", () => {
    const text = describeContext(ctx);
    assert.match(text, /rack A-01/);
    assert.match(text, /CNC-1/);
    assert.doesNotMatch(text, /\br1\b|\bwc1\b/);
  });
});
