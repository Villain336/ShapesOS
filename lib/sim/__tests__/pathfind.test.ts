// Phase 19B (WS=engine) — A* on hand-made road and walk graphs: the shortest
// route by travel time, no path, one-way roads, and timed paths.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { astar, roadGraph, timedPath, walkGraph } from "../pathfind";
import type { TownLayout } from "../layout";

/**
 *   a ──(slow 100m @ 10 km/h)── b
 *   │                           │
 *  (fast 100m @ 50)        (fast 100m @ 50)
 *   │                           │
 *   c ──(fast 100m @ 50)─────── d ──(one-way d→e, 100m @ 50)── e
 *                                                       f (isolated)
 */
function layout(): TownLayout {
  return {
    version: 1,
    name: "Hand-made",
    source: "generated",
    size: { width: 300, height: 200 },
    districts: [{ id: "d", name: "D", kind: "mixed", rect: { x: 0, y: 0, w: 300, h: 200 } }],
    lots: [{ id: "h", districtId: "d", kind: "home", name: "H", rect: { x: 0, y: 0, w: 5, h: 5 }, roadNode: "a", walkNode: "wa" }],
    roads: {
      nodes: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 100, y: 0 },
        { id: "c", x: 0, y: 100 },
        { id: "d", x: 100, y: 100 },
        { id: "e", x: 200, y: 100 },
        { id: "f", x: 300, y: 200 },
      ],
      edges: [
        { id: "ab", from: "a", to: "b", lanes: 1, speedKph: 10, oneWay: false },
        { id: "ac", from: "a", to: "c", lanes: 2, speedKph: 50, oneWay: false },
        { id: "bd", from: "b", to: "d", lanes: 2, speedKph: 50, oneWay: false },
        { id: "cd", from: "c", to: "d", lanes: 2, speedKph: 50, oneWay: false },
        { id: "de", from: "d", to: "e", lanes: 1, speedKph: 50, oneWay: true },
      ],
    },
    walkways: {
      nodes: [
        { id: "wa", x: 0, y: 0 },
        { id: "wb", x: 100, y: 0 },
        { id: "wc", x: 0, y: 100 },
      ],
      edges: [
        { id: "wab", from: "wa", to: "wb" },
        { id: "wbc", from: "wb", to: "wc" },
      ],
    },
  };
}

describe("A* on the road graph", () => {
  it("takes the faster detour over the slow direct street", () => {
    const g = roadGraph(layout());
    const r = astar(g, "a", "b");
    // a→c→d→b = 300 m at 50 km/h = 21.6 s; a→b directly = 100 m at 10 km/h = 36 s.
    assert.deepEqual(r?.nodes, ["a", "c", "d", "b"]);
    assert.ok(Math.abs(r!.seconds - 21.6) < 1e-9, String(r!.seconds));
  });

  it("follows a one-way street forwards but never against it", () => {
    const g = roadGraph(layout());
    assert.deepEqual(astar(g, "a", "e")?.nodes, ["a", "c", "d", "e"]);
    assert.equal(astar(g, "e", "a"), null);
  });

  it("returns null when there is no path, and a single node for from === to", () => {
    const g = roadGraph(layout());
    assert.equal(astar(g, "a", "f"), null);
    assert.equal(astar(g, "a", "nowhere"), null);
    assert.deepEqual(astar(g, "c", "c"), { nodes: ["c"], seconds: 0 });
  });
});

describe("A* on the walk graph", () => {
  it("walks undirected edges at walking speed", () => {
    const g = walkGraph(layout(), 1);
    const r = astar(g, "wc", "wa");
    // wc→wb = √(100²+100²) ≈ 141.42 m, wb→wa = 100 m, at 1 m/s.
    assert.deepEqual(r?.nodes, ["wc", "wb", "wa"]);
    assert.ok(Math.abs(r!.seconds - (100 * Math.SQRT2 + 100)) < 1e-9);
  });
});

describe("timedPath", () => {
  it("timestamps each point from the departure second, ending at departure + travel time", () => {
    const g = roadGraph(layout());
    const r = astar(g, "a", "b")!;
    const p = timedPath(g, "drive", r.nodes, 600);
    assert.equal(p.mode, "drive");
    assert.deepEqual(p.points.map((q) => [q.x, q.y]), [
      [0, 0],
      [0, 100],
      [100, 100],
      [100, 0],
    ]);
    // 100 m at 50 km/h = 7.2 s per edge; times are whole seconds (rounded).
    assert.deepEqual(p.points.map((q) => q.t), [600, 607, 614, 622]);
  });
});
