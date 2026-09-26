// Marketr — Knowledge Brain: force-layout tests.
// Run: npx tsx --test lib/intelligence/corpus/__tests__/graph-layout.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLayout } from "../graph-layout";

const NODES = [
  { id: "a", pillar: "marketing" as const, radius: 10 },
  { id: "b", pillar: "marketing" as const, radius: 8 },
  { id: "c", pillar: "design" as const, radius: 12 },
  { id: "d", pillar: "growth" as const, radius: 6 },
];
const EDGES = [{ from: "a", to: "b" }];

describe("createLayout", () => {
  it("settles: mean speed decays over ticks and no coordinate is NaN", () => {
    const sim = createLayout(NODES, EDGES, { width: 800, height: 600 });
    const early = (() => { for (let i = 0; i < 5; i++) sim.step(); return sim.meanSpeed(); })();
    for (let i = 0; i < 400; i++) sim.step();
    const late = sim.meanSpeed();
    assert.ok(late < early, `expected decay, early=${early} late=${late}`);
    for (const [, p] of sim.positions()) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), "NaN coordinate");
    }
  });

  it("keeps nodes inside soft bounds", () => {
    const sim = createLayout(NODES, EDGES, { width: 800, height: 600 });
    for (let i = 0; i < 300; i++) sim.step();
    for (const [, p] of sim.positions()) {
      assert.ok(p.x >= 0 && p.x <= 800 && p.y >= 0 && p.y <= 600);
    }
  });

  it("pin holds a node fixed while others move", () => {
    const sim = createLayout(NODES, EDGES, { width: 800, height: 600 });
    sim.pin("a", 100, 100);
    assert.ok(sim.isPinned("a"));
    for (let i = 0; i < 50; i++) sim.step();
    const p = sim.positions().get("a")!;
    assert.equal(p.x, 100);
    assert.equal(p.y, 100);
    sim.unpin("a");
    assert.ok(!sim.isPinned("a"));
  });

  it("linked nodes end up closer than unlinked cross-pillar nodes", () => {
    const sim = createLayout(NODES, EDGES, { width: 800, height: 600 });
    for (let i = 0; i < 500; i++) sim.step();
    const pos = sim.positions();
    const dist = (x: string, y: string) => {
      const a = pos.get(x)!;
      const b = pos.get(y)!;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    // a–b share an edge AND a pillar; c is a lone design node pulled to its own anchor.
    assert.ok(dist("a", "b") < dist("a", "c"), `linked ${dist("a", "b")} vs unlinked ${dist("a", "c")}`);
  });

  it("ignores edges referencing unknown nodes", () => {
    const sim = createLayout(NODES, [...EDGES, { from: "a", to: "ghost" }], { width: 800, height: 600 });
    for (let i = 0; i < 50; i++) sim.step();
    assert.equal(sim.positions().size, 4);
  });
});
