// ShapesOS — Phase 13 (twinui): unit tests for the twin UI's pure layer —
// the RFC 6902 applier, grid ↔ world maths, fixtures against the contract,
// table / stepper / search derivations. No DB.
// Run: npx tsx --test lib/twin/__tests__/twin-ui.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTwinPatch, parsePointer } from "../patch";
import {
  clampFootprint,
  cellToWorld,
  facingWalls,
  fitZoom,
  footprintCenter,
  footprintsOverlap,
  frontDirection,
  isoCameraPosition,
  ISO_AZIMUTH,
  nextRotation,
  occupiedRect,
  occupiedSize,
  localSize,
  palletCount,
  rackSlots,
  rotateFootprint,
  rotationY,
  shelfSlots,
  truckPlacement,
  viewQuadrant,
  worldToCell,
} from "../scene-kit";
import { FACTORY_FIXTURE, STORE_FIXTURE, TWIN_FIXTURES, WAREHOUSE_FIXTURE, fixtureSiteList } from "../fixtures";
import {
  TWIN_BINDABLE,
  TWIN_DOCK_BOOKING_STATUSES,
  TWIN_OBJECT_KINDS,
  TWIN_SITE_KINDS,
  TWIN_SITE_STATUSES,
  type TwinPatchOp,
  type TwinSnapshot,
} from "../types";
import {
  agentsByObject,
  formatKpiValue,
  inspectorFacts,
  kindsPresent,
  pickShipment,
  recordHref,
  searchTwin,
  TWIN_TABS,
  twinTable,
} from "../view-model";
import { bookDockBody, createObjectBody, nextBookingStatus, opsSlug, patchObjectBody, TWIN_SLUGS } from "../client-api";
import { isAosStatus } from "@/lib/aos/status";
import { diffSnapshots, footprintProblem, overlapWith } from "../derive";

// ---------------------------------------------------------------------------
// patch.ts
// ---------------------------------------------------------------------------

