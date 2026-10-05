// ShapesOS Phase 13 (twincore): the twin's pure rules — layout validation,
// per-kind derived state (incl. the overdue thresholds), KPI maths, shipment
// steps, agent markers, siteDiff and the alert candidates. No database.
//   npx tsx --test lib/twin/__tests__/twin-derive.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BOOKING_TRANSITIONS,
  DOCK_ETA_GRACE_MS,
  DOCK_ON_SITE_MAX_MS,
  REGISTER_LEFT_OPEN_MS,
  TwinRuleError,
  agentMarkers,
  alertCandidates,
  applyTwinPatch,
  assertBindable,
  assertBookingMove,
  assertLocationKindFits,
  bookingClash,
  bookingRef,
  deriveDock,
  deriveEquipment,
  deriveKpis,
  deriveProductShelf,
  deriveRegister,
  deriveShipments,
  deriveStock,
  deriveWorkCenter,
  footprintProblem,
  gridProblem,
  locationSubtree,
  lowProducts,
  onTimeDelivery,
  overlapWith,
  shipmentSteps,
  utilisationPct,
  type BookingRow,
  type WorkOrderRow,
} from "../derive";
import { siteDiff } from "../state";
import type { TwinObject, TwinSnapshot } from "../types";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const H = 3_600_000;

function booking(over: Partial<BookingRow> = {}): BookingRow {
  return {
    id: "bk_1",
    dockLocationId: "loc_dock1",
    direction: "inbound",
    carrier: "DHL",
    truckRef: "TRK-1",
    status: "booked",
    eta: NOW,
    durationMinutes: 60,
    arrivedAt: null,
    startedAt: null,
    doneAt: null,
    cancelledAt: null,
    createdAt: ago(2 * H),
    purchaseOrderId: "cmpo000000000000abcd1234",
    orderId: null,
    transferId: null,
    purchaseOrder: { status: "sent", sentAt: ago(48 * H), receivedAt: null },
    order: null,
    transfer: null,
    ...over,
  };
}

