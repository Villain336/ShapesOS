// ShapesOS — Phase 13 (twinui): fixture snapshots, one per site kind.
//
// Realistic TwinSnapshot values shaped exactly like the contract
// (lib/twin/types.ts) so the scene, overlays and derivation helpers can be
// unit-tested without a database. Used by tests and the dev-only harness;
// NEVER imported by a production page (live data comes from
// lib/twin/state.ts siteSnapshot).

import type {
  TwinAgentMarker,
  TwinDockBookingSummary,
  TwinFootprint,
  TwinKpi,
  TwinObject,
  TwinObjectKind,
  TwinObjectState,
  TwinShipment,
  TwinSnapshot,
} from "./types";

const AT = "2026-10-04T09:30:00.000Z";
const iso = (minutesFromAt: number) => new Date(Date.parse(AT) + minutesFromAt * 60_000).toISOString();

function fp(x: number, z: number, w: number, d: number, h: number, rotation: TwinFootprint["rotation"] = 0): TwinFootprint {
  return { x, z, w, d, h, rotation };
}

function obj(
  id: string,
  kind: TwinObjectKind,
  label: string,
  footprint: TwinFootprint,
  state: TwinObjectState,
  extra: Partial<Pick<TwinObject, "binding" | "bindingBroken" | "pill" | "alert">> = {},
): TwinObject {
  return {
    id,
    kind,
    label,
    footprint,
    binding: extra.binding ?? null,
    bindingBroken: extra.bindingBroken ?? false,
    state,
    pill: extra.pill ?? null,
    alert: extra.alert ?? null,
  };
}

const loc = (id: string, label: string) => ({ type: "location" as const, id, label });
const stock = (kind: "rack" | "bin_zone" | "shelf", onHand: number, skuCount: number, lowStockCount = 0): TwinObjectState => ({
  kind,
  onHand,
  skuCount,
  lowStockCount,
});
const plain = (kind: "building" | "yard_slot" | "path"): TwinObjectState => ({ kind });

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---------------------------------------------------------------------------
// Warehouse: hall + office, 4 dock doors, racks, bins, yard, 3 forklifts,
// 2 trucks booked (one unloading at a dock, one due), one overdue dock.
// ---------------------------------------------------------------------------

const bookingInbound: TwinDockBookingSummary = {
  id: "bk_w_01",
  direction: "inbound",
  carrier: "Northline Freight",
  truckRef: "NL-4471",
  status: "unloading",
  eta: iso(-50),
  arrivedAt: iso(-42),
  ref: "PO-0012",
};
const bookingOutbound: TwinDockBookingSummary = {
  id: "bk_w_02",
  direction: "outbound",
  carrier: "Coastal Haulage",
  truckRef: "CH-208",
  status: "booked",
  eta: iso(35),
  arrivedAt: null,
  ref: "SO-0044",
};
const bookingOverdue: TwinDockBookingSummary = {
  id: "bk_w_03",
  direction: "inbound",
  carrier: "Ridgeway Logistics",
  truckRef: "RW-77",
  status: "booked",
  eta: iso(-95),
  arrivedAt: null,
  ref: "TR-0003",
};