describe("applyTwinPatch (RFC 6902 subset)", () => {
  const doc = { a: 1, list: [{ id: "x", v: 1 }, { id: "y", v: 2 }], nested: { "s/l": 1, "t~d": 2 } };

  it("replaces a value deep in an array by index, without mutating the input", () => {
    const r = applyTwinPatch(doc, [{ op: "replace", path: "/list/1/v", value: 9 }]);
    assert.ok(r.ok);
    assert.equal(r.value.list[1]!.v, 9);
    assert.equal(doc.list[1]!.v, 2, "input untouched");
    assert.equal(r.value.list[0], doc.list[0], "untouched siblings are shared");
    assert.notEqual(r.value.list, doc.list);
  });

  it("adds to an object, inserts into an array and appends with -", () => {
    const r = applyTwinPatch(doc, [
      { op: "add", path: "/b", value: "new" },
      { op: "add", path: "/list/0", value: { id: "w", v: 0 } },
      { op: "add", path: "/list/-", value: { id: "z", v: 3 } },
    ]);
    assert.ok(r.ok);
    assert.equal((r.value as Record<string, unknown>).b, "new");
    assert.deepEqual(r.value.list.map((x) => x.id), ["w", "x", "y", "z"]);
  });

  it("removes object members and array items", () => {
    const r = applyTwinPatch(doc, [
      { op: "remove", path: "/a" },
      { op: "remove", path: "/list/0" },
    ]);
    assert.ok(r.ok);
    assert.equal("a" in r.value, false);
    assert.deepEqual(r.value.list.map((x) => x.id), ["y"]);
  });

  it("unescapes ~1 and ~0 in pointers", () => {
    assert.deepEqual(parsePointer("/nested/s~1l"), ["nested", "s/l"]);
    const r = applyTwinPatch(doc, [{ op: "replace", path: "/nested/t~0d", value: 5 }]);
    assert.ok(r.ok);
    assert.equal(r.value.nested["t~d"], 5);
  });

  it("an unknown path is a resync signal and nothing partial leaks", () => {
    const ops: TwinPatchOp[] = [
      { op: "replace", path: "/a", value: 2 },
      { op: "replace", path: "/list/7/v", value: 1 },
    ];
    const r = applyTwinPatch(doc, ops);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.opIndex, 1);
    for (const bad of ["/missing", "/list/x", "/list/01", "no-slash", "/a/b"]) {
      assert.equal(applyTwinPatch(doc, [{ op: "replace", path: bad, value: 1 }]).ok, false, bad);
    }
    assert.equal(applyTwinPatch(doc, [{ op: "remove", path: "/list/2" }]).ok, false);
    assert.equal(applyTwinPatch(doc, [{ op: "move", path: "/a" } as unknown as TwinPatchOp]).ok, false);
  });

  it("applies a realistic snapshot patch (a dock booking arrives)", () => {
    const i = WAREHOUSE_FIXTURE.objects.findIndex((o) => o.id === "o_w_dock_3");
    const r = applyTwinPatch(WAREHOUSE_FIXTURE, [
      { op: "replace", path: `/objects/${i}/state/status`, value: "occupied" },
      { op: "replace", path: `/objects/${i}/pill`, value: "Loading" },
      { op: "replace", path: "/kpis/1/value", value: 2 },
      { op: "replace", path: "/generatedAt", value: "2026-10-04T09:34:00.000Z" },
    ]);
    assert.ok(r.ok);
    const o = r.value.objects[i]!;
    assert.equal(o.state.kind === "dock_door" && o.state.status, "occupied");
    assert.equal(o.pill, "Loading");
    assert.equal(r.value.kpis[1]!.value, 2);
    assert.equal(r.value.objects[0], WAREHOUSE_FIXTURE.objects[0], "other objects shared");
  });

  it("applies the data side's siteDiff output exactly (wire compatibility)", () => {
    const prev = WAREHOUSE_FIXTURE;
    // a value change, a layout change (object removed + added), KPI and time moves
    const next = structuredClone(prev);
    const dock = next.objects.find((o) => o.id === "o_w_dock_1")!;
    dock.pill = "Booked 11:00";
    next.objects = next.objects.filter((o) => o.id !== "o_w_yard_3");
    next.objects.push({ ...structuredClone(prev.objects[0]!), id: "o_w_zz_new", label: "New rack" });
    next.objects.sort((a, b) => (a.id < b.id ? -1 : 1));
    next.kpis[0]!.value += 40;
    next.generatedAt = "2026-10-04T09:34:00.000Z";
    for (const [a, b] of [
      [prev, next],
      [next, prev],
      [prev, prev],
    ] as const) {
      const ops = diffSnapshots(a, b);
      const r = applyTwinPatch(a, ops);
      assert.ok(r.ok, !r.ok ? r.reason : "");
      assert.deepEqual(r.value, b);
    }
  });

  it("a root replace swaps the whole document", () => {
    const r = applyTwinPatch(doc, [{ op: "replace", path: "", value: { a: 2 } }]);
    assert.ok(r.ok);
    assert.deepEqual(r.value, { a: 2 });
  });
});

// ---------------------------------------------------------------------------
// scene-kit.ts grid maths
// ---------------------------------------------------------------------------

