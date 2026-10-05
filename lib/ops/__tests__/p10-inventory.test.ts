// ShapesOS Phase 10 (ops-core): inventory rules — location hierarchy, quant
// derivation from the ledger, reorder planning. Unit (no DB).
// Run: npx tsx --test lib/ops/__tests__/p10-inventory.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpsError } from "../doctype";
import { OPS_ENTITY_MAP } from "../entities";
import { assertLocationParent, assertMinMax, defaultVariantId, deriveQuants, locationPath, planReorder } from "../stock";

describe("location hierarchy (digital-twin clean)", () => {
  it("allows warehouse → zone → aisle → rack → shelf → bin, skipping levels", () => {
    assertLocationParent(null, "zone");
    assertLocationParent(null, "bin");
    assertLocationParent("zone", "aisle");
    assertLocationParent("zone", "rack");
    assertLocationParent("rack", "bin");
    assertLocationParent("shelf", "bin");
    assertLocationParent(null, "dock");
    assertLocationParent("zone", "dock");
  });

  it("refuses inversions, leaves with children and stray docks", () => {
    const bad: Array<[Parameters<typeof assertLocationParent>[0], Parameters<typeof assertLocationParent>[1]]> = [
      ["bin", "bin"],
      ["dock", "bin"],
      ["rack", "zone"],
      ["rack", "rack"],
      ["aisle", "dock"],
    ];
    for (const [p, c] of bad) {
      assert.throws(() => assertLocationParent(p, c), (e: unknown) => e instanceof OpsError && e.status === 422, `${p} → ${c}`);
    }
  });

  it("builds stable paths from immutable codes", () => {
    assert.equal(locationPath("WH-01", null, "A"), "WH-01/A");
    assert.equal(locationPath("WH-01", "WH-01/A", "A-03"), "WH-01/A/A-03");
  });

  it("warehouse and location codes are immutable through the API", () => {
    assert.equal(OPS_ENTITY_MAP["warehouses"]!.patchSchema.safeParse({ code: "X" }).success, false);
    assert.equal(OPS_ENTITY_MAP["locations"]!.patchSchema.safeParse({ code: "X" }).success, false);
    assert.equal(OPS_ENTITY_MAP["locations"]!.patchSchema.safeParse({ parentId: "X" }).success, false);
  });
});

describe("quants derive from the ledger", () => {
  it("sums deltas per product/variant/location and drops zero quants", () => {
    const q = deriveQuants([
      { productId: "p1", variantId: "v1", locationId: "L1", delta: 10 },
      { productId: "p1", variantId: "v1", locationId: "L1", delta: -3 },
      { productId: "p1", variantId: "v1", locationId: "L2", delta: 3 },
      { productId: "p1", variantId: "v1", locationId: "L2", delta: -3 },
      { productId: "p1", variantId: "v2", locationId: "L1", delta: 4 },
    ]);
    assert.deepEqual(
      q.map((x) => [x.variantId, x.locationId, x.qty]).sort(),
      [["v1", "L1", 7], ["v2", "L1", 4]].sort(),
    );
  });

  it("legacy rows without a variant land on the default variant", () => {
    const q = deriveQuants(
      [
        { productId: "p1", variantId: null, locationId: null, delta: 5 },
        { productId: "p1", variantId: defaultVariantId("p1"), locationId: null, delta: 2 },
      ],
      defaultVariantId,
    );
    assert.deepEqual(q, [{ productId: "p1", variantId: "pvd_p1", locationId: null, qty: 7 }]);
  });

  it("a transfer's paired legs keep the product total unchanged", () => {
    const before = [{ productId: "p1", variantId: "v", locationId: "A", delta: 10 }];
    const legs = [
      { productId: "p1", variantId: "v", locationId: "A", delta: -4 },
      { productId: "p1", variantId: "v", locationId: "B", delta: 4 },
    ];
    const total = (rows: typeof before) => deriveQuants(rows).reduce((s, x) => s + x.qty, 0);
    assert.equal(total([...before, ...legs]), total(before));
    const q = deriveQuants([...before, ...legs]);
    assert.equal(q.find((x) => x.locationId === "A")!.qty, 6);
    assert.equal(q.find((x) => x.locationId === "B")!.qty, 4);
  });
});

describe("reorder planning", () => {
  const rule = { minQty: 5, maxQty: 20, active: true };
  it("drafts max − on-hand on a breach", () => {
    assert.deepEqual(planReorder(rule, 5, null), { action: "draft", qty: 15 });
    assert.deepEqual(planReorder(rule, 0, null), { action: "draft", qty: 20 });
    assert.deepEqual(planReorder(rule, -2, null), { action: "draft", qty: 22 });
  });
  it("drafts once per breach: an open draft/sent PO blocks a second", () => {
    assert.deepEqual(planReorder(rule, 1, "draft"), { action: "skip", reason: "open_po" });
    assert.deepEqual(planReorder(rule, 1, "sent"), { action: "skip", reason: "open_po" });
    assert.equal(planReorder(rule, 1, "received").action, "draft");
    assert.equal(planReorder(rule, 1, "cancelled").action, "draft");
  });
  it("skips above the minimum and inactive rules", () => {
    assert.deepEqual(planReorder(rule, 6, null), { action: "skip", reason: "above_min" });
    assert.deepEqual(planReorder({ ...rule, active: false }, 0, null), { action: "skip", reason: "inactive" });
  });
  it("min/max validation", () => {
    assertMinMax(0, 1);
    for (const [a, b] of [[5, 5], [6, 5], [-1, 3], [1.5, 3]]) {
      assert.throws(() => assertMinMax(a!, b!), (e: unknown) => e instanceof OpsError && e.status === 422);
    }
  });
});