describe("layout validation", () => {
  const grid = { gridW: 20, gridD: 10 };
  it("footprints must sit inside the grid with a valid rotation", () => {
    assert.equal(footprintProblem({ x: 0, z: 0, w: 20, d: 10, h: 3, rotation: 0 }, grid), null);
    assert.match(String(footprintProblem({ x: 15, z: 0, w: 6, d: 2, h: 1, rotation: 0 }, grid)), /runs past the 20×10 grid/);
    assert.match(String(footprintProblem({ x: -1, z: 0, w: 1, d: 1, h: 1, rotation: 0 }, grid)), /outside/);
    assert.match(String(footprintProblem({ x: 0, z: 0, w: 1, d: 1, h: 1, rotation: 45 as 0 }, grid)), /rotation/);
    assert.match(String(footprintProblem({ x: 0.5, z: 0, w: 1, d: 1, h: 1, rotation: 0 }, grid)), /whole number/);
    assert.match(String(footprintProblem({ x: 0, z: 0, w: 0, d: 1, h: 1, rotation: 0 }, grid)), /at least 1/);
    assert.equal(gridProblem({ gridW: 3, gridD: 10 }) !== null, true);
    assert.equal(gridProblem({ gridW: 40, gridD: 30 }), null);
  });

  it("no overlapping footprints, except paths and equipment", () => {
    const rack = { id: "a", kind: "rack" as const, footprint: { x: 0, z: 0, w: 4, d: 2 } };
    const touching = { id: "b", kind: "rack" as const, footprint: { x: 4, z: 0, w: 2, d: 2 } };
    const crossing = { id: "c", kind: "bin_zone" as const, footprint: { x: 3, z: 1, w: 2, d: 2 } };
    const path = { id: "p", kind: "path" as const, footprint: { x: 0, z: 0, w: 10, d: 1 } };
    const forklift = { id: "f", kind: "equipment" as const, footprint: { x: 1, z: 1, w: 1, d: 1 } };
    assert.equal(overlapWith(touching, [rack]), null, "edges may touch");
    assert.equal(overlapWith(crossing, [rack, touching])?.id, "a");
    assert.equal(overlapWith(path, [rack]), null);
    assert.equal(overlapWith(rack, [path, forklift]), null);
    assert.equal(overlapWith({ ...rack }, [rack]), null, "an object never overlaps itself (patch)");
  });

  it("binding types and location kinds per object kind", () => {
    assert.doesNotThrow(() => assertBindable("dock_door", "location"));
    assert.doesNotThrow(() => assertBindable("shelf", "product"));
    assert.throws(() => assertBindable("dock_door", "work_center"), TwinRuleError);
    assert.throws(() => assertBindable("building", "location"), /can't be bound/);
    assert.throws(() => assertBindable("equipment", "location"), TwinRuleError);
    assert.doesNotThrow(() => assertLocationKindFits("dock_door", "dock"));
    assert.throws(() => assertLocationKindFits("dock_door", "bin"), /dock/);
    assert.doesNotThrow(() => assertLocationKindFits("rack", "aisle"));
    assert.throws(() => assertLocationKindFits("rack", "dock"), TwinRuleError);
    assert.doesNotThrow(() => assertLocationKindFits("bin_zone", "zone"));
  });

  it("booking moves follow the machine; loading is outbound, unloading inbound", () => {
    assert.deepEqual(BOOKING_TRANSITIONS.booked, ["arrived", "cancelled"]);
    assert.doesNotThrow(() => assertBookingMove("arrived", "unloading", "inbound"));
    assert.throws(() => assertBookingMove("arrived", "loading", "inbound"), /outbound/);
    assert.throws(() => assertBookingMove("booked", "done", "inbound"), (e: unknown) => e instanceof TwinRuleError && e.status === 409);
    assert.throws(() => assertBookingMove("done", "cancelled", "inbound"), TwinRuleError);
    assert.doesNotThrow(() => assertBookingMove("loading", "cancelled", "outbound"));
  });

  it("a dock can't hold two overlapping active bookings", () => {
    const a = { id: "a", status: "booked", eta: NOW, durationMinutes: 60 };
    assert.equal(bookingClash({ status: "booked", eta: new Date(NOW.getTime() + 30 * MIN), durationMinutes: 60 }, [a])?.id, "a");
    assert.equal(bookingClash({ status: "booked", eta: new Date(NOW.getTime() + 60 * MIN), durationMinutes: 30 }, [a]), null, "back-to-back slots are fine");
    assert.equal(bookingClash({ status: "booked", eta: NOW, durationMinutes: 60 }, [{ ...a, status: "cancelled" }]), null, "cancelled bookings free the slot");
    assert.equal(bookingClash({ id: "a", status: "booked", eta: NOW, durationMinutes: 90 }, [a]), null, "a booking never clashes with itself");
  });
});

describe("derived state per kind", () => {
  it("dock: free, booked, occupied, and both overdue thresholds", () => {
    assert.deepEqual(deriveDock([], NOW).state, { kind: "dock_door", status: "free", booking: null, upcoming: 0 });
    const soon = deriveDock([booking({ eta: new Date(NOW.getTime() + H) }), booking({ id: "bk_2", eta: new Date(NOW.getTime() + 3 * H) })], NOW);
    assert.equal(soon.state.status, "booked");
    assert.equal(soon.state.upcoming, 1);
    assert.equal(soon.state.booking?.ref, "PO-ABCD1234");
    // Exactly at the grace: not yet overdue; one minute later: overdue.
    assert.equal(deriveDock([booking({ eta: ago(DOCK_ETA_GRACE_MS) })], NOW).state.status, "booked");
    const late = deriveDock([booking({ eta: ago(DOCK_ETA_GRACE_MS + MIN) })], NOW);
    assert.equal(late.state.status, "overdue");
    assert.equal(late.alert?.key, "dock_overdue");
    assert.match(late.alert!.message, /TRK-1 \(PO-ABCD1234\) is 31 min past its ETA/);
    const onSite = deriveDock([booking({ status: "unloading", arrivedAt: ago(H), startedAt: ago(30 * MIN) })], NOW);
    assert.equal(onSite.state.status, "occupied");
    assert.equal(onSite.pill, "Unloading");
    assert.equal(onSite.alert, null);
    const stuck = deriveDock([booking({ status: "arrived", arrivedAt: ago(DOCK_ON_SITE_MAX_MS + MIN) })], NOW);
    assert.equal(stuck.state.status, "overdue");
    assert.match(stuck.alert!.message, /on site for 4 h/);
    // An on-site truck wins over the next booked one.
    const both = deriveDock([booking({ id: "next", eta: new Date(NOW.getTime() + H) }), booking({ id: "here", status: "arrived", arrivedAt: ago(10 * MIN) })], NOW);
    assert.equal(both.state.booking?.id, "here");
    assert.equal(both.state.upcoming, 1);
  });

  it("rack / bin: on hand, SKUs and low stock over the location subtree", () => {
    const locs = [
      { id: "zone", parentId: null, kind: "zone", code: "A", path: "WH/A" },
      { id: "rack", parentId: "zone", kind: "rack", code: "A-01", path: "WH/A/A-01" },
      { id: "bin1", parentId: "rack", kind: "bin", code: "A-01-1", path: "WH/A/A-01/A-01-1" },
      { id: "bin2", parentId: "rack", kind: "bin", code: "A-01-2", path: "WH/A/A-01/A-01-2" },
      { id: "other", parentId: null, kind: "zone", code: "B", path: "WH/B" },
    ];
    assert.deepEqual([...locationSubtree("rack", locs)].sort(), ["bin1", "bin2", "rack"]);
    const rows = [
      { productId: "mug", locationId: "bin1", qty: 8 },
      { productId: "cup", locationId: "bin2", qty: 3 },
      { productId: "cup", locationId: "other", qty: 1 },
      { productId: "tea", locationId: "other", qty: 50 },
    ];
    // cup: 4 in the warehouse ≤ min 5 → low; mug 8 > threshold 2; lid has a rule receiving into bin1 and none on hand.
    const low = lowProducts(rows, { thresholds: new Map([["mug", 2], ["cup", 5], ["lid", 0], ["tea", 0]]), ruleLocations: [] });
    assert.deepEqual([...low].sort(), ["cup", "lid"]);
    const d = deriveStock("rack", locationSubtree("rack", locs), rows, low, [{ productId: "lid", locationId: "bin1" }]);
    assert.deepEqual(d.state, { kind: "rack", onHand: 11, skuCount: 2, lowStockCount: 2 });
    assert.equal(d.alert?.key, "bin_low");
    assert.equal(d.pill, "11 on hand");
    const calm = deriveStock("bin_zone", new Set(["other"]), rows, new Set(), []);
    assert.deepEqual(calm.state, { kind: "bin_zone", onHand: 51, skuCount: 2, lowStockCount: 0 });
    assert.equal(calm.alert, null);
    assert.equal(deriveStock("bin_zone", new Set(["nothing"]), rows, low, []).pill, "Empty");
    assert.deepEqual(deriveProductShelf("cup", rows, low).state, { kind: "shelf", onHand: 4, skuCount: 1, lowStockCount: 1 });
  });

  it("work centre: running / paused / stopped / idle, late, utilisation", () => {
    const wo = (over: Partial<WorkOrderRow>): WorkOrderRow => ({
      id: "wo1",
      workCenterId: "wc",
      name: "Cut",
      sequence: 1,
      status: "pending",
      runningSince: null,
      mo: { id: "mo1", number: "MO-0001", status: "in_progress", plannedStart: ago(2 * H) },
      ...over,
    });
    const running = deriveWorkCenter([wo({ status: "in_progress", runningSince: ago(H) })], 1, [], NOW);
    assert.equal(running.state.status, "running");
    assert.equal(running.state.late, true);
    assert.equal(running.alert, null, "running late is not a stopped machine");
    assert.equal(running.state.workOrder?.runningSince, ago(H).toISOString());
    const stopped = deriveWorkCenter([wo({})], 1, [], NOW);
    assert.equal(stopped.state.status, "stopped");
    assert.equal(stopped.alert?.key, "machine_stopped_late");
    assert.equal(deriveWorkCenter([wo({ status: "paused" })], 1, [], NOW).state.status, "paused");
    const onTime = deriveWorkCenter([wo({ status: "paused", mo: { id: "mo2", number: "MO-0002", status: "in_progress", plannedStart: new Date(NOW.getTime() + H) } })], 1, [], NOW);
    assert.equal(onTime.state.late, false);
    assert.equal(onTime.alert, null);
    assert.equal(deriveWorkCenter([wo({ mo: { id: "mo3", number: null, status: "draft", plannedStart: null } })], 1, [], NOW).state.status, "idle", "a draft MO's step is not open work");
    assert.equal(deriveWorkCenter([wo({ ready: false })], 1, [], NOW).state.status, "idle", "a step waiting on an earlier one is not stopped");
    // 7 days × 8 h × capacity 1 = 3360 min; 336 min logged = 10 %.
    assert.equal(utilisationPct(1, [{ startedAt: ago(2 * H), endedAt: ago(H), seconds: 336 * 60 }], [], NOW), 10);
    assert.equal(utilisationPct(2, [{ startedAt: ago(2 * H), endedAt: ago(H), seconds: 336 * 60 }], [], NOW), 5, "capacity divides");
    // A log ending before the window counts nothing; one straddling counts its in-window part.
    assert.equal(utilisationPct(1, [{ startedAt: ago(8 * 86_400_000 + H), endedAt: ago(8 * 86_400_000), seconds: 3600 }], [], NOW), 0);
    assert.equal(utilisationPct(1, [{ startedAt: ago(7 * 86_400_000 + 336 * MIN), endedAt: ago(7 * 86_400_000 - 336 * MIN), seconds: 672 * 60 }], [], NOW), 10);
    // A running timer counts up to now; the result is capped at 100.
    assert.equal(utilisationPct(1, [], [ago(336 * MIN)], NOW), 10);
    assert.equal(utilisationPct(1, [], [ago(30 * 86_400_000)], NOW), 100);
  });

  it("register: closed, open with sales, left open", () => {
    assert.equal(deriveRegister(null, 0, NOW).state.status, "closed");
    const open = deriveRegister({ id: "s1", number: "POS-0001", status: "open", openedAt: ago(H) }, 1944, NOW);
    assert.deepEqual(open.state, { kind: "register", status: "open", sessionId: "s1", sessionNumber: "POS-0001", salesCents: 1944, openedAt: ago(H).toISOString() });
    assert.equal(open.alert, null);
    const left = deriveRegister({ id: "s1", number: "POS-0001", status: "closing", openedAt: ago(REGISTER_LEFT_OPEN_MS + MIN) }, 0, NOW);
    assert.equal(left.alert?.key, "register_left_open");
    assert.match(left.alert!.message, /POS-0001 has been closing for 12 h/);
  });

  it("equipment: drawn at its task's object, else at home — always estimated", () => {
    const row = { x: 2, z: 3, w: 1, d: 1, equipmentStatus: "busy" as const, taskLocationId: "bin1", taskNote: "Pick SO-1", taskAssignedAt: ago(MIN), homeX: 1, homeZ: 1 };
    const busy = deriveEquipment(row, { label: "Rack A-01", centre: { x: 10, z: 4 } });
    assert.deepEqual(busy.state.position, { x: 10, z: 4 });
    assert.equal(busy.state.positionIsEstimated, true);
    assert.equal(busy.state.task?.label, "Rack A-01");
    const noObject = deriveEquipment(row, { label: "WH/A/A-01", centre: null });
    assert.deepEqual(noObject.state.position, { x: 1.5, z: 1.5 }, "home cell centre");
    const idle = deriveEquipment({ ...row, equipmentStatus: "available", taskLocationId: null, taskNote: null, taskAssignedAt: null }, null);
    assert.equal(idle.state.task, null);
    assert.equal(idle.pill, "Available");
  });
});

describe("KPIs and shipments", () => {
  it("KPI maths per site kind", () => {
    const bookings = [
      booking({ id: "a", status: "done", eta: ago(5 * H), arrivedAt: ago(5 * H - 10 * MIN), doneAt: ago(4 * H) }), // on time
      booking({ id: "b", status: "done", eta: ago(5 * H), arrivedAt: ago(5 * H - DOCK_ETA_GRACE_MS - MIN), doneAt: ago(3 * H) }), // late
      booking({ id: "c", status: "done", eta: ago(40 * 86_400_000), arrivedAt: ago(40 * 86_400_000), doneAt: ago(40 * 86_400_000) }), // outside 30 d
      booking({ id: "d", status: "unloading", dockLocationId: "dock1", arrivedAt: ago(H) }),
      booking({ id: "e", status: "arrived", dockLocationId: "dock2", arrivedAt: ago(MIN) }),
    ];
    assert.deepEqual(onTimeDelivery(bookings, NOW), { pct: 50, total: 2, onTime: 1 });
    const stockRows = [
      { productId: "mug", locationId: "x", qty: 8 },
      { productId: "cup", locationId: "y", qty: 3 },
      { productId: "gone", locationId: "y", qty: -1 },
    ];
    const base = { stockRows, bookings, workCenters: [{ status: "running", utilisationPct: 40 }, { status: "idle", utilisationPct: 10 }], registers: [{ status: "open" }, { status: "closed" }], salesToday: { cents: 5000, count: 3 }, now: NOW };
    const wh = deriveKpis({ ...base, kind: "warehouse" });
    assert.deepEqual(wh.map((k) => [k.key, k.value, k.unit, k.hint]), [
      ["stock_on_hand", 11, "count", "2 SKUs"],
      ["trucks_on_site", 2, "count", "2 docks busy"],
      ["on_time_delivery_30d", 50, "pct", "1 of 2 deliveries, 30 days"],
    ]);
    const fac = deriveKpis({ ...base, kind: "factory" });
    assert.deepEqual(fac.at(-1), { key: "work_center_utilisation", label: "Work centre utilisation", value: 25, unit: "pct", hint: "1 of 2 running · 7 days" });
    const store = deriveKpis({ ...base, kind: "store" });
    assert.deepEqual(store.slice(3).map((k) => [k.key, k.value, k.unit]), [["open_registers", 1, "count"], ["sales_today", 5000, "cents"]]);
    assert.equal(deriveKpis({ ...base, bookings: [], kind: "warehouse" })[2]!.hint, "No deliveries in 30 days");
  });

  it("inbound steps follow the PO and the booking timestamps", () => {
    const keys = (b: BookingRow) => shipmentSteps(b).map((s) => `${s.key}:${s.done ? "y" : "n"}`).join(" ");
    assert.equal(keys(booking()), "confirmed:y booked:y arrived:n unloading:n received:n");
    assert.equal(keys(booking({ status: "unloading", arrivedAt: ago(H), startedAt: ago(30 * MIN) })), "confirmed:y booked:y arrived:y unloading:y received:n");
    assert.equal(keys(booking({ purchaseOrder: { status: "draft", sentAt: null, receivedAt: null } })), "confirmed:n booked:y arrived:n unloading:n received:n");
    const done = shipmentSteps(booking({ status: "done", arrivedAt: ago(2 * H), startedAt: ago(H), doneAt: ago(MIN), purchaseOrder: { status: "received", sentAt: ago(48 * H), receivedAt: ago(5 * MIN) } }));
    assert.equal(done.every((s) => s.done), true);
    assert.equal(done.at(-1)!.at, ago(5 * MIN).toISOString(), "received at the PO's receipt");
  });

  it("outbound steps: confirmed, picked, loaded, in transit; delivered stays open (no record yet)", () => {
    const out = (over: Partial<BookingRow>) =>
      shipmentSteps(booking({ direction: "outbound", purchaseOrderId: null, purchaseOrder: null, orderId: "ord_1", order: { status: "confirmed", paidAt: null, createdAt: ago(5 * H) }, ...over }));
    assert.deepEqual(out({}).map((s) => s.done), [true, false, false, false, false]);
    assert.deepEqual(out({ status: "loading", arrivedAt: ago(H), startedAt: ago(30 * MIN) }).map((s) => s.done), [true, true, false, false, false]);
    assert.deepEqual(out({ status: "done", arrivedAt: ago(H), startedAt: ago(30 * MIN), doneAt: ago(MIN) }).map((s) => s.done), [true, true, true, true, false]);
    assert.equal(bookingRef({ orderId: "ord_1" }), "SO-ORD_1");
  });

  it("shipments: active + finished in the last 24 h, current step, late, dock object", () => {
    const list = deriveShipments(
      [
        booking({ id: "active", eta: ago(DOCK_ETA_GRACE_MS + MIN) }),
        booking({ id: "recent", status: "done", arrivedAt: ago(3 * H), doneAt: ago(2 * H) }),
        booking({ id: "old", status: "done", arrivedAt: ago(30 * H), doneAt: ago(25 * H) }),
        booking({ id: "gone", status: "cancelled", cancelledAt: ago(H) }),
      ],
      (loc) => (loc === "loc_dock1" ? "obj_dock1" : null),
      NOW,
    );
    assert.deepEqual(list.map((s) => s.id).sort(), ["active", "recent"]);
    const active = list.find((s) => s.id === "active")!;
    assert.equal(active.late, true);
    assert.equal(active.currentStep, 2, "waiting to arrive");
    assert.equal(active.dockObjectId, "obj_dock1");
    assert.equal(list.find((s) => s.id === "recent")!.late, false);
  });
});

describe("agent markers", () => {
  it("running and waiting runs that mention an object or its bound record", () => {
    const objects = [
      { id: "obj_dock_000001", binding: { id: "loc_dock_000001" } },
      { id: "obj_rack_000002", binding: null },
    ];
    const markers = agentMarkers(
      [
        { runId: "r1", agentKey: "operator", status: "running", waiting: false, haystack: "twin_book_dock: booked loc_dock_000001 for TRK-9" },
        { runId: "r2", agentKey: null, status: "succeeded", waiting: true, haystack: "twin_find: obj_rack_000002" },
        { runId: "r3", agentKey: null, status: "running", waiting: false, haystack: "nothing relevant" },
        { runId: "r4", agentKey: null, status: "failed", waiting: false, haystack: "obj_rack_000002" },
      ],
      objects,
    );
    assert.deepEqual(markers.map((m) => [m.objectId, m.runId, m.status]), [
      ["obj_dock_000001", "r1", "running"],
      ["obj_rack_000002", "r2", "needs"],
    ]);
    assert.equal(markers[0]!.label, "Operator agent: running");
    assert.equal(markers[1]!.label, "Lead agent: needs you");
  });
});

function obj(id: string, over: Partial<TwinObject> = {}): TwinObject {
  return {
    id,
    kind: "rack",
    label: id,
    footprint: { x: 0, z: 0, w: 1, d: 1, h: 1, rotation: 0 },
    binding: null,
    bindingBroken: false,
    state: { kind: "rack", onHand: 0, skuCount: 0, lowStockCount: 0 },
    pill: "Empty",
    alert: null,
    ...over,
  };
}

function snap(objects: TwinObject[], over: Partial<TwinSnapshot> = {}): TwinSnapshot {
  return {
    site: { id: "site", kind: "warehouse", status: "published", name: "Main", code: "WH-01", gridW: 20, gridD: 20, warehouseId: "wh" },
    objects,
    kpis: [{ key: "stock_on_hand", label: "Stock on hand", value: 0, unit: "count", hint: null }],
    shipments: [],
    agents: [],
    generatedAt: NOW.toISOString(),
    ...over,
  };
}

describe("siteDiff", () => {
  const a = snap([obj("a"), obj("b"), obj("c")]);
  it("equal snapshots → no ops (a newer generatedAt alone sends nothing)", () => {
    assert.deepEqual(siteDiff(a, structuredClone(a)), []);
    assert.deepEqual(siteDiff(a, { ...structuredClone(a), generatedAt: new Date(NOW.getTime() + 4000).toISOString() }), []);
  });
  it("one object changed → one replace at its index (+ generatedAt)", () => {
    const next = structuredClone(a);
    next.objects[1] = obj("b", { state: { kind: "rack", onHand: 5, skuCount: 1, lowStockCount: 0 }, pill: "5 on hand" });
    next.generatedAt = new Date(NOW.getTime() + 4000).toISOString();
    const ops = siteDiff(a, next);
    assert.deepEqual(ops.map((o) => o.path), ["/objects/1", "/generatedAt"]);
    assert.deepEqual(applyTwinPatch(a, ops), next);
  });
  it("object added (or reordered) → replace /objects", () => {
    const added = snap([obj("a"), obj("b"), obj("c"), obj("d")]);
    assert.deepEqual(siteDiff(a, added).map((o) => o.path), ["/objects"]);
    assert.deepEqual(siteDiff(a, snap([obj("a"), obj("c"), obj("b")])).map((o) => o.path), ["/objects"]);
    assert.deepEqual(applyTwinPatch(a, siteDiff(a, added)), added);
  });
  it("kpis / shipments / agents / site → one replace each", () => {
    const next = snap(a.objects, {
      kpis: [{ key: "stock_on_hand", label: "Stock on hand", value: 9, unit: "count", hint: null }],
      agents: [{ objectId: "a", runId: "r", agentKey: null, status: "running", label: "Lead agent: running" }],
      site: { ...a.site, status: "draft" },
    });
    assert.deepEqual(siteDiff(a, next).map((o) => o.path).sort(), ["/agents", "/kpis", "/site"]);
  });
});

describe("alert candidates", () => {
  it("one per alerted object, keyed on the record so it alerts once", () => {
    const s = snap([
      obj("dock", {
        kind: "dock_door",
        state: { kind: "dock_door", status: "overdue", booking: { id: "bk_9", direction: "inbound", carrier: null, truckRef: "T", status: "booked", eta: null, arrivedAt: null, ref: null }, upcoming: 0 },
        alert: { key: "dock_overdue", message: "T is 40 min past its ETA" },
      }),
      obj("quiet"),
    ]);
    const c = alertCandidates(s);
    assert.equal(c.length, 1);
    assert.equal(c[0]!.trigger, "twin.dock_overdue");
    assert.equal(c[0]!.dedupKey, "twin.dock_overdue:site:dock:bk_9:booked");
  });
});