describe("scene kit: grid ↔ world and rotation", () => {
  const grid = { gridW: 40, gridD: 30 };

  it("centres the site on the origin (1 cell = 1 m)", () => {
    assert.deepEqual(cellToWorld(0, 0, grid), { x: -20, z: -15 });
    assert.deepEqual(cellToWorld(20, 15, grid), { x: 0, z: 0 });
    assert.deepEqual(worldToCell(-19.5, -14.2, grid), { x: 0, z: 0 });
    assert.deepEqual(worldToCell(0.4, 0.9, grid), { x: 20, z: 15 });
    assert.deepEqual(worldToCell(500, -500, grid), { x: 39, z: 0 }, "clamped inside the site");
  });

  it("w/d are the grid extent whatever the rotation; the model's local size swaps at 90/270", () => {
    const fp = { x: 2, z: 3, w: 4, d: 1, h: 3, rotation: 0 as const };
    assert.deepEqual(occupiedSize(fp), { w: 4, d: 1 });
    assert.deepEqual(occupiedSize({ ...fp, rotation: 90 }), { w: 4, d: 1 }, "same contract as lib/twin/derive.ts footprintProblem");
    assert.deepEqual(localSize({ ...fp, rotation: 90 }), { w: 1, d: 4 });
    assert.deepEqual(localSize({ ...fp, rotation: 180 }), { w: 4, d: 1 });
    assert.deepEqual(occupiedRect({ ...fp, rotation: 270 }), { x0: 2, z0: 3, x1: 6, z1: 4 });
    assert.deepEqual(footprintCenter(fp, grid), { x: 4 - 20, z: 3.5 - 15 });
  });

  it("front direction: 0 south, 90 east, 180 north, 270 west", () => {
    assert.deepEqual(frontDirection(0), { x: 0, z: 1 });
    assert.deepEqual(frontDirection(90), { x: 1, z: 0 });
    assert.deepEqual(frontDirection(180), { x: 0, z: -1 });
    assert.deepEqual(frontDirection(270), { x: -1, z: 0 });
    assert.equal(rotationY(180), Math.PI);
    assert.equal(nextRotation(270), 0);
    assert.equal(nextRotation(0), 90);
  });

  it("rotating keeps the object centred and inside the site", () => {
    const r = rotateFootprint({ x: 10, z: 10, w: 6, d: 2, h: 1, rotation: 0 }, grid);
    assert.deepEqual(r, { x: 12, z: 8, w: 2, d: 6, h: 1, rotation: 90 }, "the grid extent swaps around the centre");
    const edge = rotateFootprint({ x: 0, z: 28, w: 6, d: 2, h: 1, rotation: 0 }, grid);
    const rect = occupiedRect(edge);
    assert.ok(rect.x0 >= 0 && rect.z0 >= 0 && rect.x1 <= 40 && rect.z1 <= 30, JSON.stringify(edge));
  });

  it("clamps and snaps footprints; detects overlaps (touching edges are fine)", () => {
    assert.deepEqual(clampFootprint({ x: 38.6, z: -2, w: 4.2, d: 0, h: -1, rotation: 0 }, grid), { x: 36, z: 0, w: 4, d: 1, h: 1, rotation: 0 });
    const a = { x: 0, z: 0, w: 4, d: 2, h: 1, rotation: 0 as const };
    assert.equal(footprintsOverlap(a, { ...a, x: 4 }), false);
    assert.equal(footprintsOverlap(a, { ...a, x: 3 }), true);
    assert.equal(footprintsOverlap(a, { x: 2, z: 1, w: 1, d: 4 }), true);
  });

  it("parks a truck outside the dock door, along its front", () => {
    const door = { x: 10, z: 22, w: 4, d: 1, h: 4, rotation: 0 as const };
    const t = truckPlacement(door, { gridW: 48, gridD: 40 }, 10);
    const c = footprintCenter(door, { gridW: 48, gridD: 40 });
    assert.equal(t.x, c.x);
    assert.ok(t.z > c.z + 5, "south of the door");
    const eastDoor = { x: 30, z: 10, w: 1, d: 4, h: 4, rotation: 90 as const };
    const east = truckPlacement(eastDoor, { gridW: 48, gridD: 40 }, 10);
    const ec = footprintCenter(eastDoor, { gridW: 48, gridD: 40 });
    assert.equal(east.z, ec.z);
    assert.equal(east.x, ec.x + 0.5 + 5 + 0.3, "nose against the door's 1 m depth");
  });

  it("pallet counts: 0 when empty, ≥1 when any, capped by rack slots", () => {
    assert.equal(palletCount(0, 10), 0);
    assert.equal(palletCount(-5, 10), 0);
    assert.equal(palletCount(1, 10), 1);
    assert.equal(palletCount(81, 10), 3);
    assert.equal(palletCount(1_000_000, 10), 10);
    const slots = rackSlots(10, 1, 5);
    assert.equal(slots.length, 8 * 4, "8 bays × 4 levels");
    assert.ok(slots.every((s) => Math.abs(s.x) <= 5 && s.z === 0));
    const deep = rackSlots(2, 12, 5);
    assert.ok(deep.every((s) => s.x === 0 && Math.abs(s.z) <= 6), "long axis along z");
    assert.equal(shelfSlots(8, 1, 2).length, 16 * 3);
  });

  it("isometric camera: true iso elevation, quadrants and cut-away walls", () => {
    const p = isoCameraPosition({ x: 0, y: 0, z: 0 }, 100);
    assert.ok(Math.abs(p.x - p.z) < 1e-9 && p.x > 0, "looks from the south-east");
    assert.ok(Math.abs(Math.atan2(p.y, Math.hypot(p.x, p.z)) - Math.atan(1 / Math.SQRT2)) < 1e-9);
    assert.equal(viewQuadrant(ISO_AZIMUTH), 0);
    assert.equal(viewQuadrant(ISO_AZIMUTH + Math.PI / 2), 1);
    assert.equal(viewQuadrant(ISO_AZIMUTH - Math.PI / 2), 3);
    assert.deepEqual(facingWalls(0), { south: true, east: true, north: false, west: false });
    const z1 = fitZoom({ gridW: 48, gridD: 40 }, 1200, 700);
    const z2 = fitZoom({ gridW: 96, gridD: 80 }, 1200, 700);
    assert.ok(z1 > z2 && z2 >= 2, "bigger sites zoom out");
  });
});