export const WAREHOUSE_FIXTURE: TwinSnapshot = {
  site: { id: "site_wh04", kind: "warehouse", status: "published", name: "Riverside warehouse", code: "WH-04", gridW: 48, gridD: 40, warehouseId: "wh_riverside" },
  objects: [
    obj("o_w_building_office", "building", "Office", fp(35, 2, 10, 7, 4), plain("building")),
    obj(
      "o_w_dock_1",
      "dock_door",
      "Dock 1",
      fp(4, 22, 4, 1, 4),
      { kind: "dock_door", status: "free", booking: null, upcoming: 0 },
      { binding: loc("loc_dock_1", "WH-04/DOCK-1"), pill: "Free" },
    ),
    obj(
      "o_w_dock_2",
      "dock_door",
      "Dock 2",
      fp(10, 22, 4, 1, 4),
      { kind: "dock_door", status: "occupied", booking: bookingInbound, upcoming: 1 },
      { binding: loc("loc_dock_2", "WH-04/DOCK-2"), pill: "Unloading" },
    ),
    obj(
      "o_w_dock_3",
      "dock_door",
      "Dock 3",
      fp(16, 22, 4, 1, 4),
      { kind: "dock_door", status: "booked", booking: bookingOutbound, upcoming: 1 },
      { binding: loc("loc_dock_3", "WH-04/DOCK-3"), pill: "Booked 10:05" },
    ),
    obj(
      "o_w_dock_4",
      "dock_door",
      "Dock 4",
      fp(22, 22, 4, 1, 4),
      { kind: "dock_door", status: "overdue", booking: bookingOverdue, upcoming: 0 },
      {
        binding: loc("loc_dock_4", "WH-04/DOCK-4"),
        pill: "Overdue",
        alert: { key: "dock_overdue", message: "RW-77 was due at 07:55 and has not arrived." },
      },
    ),
    obj("o_w_rack_a", "rack", "Rack A", fp(5, 4, 10, 1, 5), stock("rack", 1240, 18), { binding: loc("loc_rack_a", "WH-04/A"), pill: "1,240 on hand" }),
    obj("o_w_rack_b", "rack", "Rack B", fp(5, 7, 10, 1, 5), stock("rack", 860, 12), { binding: loc("loc_rack_b", "WH-04/B"), pill: "860 on hand" }),
    obj("o_w_rack_c", "rack", "Rack C", fp(18, 4, 10, 1, 5), stock("rack", 310, 9, 2), { binding: loc("loc_rack_c", "WH-04/C"), pill: "2 low" }),
    obj("o_w_rack_d", "rack", "Rack D", fp(18, 7, 10, 1, 5), stock("rack", 0, 0), { binding: loc("loc_rack_d", "WH-04/D"), pill: "Empty" }),
    obj("o_w_rack_e", "rack", "Rack E", fp(5, 10, 10, 1, 5), stock("rack", 2010, 22), { binding: loc("loc_rack_e", "WH-04/E"), pill: "2,010 on hand" }),
    obj("o_w_rack_f", "rack", "Rack F", fp(18, 10, 10, 1, 5), stock("rack", 95, 3), { binding: loc("loc_rack_f", "WH-04/F"), pill: "95 on hand" }),
    obj(
      "o_w_bins_pick",
      "bin_zone",
      "Pick face",
      fp(5, 14, 8, 3, 1),
      stock("bin_zone", 420, 36, 3),
      {
        binding: loc("loc_bins_pick", "WH-04/PICK"),
        pill: "3 low",
        alert: { key: "bin_low", message: "3 bins are below their reorder point." },
      },
    ),
    obj("o_w_bins_returns", "bin_zone", "Returns", fp(18, 14, 6, 3, 1), stock("bin_zone", 38, 7), { binding: loc("loc_bins_ret", "WH-04/RET"), pill: "38 on hand" }),
    obj("o_w_path_main", "path", "Main aisle", fp(3, 12, 28, 1, 1), plain("path")),
    obj("o_w_path_dock", "path", "Dock lane", fp(3, 19, 28, 2, 1), plain("path")),
    obj("o_w_yard_1", "yard_slot", "Yard 1", fp(30, 26, 4, 10, 1), plain("yard_slot"), { pill: "Empty" }),
    obj("o_w_yard_2", "yard_slot", "Yard 2", fp(35, 26, 4, 10, 1), plain("yard_slot"), { pill: "Empty" }),
    obj("o_w_yard_3", "yard_slot", "Yard 3", fp(40, 26, 4, 10, 1), plain("yard_slot"), { pill: "Empty" }),
    obj(
      "o_w_fork_1",
      "equipment",
      "Forklift 1",
      fp(8, 18, 1, 2, 2),
      {
        kind: "equipment",
        status: "busy",
        task: { note: "Put away PO-0012 pallets", locationId: "loc_rack_a", label: "Rack A", assignedAt: iso(-20) },
        position: { x: 9, z: 5.5 },
        positionIsEstimated: true,
      },
      { pill: "Busy" },
    ),
    obj(
      "o_w_fork_2",
      "equipment",
      "Forklift 2",
      fp(12, 18, 1, 2, 2),
      { kind: "equipment", status: "available", task: null, position: { x: 12.5, z: 19 }, positionIsEstimated: true },
      { pill: "Available" },
    ),
    obj(
      "o_w_fork_3",
      "equipment",
      "Forklift 3",
      fp(36, 10, 1, 2, 2),
      { kind: "equipment", status: "charging", task: null, position: { x: 36.5, z: 11 }, positionIsEstimated: true },
      { pill: "Charging" },
    ),
  ].sort(byId),
  kpis: [
    { key: "stock_on_hand", label: "Stock on hand", value: 4973, unit: "count", hint: "107 SKUs across 8 locations" },
    { key: "trucks_on_site", label: "Trucks on site", value: 1, unit: "count", hint: "2 more booked today" },
    { key: "on_time_delivery_30d", label: "On-time delivery", value: 92, unit: "pct", hint: "of 38 deliveries, 30 days" },
  ] satisfies TwinKpi[],
  shipments: [
    {
      id: "bk_w_01",
      direction: "inbound",
      ref: "PO-0012",
      carrier: "Northline Freight",
      truckRef: "NL-4471",
      dockObjectId: "o_w_dock_2",
      steps: [
        { key: "booked", label: "Booked", done: true, at: iso(-1440) },
        { key: "in_transit", label: "In transit", done: true, at: iso(-180) },
        { key: "arrived", label: "Arrived", done: true, at: iso(-42) },
        { key: "unloading", label: "Unloading", done: false, at: iso(-30) },
        { key: "received", label: "Received", done: false, at: null },
      ],
      currentStep: 3,
      eta: iso(-50),
      late: false,
    },
    {
      id: "bk_w_02",
      direction: "outbound",
      ref: "SO-0044",
      carrier: "Coastal Haulage",
      truckRef: "CH-208",
      dockObjectId: "o_w_dock_3",
      steps: [
        { key: "confirmed", label: "Order confirmed", done: true, at: iso(-300) },
        { key: "picked", label: "Picked", done: true, at: iso(-60) },
        { key: "loaded", label: "Loaded", done: false, at: null },
        { key: "in_transit", label: "In transit", done: false, at: null },
        { key: "delivered", label: "Delivered", done: false, at: null },
      ],
      currentStep: 2,
      eta: iso(35),
      late: false,
    },
    {
      id: "bk_w_03",
      direction: "inbound",
      ref: "TR-0003",
      carrier: "Ridgeway Logistics",
      truckRef: "RW-77",
      dockObjectId: "o_w_dock_4",
      steps: [
        { key: "booked", label: "Booked", done: true, at: iso(-2000) },
        { key: "in_transit", label: "In transit", done: false, at: null },
        { key: "arrived", label: "Arrived", done: false, at: null },
        { key: "unloading", label: "Unloading", done: false, at: null },
        { key: "received", label: "Received", done: false, at: null },
      ],
      currentStep: 1,
      eta: iso(-95),
      late: true,
    },
  ] satisfies TwinShipment[],
  agents: [
    { objectId: "o_w_dock_4", runId: "run_w_1", agentKey: "scheduler", status: "needs", label: "Rebook RW-77 to Dock 1?" },
    { objectId: "o_w_rack_c", runId: "run_w_2", agentKey: "planner", status: "running", label: "Drafting a restock for Rack C" },
  ] satisfies TwinAgentMarker[],
  generatedAt: AT,
};

