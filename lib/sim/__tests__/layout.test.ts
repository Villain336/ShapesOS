// Phase 19B (WS=engine) — town layout: the zod schema and the procedural
// default town generator (seeded, small / medium).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateTown } from "../generate";
import { parseTownLayout, TownLayoutSchema, type TownLayout } from "../layout";

function tinyLayout(): TownLayout {
  return {
    version: 1,
    name: "Tiny",
    source: "generated",
    size: { width: 200, height: 100 },
    districts: [{ id: "d1", name: "Main", kind: "mixed", rect: { x: 0, y: 0, w: 200, h: 100 } }],
    lots: [
      { id: "home-1", districtId: "d1", kind: "home", name: "Home", rect: { x: 0, y: 0, w: 20, h: 20 }, roadNode: "a", walkNode: "wa" },
      { id: "shop-1", districtId: "d1", kind: "shop", owner: "you", name: "Your shop", rect: { x: 180, y: 0, w: 20, h: 20 }, roadNode: "b", walkNode: "wb" },
    ],
    roads: {
      nodes: [
        { id: "a", x: 0, y: 50 },
        { id: "b", x: 200, y: 50 },
      ],
      edges: [{ id: "ab", from: "a", to: "b", lanes: 2, speedKph: 50, oneWay: false }],
    },
    walkways: {
      nodes: [
        { id: "wa", x: 0, y: 55 },
        { id: "wb", x: 200, y: 55 },
      ],
      edges: [{ id: "wab", from: "wa", to: "wb" }],
    },
  };
}

describe("TownLayoutSchema", () => {
  it("accepts a hand-made layout", () => {
    assert.equal(TownLayoutSchema.safeParse(tinyLayout()).success, true);
  });

  it("rejects a road edge that points at an unknown node", () => {
    const l = tinyLayout();
    l.roads.edges[0]!.to = "nowhere";
    assert.throws(() => parseTownLayout(l), /roads\.edges\[0\]\.to.*unknown road node "nowhere"/);
  });

  it("rejects a shop with no owner, and a lot in an unknown district", () => {
    const l = tinyLayout();
    delete (l.lots[1] as { owner?: string }).owner;
    l.lots[0]!.districtId = "d9";
    const issues = TownLayoutSchema.safeParse(l).error?.issues.map((i) => i.message) ?? [];
    assert.ok(issues.some((m) => /shop lots need an owner/.test(m)), issues.join("; "));
    assert.ok(issues.some((m) => /unknown district "d9"/.test(m)), issues.join("; "));
  });

  it("rejects duplicate ids", () => {
    const l = tinyLayout();
    l.lots[1]!.id = "home-1";
    assert.throws(() => parseTownLayout(l), /duplicate lot id "home-1"/);
  });
});

describe("generateTown", () => {
  it("makes a valid small town with every lot kind and exactly one shop of yours", () => {
    const town = generateTown({ seed: 7, size: "small" });
    assert.doesNotThrow(() => parseTownLayout(town));
    const kinds = new Set(town.lots.map((l) => l.kind));
    for (const k of ["home", "work", "shop", "cafe", "park", "billboard"]) assert.ok(kinds.has(k as never), `has a ${k}`);
    assert.equal(town.lots.filter((l) => l.kind === "shop" && l.owner === "you").length, 1);
    assert.ok(town.lots.some((l) => l.kind === "shop" && l.owner === "competitor"), "a competitor storefront");
    assert.equal(town.source, "generated");
  });

  it("is deterministic per seed and differs across seeds", () => {
    assert.deepEqual(generateTown({ seed: 7, size: "small" }), generateTown({ seed: 7, size: "small" }));
    assert.notDeepEqual(generateTown({ seed: 7, size: "small" }), generateTown({ seed: 8, size: "small" }));
  });

  it("a medium town is bigger than a small one", () => {
    const s = generateTown({ seed: 1, size: "small" });
    const m = generateTown({ seed: 1, size: "medium" });
    assert.ok(m.lots.length > s.lots.length);
    assert.ok(m.roads.nodes.length > s.roads.nodes.length);
    assert.ok(m.lots.filter((l) => l.kind === "home").length >= 40, "room for 500 residents");
  });
});