// ---------------------------------------------------------------------------
// fixtures ↔ contract
// ---------------------------------------------------------------------------

function checkSnapshot(s: TwinSnapshot): string[] {
  const errs: string[] = [];
  const push = (m: string) => errs.push(`${s.site.code}: ${m}`);
  if (!(TWIN_SITE_KINDS as readonly string[]).includes(s.site.kind)) push("bad site kind");
  if (!(TWIN_SITE_STATUSES as readonly string[]).includes(s.site.status)) push("bad site status");
  if (!(s.site.gridW > 0 && s.site.gridD > 0)) push("bad grid");
  if (Number.isNaN(Date.parse(s.generatedAt))) push("bad generatedAt");
  const ids = s.objects.map((o) => o.id);
  if (new Set(ids).size !== ids.length) push("duplicate object ids");
  if (ids.join() !== [...ids].sort().join()) push("objects not sorted by id");
  for (const o of s.objects) {
    if (!(TWIN_OBJECT_KINDS as readonly string[]).includes(o.kind)) push(`${o.id} bad kind`);
    const st = o.state.kind;
    const ok = st === o.kind || (st === "rack" && o.kind === "rack");
    if (!ok) push(`${o.id} state kind ${st} ≠ ${o.kind}`);
    const f = o.footprint;
    if (!(f.w >= 1 && f.d >= 1 && f.h >= 1)) push(`${o.id} footprint size`);
    if (![f.x, f.z, f.w, f.d, f.h].every(Number.isInteger)) push(`${o.id} footprint must be whole cells`);
    if (![0, 90, 180, 270].includes(f.rotation)) push(`${o.id} rotation`);
    const r = occupiedRect(f);
    if (r.x0 < 0 || r.z0 < 0 || r.x1 > s.site.gridW || r.z1 > s.site.gridD) push(`${o.id} outside the site`);
    if (o.binding && !TWIN_BINDABLE[o.kind].includes(o.binding.type)) push(`${o.id} binding ${o.binding.type} not allowed`);
    if (o.state.kind === "dock_door" && o.state.booking && !(TWIN_DOCK_BOOKING_STATUSES as readonly string[]).includes(o.state.booking.status)) {
      push(`${o.id} booking status`);
    }
    if (o.state.kind === "equipment" && o.state.positionIsEstimated !== true) push(`${o.id} position must be estimated`);
  }
  // The data side's own layout rules (lib/twin/derive.ts) accept every object.
  for (const o of s.objects) {
    const problem = footprintProblem(o.footprint, s.site);
    if (problem) push(`${o.id} ${problem}`);
    const clash = overlapWith(o, s.objects);
    if (clash) push(`${o.id} overlaps ${clash.id}`);
  }
  for (const sh of s.shipments) {
    if (sh.dockObjectId && !ids.includes(sh.dockObjectId)) push(`shipment ${sh.id} dock missing`);
    if (sh.currentStep < 0 || sh.currentStep >= sh.steps.length) push(`shipment ${sh.id} currentStep`);
  }
  for (const a of s.agents) {
    if (!ids.includes(a.objectId)) push(`agent on missing object ${a.objectId}`);
    if (!isAosStatus(a.status)) push(`agent status ${a.status}`);
  }
  return errs;
}

