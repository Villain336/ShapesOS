// ShapesOS — Phase 13: the digital twin CONTRACT.
//
// One isometric site (warehouse, factory or store) drawn from ShapesOS records.
// This file is the shared contract between the data side (lib/twin/state.ts,
// APIs, tools, alerts — workstream "twincore") and the scene/pages side
// (components/twin/*, app/dashboard/ops/twin/* — workstream "twinui"). Change
// it only with both sides in mind. PURE: types and constants only.
//
// Ground rules (owner decisions, 2026-10-04):
//   - Live state comes from ShapesOS records, never a simulator.
//   - A site is a LAYOUT LAYER over an existing OpsWarehouse: racks, bins,
//     shelves and dock doors bind to OpsLocation rows (kinds rack / bin /
//     shelf / dock / zone already exist), work centres to OpsWorkCenter,
//     registers to OpsPosRegister. Object state is DERIVED from the bound
//     record at read time — never stored on the object — so there is one
//     source of truth. The one exception is equipment (forklifts, carts):
//     nothing else records them, so their small status lives on the object.
//   - Equipment positions are honest: with no telemetry an item is drawn at
//     its last assigned task location and the UI labels it "estimated".
//   - Entity states render as neutral text pills; the agent status colours +
//     shapes (lib/aos/status.ts) appear ONLY for agents working on an object.

import type { AosStatus } from "@/lib/aos/status";

export const TWIN_SITE_KINDS = ["warehouse", "factory", "store"] as const;
export type TwinSiteKind = (typeof TWIN_SITE_KINDS)[number];

export const TWIN_SITE_STATUSES = ["draft", "published"] as const;
export type TwinSiteStatus = (typeof TWIN_SITE_STATUSES)[number];

export const TWIN_OBJECT_KINDS = [
  "building",
  "dock_door",
  "rack",
  "bin_zone",
  "yard_slot",
  "work_center",
  "register",
  "shelf",
  "path",
  "equipment",
] as const;
export type TwinObjectKind = (typeof TWIN_OBJECT_KINDS)[number];

/** What a layout object may be bound to (null = decorative / unbound). */
export type TwinBindingType = "location" | "work_center" | "register" | "product";

/** Which binding types each object kind accepts (validated on create/patch). */
export const TWIN_BINDABLE: Readonly<Record<TwinObjectKind, readonly TwinBindingType[]>> = {
  building: [],
  dock_door: ["location"], // an OpsLocation of kind "dock"
  rack: ["location"], // kind rack (or aisle/zone)
  bin_zone: ["location"], // kind bin / zone
  yard_slot: [],
  work_center: ["work_center"],
  register: ["register"],
  shelf: ["location", "product"], // a store shelf: a location, or one product's facing
  path: [],
  equipment: [],
};

export type TwinRotation = 0 | 90 | 180 | 270;

/** Grid units: 1 cell = 1 metre. x grows east, z grows south (three.js x/z). */
export interface TwinFootprint {
  x: number;
  z: number;
  /** width along x, depth along z, height (cells); w/d >= 1. */
  w: number;
  d: number;
  h: number;
  rotation: TwinRotation;
}

// ---------------------------------------------------------------------------
// Derived per-kind state (what the scene and inspector show)
// ---------------------------------------------------------------------------

export interface TwinDockBookingSummary {
  id: string;
  direction: "inbound" | "outbound";
  carrier: string | null;
  truckRef: string | null;
  status: TwinDockBookingStatus;
  eta: string | null; // ISO
  arrivedAt: string | null;
  /** What the booking serves, as a display reference ("PO-0012", "SO-0044", "TR-0003"). */
  ref: string | null;
}

export const TWIN_DOCK_BOOKING_STATUSES = ["booked", "arrived", "loading", "unloading", "done", "cancelled"] as const;
export type TwinDockBookingStatus = (typeof TWIN_DOCK_BOOKING_STATUSES)[number];

