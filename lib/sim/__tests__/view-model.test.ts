// Phase 19B (WS=engine) — the TownViewModel seam (what the 2D map renders
// now and the 3D renderer consumes in milestone 3): playback of the streamed
// events, positions interpolated along each planned path, seeking from an
// hourly snapshot.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { positionOnPath, TownPlayback } from "../view-model";
import type { TownLayout } from "../layout";

const layout: TownLayout = {
  version: 1,
  name: "T",
  source: "generated",
  size: { width: 200, height: 100 },
  districts: [{ id: "d", name: "D", kind: "mixed", rect: { x: 0, y: 0, w: 200, h: 100 } }],
  lots: [
    { id: "home", districtId: "d", kind: "home", name: "Home", rect: { x: 0, y: 0, w: 20, h: 20 }, roadNode: "a", walkNode: "a" },
    { id: "shop", districtId: "d", kind: "shop", owner: "you", name: "Your store", rect: { x: 180, y: 0, w: 20, h: 20 }, roadNode: "a", walkNode: "a" },
    { id: "cafe", districtId: "d", kind: "cafe", name: "Café", rect: { x: 100, y: 80, w: 20, h: 20 }, roadNode: "a", walkNode: "a" },
  ],
  roads: { nodes: [{ id: "a", x: 0, y: 0 }], edges: [] },
  walkways: { nodes: [{ id: "a", x: 0, y: 0 }], edges: [] },
};
const people = [{ id: "r001", name: "Ana R.", segment: "s", homeLotId: "home" }];

describe("positionOnPath", () => {
  const path: Array<[number, number, number]> = [
    [0, 0, 600],
    [100, 0, 700],
    [100, 50, 800],
  ];
  it("interpolates between timestamped points, clamps before the start and after the end", () => {
    assert.deepEqual(positionOnPath(path, 650), { x: 50, y: 0 });
    assert.deepEqual(positionOnPath(path, 750), { x: 100, y: 25 });
    assert.deepEqual(positionOnPath(path, 100), { x: 0, y: 0 });
    assert.deepEqual(positionOnPath(path, 9_999), { x: 100, y: 50 });
  });
});

describe("TownPlayback → TownViewModel", () => {
  it("residents start at home, move along a trip's planned path, and stand at the lot they arrive at", () => {
    const p = new TownPlayback(layout, people);
    assert.deepEqual(p.viewAt(0).residents[0]!.position, { x: 10, y: 10 });
    p.apply([
      { seq: 0, t: 0, type: "day", d: { day: 0, weekday: 0, weather: "rain" } },
      { seq: 1, t: 10, type: "trip", r: "r001", lot: "shop", d: { mode: "walk", path: [[10, 10, 600], [190, 10, 780]] } },
      { seq: 2, t: 13, type: "arrive", r: "r001", lot: "shop", d: { activity: "store" } },
      { seq: 3, t: 13, type: "adopt", r: "r001", lot: "shop" },
    ]);
    const mid = p.viewAt(690);
    assert.equal(mid.residents[0]!.moving, true);
    assert.equal(mid.residents[0]!.mode, "walk");
    assert.deepEqual(mid.residents[0]!.position, { x: 100, y: 10 });
    assert.equal(mid.weather, "rain");
    const after = p.viewAt(13 * 60 + 30);
    assert.equal(after.residents[0]!.moving, false);
    assert.equal(after.residents[0]!.lot, "shop");
    assert.deepEqual(after.residents[0]!.position, { x: 190, y: 10 });
    assert.equal(after.residents[0]!.adopted, true);
    assert.equal(after.clock, "00:13");
  });

  it("a seek starts from an hourly snapshot", () => {
    const p = new TownPlayback(layout, people);
    p.loadSnapshot({ t: 1440 + 8 * 60, residents: [{ id: "r001", lot: "cafe", x: 110, y: 90, money: 100, interest: 0.4, adopted: false }], adopters: 0, visits: 3, yourRevenueCents: 0 });
    const v = p.viewAt((1440 + 8 * 60) * 60);
    assert.equal(v.day, 1);
    assert.equal(v.weekday, 1);
    assert.equal(v.residents[0]!.lot, "cafe");
    assert.deepEqual(v.residents[0]!.position, { x: 110, y: 90 });
  });

  it("a new location joins your stores when its intervention fires", () => {
    const p = new TownPlayback(layout, people);
    assert.deepEqual(p.viewAt(0).yourStores, ["shop"]);
    p.apply([{ seq: 0, t: 1440, type: "intervention", lot: "cafe", d: { kind: "new_location", day: 1, lotId: "cafe" } }]);
    assert.deepEqual(p.viewAt(1440 * 60).yourStores, ["cafe", "shop"]);
  });
});