describe("fixtures are valid against the contract", () => {
  it("one realistic snapshot per site kind", () => {
    assert.deepEqual(Object.keys(TWIN_FIXTURES).sort(), [...TWIN_SITE_KINDS].sort());
    for (const s of Object.values(TWIN_FIXTURES)) {
      assert.deepEqual(checkSnapshot(s), []);
      // JSON round trip: nothing non-serialisable (the SSE stream sends JSON).
      assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
    }
    assert.equal(fixtureSiteList().length, 3);
  });

  it("warehouse has docks, racks, bins, yard, forklifts and 2+ trucks booked", () => {
    const k = kindsPresent(WAREHOUSE_FIXTURE);
    for (const kind of ["dock_door", "rack", "bin_zone", "yard_slot", "equipment", "building", "path"] as const) assert.ok(k.has(kind), kind);
    const booked = WAREHOUSE_FIXTURE.objects.filter((o) => o.state.kind === "dock_door" && o.state.booking);
    assert.ok(booked.length >= 2);
  });

  it("factory has running, stopped and late work centres; store has shelves and registers", () => {
    const wcs = FACTORY_FIXTURE.objects.flatMap((o) => (o.state.kind === "work_center" ? [o.state] : []));
    assert.ok(wcs.some((w) => w.status === "running"));
    assert.ok(wcs.some((w) => w.status === "stopped" && w.late));
    const k = kindsPresent(STORE_FIXTURE);
    assert.ok(k.has("shelf") && k.has("register"));
  });

  it("the checker catches a broken snapshot", () => {
    const bad = structuredClone(STORE_FIXTURE);
    bad.objects[0]!.footprint.x = 500;
    bad.agents.push({ objectId: "nope", runId: "r", agentKey: null, status: "running", label: "x" });
    assert.ok(checkSnapshot(bad).length >= 2);
  });
});

// ---------------------------------------------------------------------------
// view-model.ts
// ---------------------------------------------------------------------------

describe("tables per site kind", () => {
  it("warehouse tabs: docks / equipment / trucks; rows select their object", () => {
    assert.deepEqual(TWIN_TABS.warehouse.map((t) => t.key), ["docks", "equipment", "trucks"]);
    const docks = twinTable(WAREHOUSE_FIXTURE, "docks");
    assert.equal(docks.rows.length, 4);
    const d2 = docks.rows.find((r) => r.objectId === "o_w_dock_2")!;
    assert.equal(d2.cells.truck, "NL-4471");
    assert.equal(d2.cells.state, "Unloading");
    const trucks = twinTable(WAREHOUSE_FIXTURE, "trucks");
    assert.deepEqual(trucks.rows.map((r) => r.objectId), ["o_w_dock_2", "o_w_dock_3", "o_w_dock_4"]);
    assert.equal(trucks.rows.find((r) => r.key === "bk_w_03")!.cells.step, "Late");
    const eq = twinTable(WAREHOUSE_FIXTURE, "equipment");
    assert.equal(eq.rows.length, 3);
    assert.ok(eq.rows.every((r) => r.cells.position === "Estimated"));
  });

  it("factory: work centres and their orders; store: registers and shelves", () => {
    const wc = twinTable(FACTORY_FIXTURE, "work_centres");
    assert.equal(wc.rows.length, 5);
    assert.equal(wc.rows.find((r) => r.objectId === "o_f_wc_weld")!.cells.late, "Late");
    const orders = twinTable(FACTORY_FIXTURE, "orders");
    assert.equal(orders.rows.length, 4, "idle paint booth has no order");
    const regs = twinTable(STORE_FIXTURE, "registers");
    assert.equal(regs.rows.find((r) => r.objectId === "o_s_reg_1")!.cells.sales, "$1,842.50");
    assert.equal(regs.rows.find((r) => r.objectId === "o_s_reg_2")!.cells.sales, "—");
    const shelves = twinTable(STORE_FIXTURE, "shelves");
    assert.equal(shelves.rows.find((r) => r.objectId === "o_s_shelf_old")!.cells.bound, "Unbound");
    assert.ok(twinTable(STORE_FIXTURE, "docks").rows.length === 1);
    assert.equal(twinTable(FACTORY_FIXTURE, "trucks").rows.length, 0);
  });
});

describe("shipment stepper pick", () => {
  it("the selected dock's shipment wins", () => {
    assert.equal(pickShipment(WAREHOUSE_FIXTURE, "o_w_dock_3")?.id, "bk_w_02");
    assert.equal(pickShipment(WAREHOUSE_FIXTURE, "o_w_dock_2")?.id, "bk_w_01");
  });

  it("otherwise the most urgent: late first, then soonest ETA; finished ones are skipped", () => {
    assert.equal(pickShipment(WAREHOUSE_FIXTURE, null)?.id, "bk_w_03");
    assert.equal(pickShipment(WAREHOUSE_FIXTURE, "o_w_rack_a")?.id, "bk_w_03");
    const s = structuredClone(WAREHOUSE_FIXTURE);
    s.shipments = s.shipments.filter((x) => x.id !== "bk_w_03");
    assert.equal(pickShipment(s, null)?.id, "bk_w_01", "earlier ETA");
    s.shipments[0]!.steps.forEach((st) => (st.done = true));
    assert.equal(pickShipment(s, null)?.id, "bk_w_02");
    assert.equal(pickShipment(FACTORY_FIXTURE, null), null);
  });
});