// ---------------------------------------------------------------------------
// Factory: production hall, 5 work centres (running / paused / stopped+late /
// idle), raw-material racks, a goods-out dock, a cart.
// ---------------------------------------------------------------------------

export const FACTORY_FIXTURE: TwinSnapshot = {
  site: { id: "site_pl01", kind: "factory", status: "published", name: "Eastside plant", code: "PL-01", gridW: 44, gridD: 40, warehouseId: "wh_eastside" },
  objects: [
    obj("o_f_building_office", "building", "Office", fp(35, 2, 7, 6, 4), plain("building")),
    obj(
      "o_f_wc_cut",
      "work_center",
      "Cutting",
      fp(5, 5, 5, 4, 3),
      {
        kind: "work_center",
        status: "running",
        workOrder: { id: "wo_f_1", moId: "mo_f_1", moNumber: "MO-0031", name: "Cut panels", runningSince: iso(-75) },
        utilisationPct: 78,
        late: false,
      },
      { binding: { type: "work_center", id: "wc_cut", label: "Cutting" }, pill: "Running" },
    ),
    obj(
      "o_f_wc_weld",
      "work_center",
      "Welding",
      fp(13, 5, 5, 4, 3),
      {
        kind: "work_center",
        status: "stopped",
        workOrder: { id: "wo_f_2", moId: "mo_f_2", moNumber: "MO-0029", name: "Weld frames", runningSince: null },
        utilisationPct: 41,
        late: true,
      },
      {
        binding: { type: "work_center", id: "wc_weld", label: "Welding" },
        pill: "Stopped",
        alert: { key: "machine_stopped_late", message: "Welding is stopped and MO-0029 is past its planned start." },
      },
    ),
    obj(
      "o_f_wc_asm",
      "work_center",
      "Assembly",
      fp(21, 5, 6, 4, 3),
      {
        kind: "work_center",
        status: "paused",
        workOrder: { id: "wo_f_3", moId: "mo_f_3", moNumber: "MO-0032", name: "Assemble chairs", runningSince: null },
        utilisationPct: 63,
        late: false,
      },
      { binding: { type: "work_center", id: "wc_asm", label: "Assembly" }, pill: "Paused" },
    ),
    obj(
      "o_f_wc_paint",
      "work_center",
      "Paint booth",
      fp(5, 13, 6, 5, 4),
      { kind: "work_center", status: "idle", workOrder: null, utilisationPct: 22, late: false },
      { binding: { type: "work_center", id: "wc_paint", label: "Paint booth" }, pill: "Idle" },
    ),
    obj(
      "o_f_wc_qa",
      "work_center",
      "Quality check",
      fp(14, 13, 4, 4, 2),
      {
        kind: "work_center",
        status: "running",
        workOrder: { id: "wo_f_4", moId: "mo_f_4", moNumber: "MO-0030", name: "Inspect batch", runningSince: iso(-12) },
        utilisationPct: 55,
        late: false,
      },
      { binding: { type: "work_center", id: "wc_qa", label: "Quality check" }, pill: "Running" },
    ),
    obj("o_f_rack_raw", "rack", "Raw materials", fp(29, 5, 2, 12, 5, 0), stock("rack", 3400, 14), { binding: loc("loc_f_raw", "PL-01/RAW"), pill: "3,400 on hand" }),
    obj("o_f_bins_parts", "bin_zone", "Small parts", fp(22, 13, 5, 3, 1), stock("bin_zone", 5200, 40, 1), { binding: loc("loc_f_parts", "PL-01/PARTS"), pill: "1 low" }),
    obj("o_f_path", "path", "Line aisle", fp(3, 10, 32, 2, 1), plain("path")),
    obj(
      "o_f_dock_out",
      "dock_door",
      "Goods out",
      fp(26, 24, 5, 1, 4),
      { kind: "dock_door", status: "free", booking: null, upcoming: 1 },
      { binding: loc("loc_f_dock", "PL-01/DOCK"), pill: "Free" },
    ),
    obj(
      "o_f_cart",
      "equipment",
      "Tow cart",
      fp(24, 19, 1, 2, 1),
      {
        kind: "equipment",
        status: "busy",
        task: { note: "Deliver frames to Assembly", locationId: null, label: "Assembly", assignedAt: iso(-8) },
        position: { x: 24, z: 10.5 },
        positionIsEstimated: true,
      },
      { pill: "Busy" },
    ),
  ].sort(byId),
  kpis: [
    { key: "work_center_utilisation", label: "Work-centre utilisation", value: 52, unit: "pct", hint: "5 work centres, 7 days" },
    { key: "stock_on_hand", label: "Stock on hand", value: 8600, unit: "count", hint: "54 SKUs" },
    { key: "on_time_delivery_30d", label: "On-time delivery", value: 88, unit: "pct", hint: "of 17 deliveries, 30 days" },
  ],
  shipments: [],
  agents: [{ objectId: "o_f_wc_weld", runId: "run_f_1", agentKey: "analyst", status: "failed", label: "Could not reschedule MO-0029" }],
  generatedAt: AT,
};