export type TwinObjectState =
  | { kind: "dock_door"; status: "free" | "booked" | "occupied" | "overdue"; booking: TwinDockBookingSummary | null; upcoming: number }
  | { kind: "rack" | "bin_zone" | "shelf"; onHand: number; skuCount: number; lowStockCount: number }
  | {
      kind: "work_center";
      status: "idle" | "running" | "paused" | "stopped";
      workOrder: { id: string; moId: string; moNumber: string | null; name: string; runningSince: string | null } | null;
      /** logged minutes ÷ (capacity × open minutes) over the last 7 days, 0–100. */
      utilisationPct: number;
      /** the active MO is past its planned start and not done */
      late: boolean;
    }
  | { kind: "register"; status: "closed" | "open" | "closing"; sessionId: string | null; sessionNumber: string | null; salesCents: number; openedAt: string | null }
  | {
      kind: "equipment";
      status: "available" | "busy" | "charging";
      task: { note: string | null; locationId: string | null; label: string | null; assignedAt: string | null } | null;
      /** where to draw it: the task location's object, else its home cell */
      position: { x: number; z: number };
      positionIsEstimated: true;
    }
  | { kind: "building" | "yard_slot" | "path" };

export interface TwinObject {
  id: string;
  kind: TwinObjectKind;
  label: string;
  footprint: TwinFootprint;
  binding: { type: TwinBindingType; id: string; label: string | null } | null;
  /** true when the bound record is gone or in another workspace (shown as "unbound"). */
  bindingBroken: boolean;
  state: TwinObjectState;
  /** neutral text pill for the entity state (never a status colour) */
  pill: string | null;
  /** an alert currently raised on this object (dock overdue, bin low, …) */
  alert: { key: TwinAlertKey; message: string } | null;
}

// ---------------------------------------------------------------------------
// KPIs, shipments, agents, the snapshot
// ---------------------------------------------------------------------------

export type TwinKpiKey =
  | "stock_on_hand"
  | "trucks_on_site"
  | "on_time_delivery_30d"
  | "work_center_utilisation"
  | "open_registers"
  | "sales_today";

export interface TwinKpi {
  key: TwinKpiKey;
  label: string;
  value: number;
  unit: "count" | "pct" | "cents";
  /** small context line ("3 docks busy", "of 6 deliveries") */
  hint: string | null;
}

export const TWIN_SHIPMENT_STEPS = ["confirmed", "picked", "loaded", "in_transit", "delivered"] as const;
export type TwinShipmentStepKey = (typeof TWIN_SHIPMENT_STEPS)[number] | "booked" | "arrived" | "unloading" | "received";

export interface TwinShipment {
  id: string; // the dock booking id
  direction: "inbound" | "outbound";
  ref: string | null;
  carrier: string | null;
  truckRef: string | null;
  dockObjectId: string | null;
  steps: { key: TwinShipmentStepKey; label: string; done: boolean; at: string | null }[];
  currentStep: number; // index into steps
  eta: string | null;
  late: boolean;
}

/** An agent currently working on (a record bound to) an object. */
export interface TwinAgentMarker {
  objectId: string;
  runId: string;
  agentKey: string | null;
  status: AosStatus; // running | needs | done | failed | queued | paused
  label: string;
}

export type TwinAlertKey = "dock_overdue" | "bin_low" | "machine_stopped_late" | "register_left_open";

export interface TwinSnapshot {
  site: {
    id: string;
    kind: TwinSiteKind;
    status: TwinSiteStatus;
    name: string;
    code: string;
    gridW: number;
    gridD: number;
    warehouseId: string;
  };
  objects: TwinObject[]; // sorted by id (stable order for diffs)
  kpis: TwinKpi[];
  shipments: TwinShipment[];
  agents: TwinAgentMarker[];
  generatedAt: string; // ISO
}

// ---------------------------------------------------------------------------
// Live stream (GET /api/twin/sites/[id]/live, text/event-stream)
//   event: snapshot   data: TwinSnapshot            (first frame, and after a layout change)
//   event: patch      data: TwinPatchOp[]           (RFC 6902 ops against the last snapshot)
//   event: end        data: { reason: string }
//   ": ping" comment every 15 s. Server polls the DB every TWIN_LIVE_POLL_MS.
// ---------------------------------------------------------------------------

export type TwinPatchOp =
  | { op: "replace"; path: string; value: unknown }
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string };

export const TWIN_LIVE_POLL_MS = 4_000;
export const TWIN_LIVE_MAX_MS = 30 * 60 * 1000;

/** API paths (data side implements; scene/pages side consumes). */
export const TWIN_API = {
  state: (siteId: string) => `/api/twin/sites/${encodeURIComponent(siteId)}/state`,
  live: (siteId: string) => `/api/twin/sites/${encodeURIComponent(siteId)}/live`,
  sample: "/api/twin/sites/sample",
  /** generic ops CRUD (lib/ops/twin/entities.ts) */
  sites: "/api/ops/twin-sites",
  objects: "/api/ops/twin-objects",
  dockBookings: "/api/ops/dock-bookings",
} as const;