describe("search, facts, kpis, links", () => {
  it("finds objects, trucks, carriers and order refs and points at the object", () => {
    assert.equal(searchTwin(WAREHOUSE_FIXTURE, "dock 2")[0]?.objectId, "o_w_dock_2");
    assert.equal(searchTwin(WAREHOUSE_FIXTURE, "NL-44")[0]?.objectId, "o_w_dock_2");
    assert.equal(searchTwin(WAREHOUSE_FIXTURE, "coastal")[0]?.objectId, "o_w_dock_3");
    assert.equal(searchTwin(WAREHOUSE_FIXTURE, "po-0012")[0]?.objectId, "o_w_dock_2");
    assert.equal(searchTwin(WAREHOUSE_FIXTURE, "forklift").length, 3);
    assert.deepEqual(searchTwin(WAREHOUSE_FIXTURE, "   "), []);
    assert.deepEqual(searchTwin(WAREHOUSE_FIXTURE, "zzz-nothing"), []);
  });

  it("inspector facts carry the derived state and the 'estimated' label", () => {
    const dock = WAREHOUSE_FIXTURE.objects.find((o) => o.id === "o_w_dock_2")!;
    const f = Object.fromEntries(inspectorFacts(dock).map((x) => [x.label, x.value]));
    assert.equal(f.Truck, "NL-4471");
    assert.equal(f.Booking, "Unloading");
    const fork = WAREHOUSE_FIXTURE.objects.find((o) => o.id === "o_w_fork_1")!;
    assert.match(Object.fromEntries(inspectorFacts(fork).map((x) => [x.label, x.value])).Position!, /^Estimated/);
  });

  it("formats KPIs and links bound records to their ops pages", () => {
    assert.equal(formatKpiValue({ value: 4973, unit: "count" }), "4,973");
    assert.equal(formatKpiValue({ value: 91.6, unit: "pct" }), "92%");
    assert.equal(formatKpiValue({ value: 226_150, unit: "cents" }), "$2,261.50");
    assert.equal(recordHref({ type: "work_center", id: "x" }), "/dashboard/ops/manufacturing?view=work-centres");
    assert.equal(recordHref(null), null);
    assert.equal(agentsByObject(WAREHOUSE_FIXTURE).get("o_w_dock_4")?.[0]?.status, "needs");
  });
});

describe("client request bodies", () => {
  it("derives the generic ops entity slugs from TWIN_API", () => {
    assert.equal(opsSlug("/api/ops/twin-objects"), "twin-objects");
    assert.deepEqual(TWIN_SLUGS, { sites: "twin-sites", objects: "twin-objects", dockBookings: "dock-bookings" });
  });

  it("builds create/patch bodies and the booking's next step", () => {
    const b = createObjectBody("site_1", {
      kind: "rack",
      label: "Rack Z",
      footprint: { x: 1, z: 2, w: 6, d: 1, h: 4, rotation: 90 },
      binding: { type: "location", id: "loc_1" },
    });
    assert.deepEqual(b, { siteId: "site_1", kind: "rack", label: "Rack Z", x: 1, z: 2, w: 6, d: 1, h: 4, rotation: 90, bindingType: "location", bindingId: "loc_1" });
    assert.deepEqual(patchObjectBody("o1", { footprint: { x: 3 } }), { id: "o1", x: 3 });
    assert.deepEqual(patchObjectBody("o1", { binding: null }), { id: "o1", bindingType: null, bindingId: null });
    assert.equal(nextBookingStatus("booked", "inbound"), "arrived");
    assert.equal(nextBookingStatus("arrived", "inbound"), "unloading");
    assert.equal(nextBookingStatus("arrived", "outbound"), "loading");
    assert.equal(nextBookingStatus("loading", "outbound"), "done");
    assert.equal(nextBookingStatus("done", "outbound"), null);
    assert.equal(bookDockBody({ siteId: "s", dockObjectId: "d", direction: "inbound", carrier: " ", truckRef: "T1", eta: "2026-10-04T10:00:00Z" }).carrier, undefined);
  });
});