// ---------------------------------------------------------------------------
// Store: sales floor with shelves, 3 registers (open / closed / left open),
// a backroom bin zone, a receiving door.
// ---------------------------------------------------------------------------

export const STORE_FIXTURE: TwinSnapshot = {
  site: { id: "site_st02", kind: "store", status: "draft", name: "Market Street store", code: "ST-02", gridW: 44, gridD: 26, warehouseId: "wh_market" },
  objects: [
    obj("o_s_building", "building", "Staff room", fp(2, 18, 8, 5, 3), plain("building")),
    obj("o_s_shelf_1", "shelf", "Aisle 1", fp(5, 5, 8, 1, 2), stock("shelf", 240, 30), { binding: loc("loc_s_a1", "ST-02/A1"), pill: "240 on hand" }),
    obj("o_s_shelf_2", "shelf", "Aisle 2", fp(5, 8, 8, 1, 2), stock("shelf", 120, 22, 4), { binding: loc("loc_s_a2", "ST-02/A2"), pill: "4 low" }),
    obj("o_s_shelf_3", "shelf", "Aisle 3", fp(5, 11, 8, 1, 2), stock("shelf", 310, 28), { binding: loc("loc_s_a3", "ST-02/A3"), pill: "310 on hand" }),
    obj(
      "o_s_shelf_promo",
      "shelf",
      "Promo end cap",
      fp(15, 5, 2, 2, 2),
      stock("shelf", 48, 1),
      { binding: { type: "product", id: "prd_mug", label: "Stoneware mug" }, pill: "48 on hand" },
    ),
    obj(
      "o_s_reg_1",
      "register",
      "Register 1",
      fp(19, 14, 2, 1, 1),
      { kind: "register", status: "open", sessionId: "ps_1", sessionNumber: "POS-0101", salesCents: 184_250, openedAt: iso(-150) },
      { binding: { type: "register", id: "reg_1", label: "Register 1" }, pill: "Open" },
    ),
    obj(
      "o_s_reg_2",
      "register",
      "Register 2",
      fp(22, 14, 2, 1, 1),
      { kind: "register", status: "closed", sessionId: null, sessionNumber: null, salesCents: 0, openedAt: null },
      { binding: { type: "register", id: "reg_2", label: "Register 2" }, pill: "Closed" },
    ),
    obj(
      "o_s_reg_3",
      "register",
      "Register 3",
      fp(25, 14, 2, 1, 1),
      { kind: "register", status: "open", sessionId: "ps_0", sessionNumber: "POS-0098", salesCents: 41_900, openedAt: iso(-1500) },
      {
        binding: { type: "register", id: "reg_3", label: "Register 3" },
        pill: "Open since yesterday",
        alert: { key: "register_left_open", message: "POS-0098 has been open for 25 hours." },
      },
    ),
    obj("o_s_backroom", "bin_zone", "Backroom", fp(20, 4, 6, 4, 1), stock("bin_zone", 900, 60), { binding: loc("loc_s_back", "ST-02/BACK"), pill: "900 on hand" }),
    obj("o_s_path", "path", "Entrance", fp(14, 17, 4, 3, 1), plain("path")),
    obj(
      "o_s_dock",
      "dock_door",
      "Receiving",
      // w/d are the grid extent (1 × 3 cells); turned 90° the door faces east.
      fp(28, 5, 1, 3, 3, 90),
      { kind: "dock_door", status: "free", booking: null, upcoming: 0 },
      { binding: loc("loc_s_dock", "ST-02/RCV"), pill: "Free" },
    ),
    // A shelf whose bound location was deleted: shown as "unbound".
    obj("o_s_shelf_old", "shelf", "Seasonal", fp(5, 14, 6, 1, 2), stock("shelf", 0, 0), {
      binding: { type: "location", id: "loc_gone", label: null },
      bindingBroken: true,
      pill: "Unbound",
    }),
  ].sort(byId),
  kpis: [
    { key: "open_registers", label: "Open registers", value: 2, unit: "count", hint: "of 3" },
    { key: "sales_today", label: "Sales today", value: 226_150, unit: "cents", hint: "2 sessions" },
    { key: "stock_on_hand", label: "Stock on hand", value: 1618, unit: "count", hint: "141 SKUs" },
  ],
  shipments: [],
  agents: [{ objectId: "o_s_shelf_2", runId: "run_s_1", agentKey: "actor", status: "done", label: "Restock request sent" }],
  generatedAt: AT,
};

export const TWIN_FIXTURES: Readonly<Record<TwinSnapshot["site"]["kind"], TwinSnapshot>> = {
  warehouse: WAREHOUSE_FIXTURE,
  factory: FACTORY_FIXTURE,
  store: STORE_FIXTURE,
};

/** The list-page shape of the fixtures (listSites). */
export function fixtureSiteList() {
  return Object.values(TWIN_FIXTURES).map((s) => ({
    id: s.site.id,
    kind: s.site.kind,
    status: s.site.status,
    name: s.site.name,
    code: s.site.code,
    objectCount: s.objects.length,
    updatedAt: s.generatedAt,
  }));
}
