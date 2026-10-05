// ShapesOS — Phase 13 (twincore): the digital twin's PURE rules.
//
// Everything the state service (lib/twin/state.ts) and the ops entity hooks
// (lib/twin/service.ts) decide lives here so it unit-tests without a
// database: layout validation, per-kind derived state, alerts, KPIs,
// shipment steps, agent markers and the snapshot differ. No prisma, no
// React, no I/O — safe to import from client components too (the scene side
// may call siteDiff / applyTwinPatch in the browser).
//
// Ground rules (lib/twin/types.ts): live state is DERIVED from the bound
// records at read time — never stored on the object — except equipment,
// whose small status lives on its row because nothing else records it.

import { fromAgentRunStatus, statusLabel, type AosStatus } from "@/lib/aos/status";
import {
  TWIN_BINDABLE,
  TWIN_OBJECT_KINDS,
  type TwinAgentMarker,
  type TwinAlertKey,
  type TwinBindingType,
  type TwinDockBookingStatus,
  type TwinDockBookingSummary,
  type TwinFootprint,
  type TwinKpi,
  type TwinObject,
  type TwinObjectKind,
  type TwinObjectState,
  type TwinPatchOp,
  type TwinRotation,
  type TwinShipment,
  type TwinShipmentStepKey,
  type TwinSiteKind,
  type TwinSnapshot,
} from "./types";

// ---------------------------------------------------------------------------
// Thresholds (constants on purpose: the alerts, the snapshot and the tests
// read the same numbers)
// ---------------------------------------------------------------------------

/** A booked truck is overdue once its ETA has passed by more than this. */
export const DOCK_ETA_GRACE_MS = 30 * 60_000;
/** A truck on site (arrived / loading / unloading) longer than this is overdue. */
export const DOCK_ON_SITE_MAX_MS = 4 * 3_600_000;
/** A till session open longer than this was left open. */
export const REGISTER_LEFT_OPEN_MS = 12 * 3_600_000;
/** Utilisation window and the open hours per day it assumes (one shift). */
export const UTILISATION_WINDOW_DAYS = 7;
export const OPEN_HOURS_PER_DAY = 8;
/** Run events this recent mark an agent as working on an object. */
export const AGENT_MARKER_WINDOW_MS = 15 * 60_000;
/** Finished bookings stay in the shipment list this long. */
export const SHIPMENT_RECENT_MS = 24 * 3_600_000;
/** On-time delivery KPI window. */
export const ON_TIME_WINDOW_MS = 30 * 24 * 3_600_000;
/** Default dock slot (minutes) a booking holds from its ETA. */
export const DEFAULT_DOCK_SLOT_MINUTES = 60;

export const TWIN_ROTATIONS: readonly TwinRotation[] = [0, 90, 180, 270];
export const TWIN_MAX_GRID = 400;
export const TWIN_MIN_GRID = 4;
export const TWIN_MAX_HEIGHT = 50;

export const ACTIVE_BOOKING_STATUSES: readonly TwinDockBookingStatus[] = ["booked", "arrived", "loading", "unloading"];
export const ON_SITE_BOOKING_STATUSES: readonly TwinDockBookingStatus[] = ["arrived", "loading", "unloading"];

/** Dock booking status machine (any active → cancelled). */
export const BOOKING_TRANSITIONS: Readonly<Record<TwinDockBookingStatus, readonly TwinDockBookingStatus[]>> = {
  booked: ["arrived", "cancelled"],
  arrived: ["loading", "unloading", "cancelled"],
  loading: ["done", "cancelled"],
  unloading: ["done", "cancelled"],
  done: [],
  cancelled: [],
};

/** Site status: publishing is gated (a person approves); un-publishing is free. */
export const SITE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  draft: ["published"],
  published: ["draft"],
};

/** OpsLocation kinds each location-bindable object kind accepts. */
export const LOCATION_KINDS_FOR: Readonly<Partial<Record<TwinObjectKind, readonly string[]>>> = {
  dock_door: ["dock"],
  rack: ["rack", "aisle", "zone"],
  bin_zone: ["bin", "zone"],
  shelf: ["shelf"],
};

/** Objects that may overlap others: walkways, and equipment (it moves). */
export const OVERLAP_EXEMPT: readonly TwinObjectKind[] = ["path", "equipment"];

// ---------------------------------------------------------------------------
// Layout validation (create / patch of twin objects and sites)
// ---------------------------------------------------------------------------

export class TwinRuleError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TwinRuleError";
    this.status = status;
  }
}

export interface GridSize {
  gridW: number;
  gridD: number;
}

export function isTwinObjectKind(v: unknown): v is TwinObjectKind {
  return typeof v === "string" && (TWIN_OBJECT_KINDS as readonly string[]).includes(v);
}

/** null when the footprint fits the grid, else why not. Footprints are axis-aligned extents (w along x, d along z) whatever the rotation. */
export function footprintProblem(fp: TwinFootprint, grid: GridSize): string | null {
  for (const k of ["x", "z", "w", "d", "h"] as const) {
    if (!Number.isInteger(fp[k])) return `${k} must be a whole number of cells`;
  }
  if (!TWIN_ROTATIONS.includes(fp.rotation)) return "rotation must be 0, 90, 180 or 270";
  if (fp.w < 1 || fp.d < 1) return "w and d must be at least 1 cell";
  if (fp.h < 1 || fp.h > TWIN_MAX_HEIGHT) return `h must be between 1 and ${TWIN_MAX_HEIGHT}`;
  if (fp.x < 0 || fp.z < 0) return "the object starts outside the grid";
  if (fp.x + fp.w > grid.gridW || fp.z + fp.d > grid.gridD) {
    return `the object (${fp.x},${fp.z} ${fp.w}×${fp.d}) runs past the ${grid.gridW}×${grid.gridD} grid`;
  }
  return null;
}

export function gridProblem(grid: GridSize): string | null {
  for (const k of ["gridW", "gridD"] as const) {
    const v = grid[k];
    if (!Number.isInteger(v) || v < TWIN_MIN_GRID || v > TWIN_MAX_GRID) return `${k} must be a whole number between ${TWIN_MIN_GRID} and ${TWIN_MAX_GRID}`;
  }
  return null;
}

/** Strictly positive-area intersection of two footprints. */
export function footprintsOverlap(a: Pick<TwinFootprint, "x" | "z" | "w" | "d">, b: Pick<TwinFootprint, "x" | "z" | "w" | "d">): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.z < b.z + b.d && b.z < a.z + a.d;
}

export interface LayoutItem {
  id: string;
  kind: TwinObjectKind;
  label?: string;
  footprint: Pick<TwinFootprint, "x" | "z" | "w" | "d">;
}

/** The first other object the candidate would overlap (paths and equipment never block). */
export function overlapWith(candidate: LayoutItem, others: readonly LayoutItem[]): LayoutItem | null {
  if (OVERLAP_EXEMPT.includes(candidate.kind)) return null;
  for (const o of others) {
    if (o.id === candidate.id || OVERLAP_EXEMPT.includes(o.kind)) continue;
    if (footprintsOverlap(candidate.footprint, o.footprint)) return o;
  }
  return null;
}

/** Throws TwinRuleError when the binding type isn't allowed for the kind. */
export function assertBindable(kind: TwinObjectKind, type: TwinBindingType | null | undefined): void {
  if (!type) return;
  const allowed = TWIN_BINDABLE[kind];
  if (!allowed.includes(type)) {
    throw new TwinRuleError(
      422,
      allowed.length ? `A ${kind.replace("_", " ")} binds to ${allowed.join(" or ")}, not ${type.replace("_", " ")}` : `A ${kind.replace("_", " ")} can't be bound to a record`,
    );
  }
}

/** Throws when a location of `locationKind` can't back an object of `kind`. */
export function assertLocationKindFits(kind: TwinObjectKind, locationKind: string): void {
  const ok = LOCATION_KINDS_FOR[kind];
  if (ok && !ok.includes(locationKind)) {
    throw new TwinRuleError(422, `A ${kind.replace("_", " ")} binds to a location of kind ${ok.join(" / ")}, not ${locationKind}`);
  }
}

export function canMoveBooking(from: string, to: string): boolean {
  return (BOOKING_TRANSITIONS[from as TwinDockBookingStatus] ?? []).includes(to as TwinDockBookingStatus);
}

/** loading is for outbound trucks, unloading for inbound ones. */
export function assertBookingMove(from: string, to: string, direction: "inbound" | "outbound"): void {
  if (!canMoveBooking(from, to)) throw new TwinRuleError(409, `A dock booking cannot move from ${from} to ${to}`);
  if (to === "loading" && direction !== "outbound") throw new TwinRuleError(409, "Only an outbound truck is loaded — an inbound one is unloaded");
  if (to === "unloading" && direction !== "inbound") throw new TwinRuleError(409, "Only an inbound truck is unloaded — an outbound one is loaded");
}

export interface BookingWindow {
  id?: string;
  status: string;
  eta: Date;
  durationMinutes: number;
}

/** Same rule as the ops_dock_bookings_no_overlap exclusion constraint: [eta, eta + duration). */
export function bookingsOverlap(a: BookingWindow, b: BookingWindow): boolean {
  const a0 = a.eta.getTime();
  const b0 = b.eta.getTime();
  return a0 < b0 + b.durationMinutes * 60_000 && b0 < a0 + a.durationMinutes * 60_000;
}

/** The first active booking of the same dock the candidate would overlap. */
export function bookingClash(candidate: BookingWindow, sameDock: readonly BookingWindow[]): BookingWindow | null {
  for (const b of sameDock) {
    if (b.id && b.id === candidate.id) continue;
    if (!ACTIVE_BOOKING_STATUSES.includes(b.status as TwinDockBookingStatus)) continue;
    if (bookingsOverlap(candidate, b)) return b;
  }
  return null;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** Same short id the Ops tables show (components/ops/shared.tsx shortId). */
export function shortRef(prefix: string, id: string): string {
  return `${prefix}-${id.length > 12 ? id.slice(-8).toUpperCase() : id.toUpperCase()}`;
}

export function bookingRef(b: { purchaseOrderId?: string | null; orderId?: string | null; transferId?: string | null }): string | null {
  if (b.purchaseOrderId) return shortRef("PO", b.purchaseOrderId);
  if (b.orderId) return shortRef("SO", b.orderId);
  if (b.transferId) return shortRef("TR", b.transferId);
  return null;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

// ---------------------------------------------------------------------------
// Dock doors
// ---------------------------------------------------------------------------

export interface BookingRow {
  id: string;
  dockLocationId: string;
  direction: "inbound" | "outbound";
  carrier: string | null;
  truckRef: string | null;
  status: TwinDockBookingStatus;
  eta: Date;
  durationMinutes: number;
  arrivedAt: Date | null;
  startedAt: Date | null;
  doneAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  purchaseOrderId: string | null;
  orderId: string | null;
  transferId: string | null;
  // What it serves (for shipment steps).
  purchaseOrder?: { status: string; sentAt: Date | null; receivedAt: Date | null } | null;
  order?: { status: string; paidAt: Date | null; createdAt: Date } | null;
  transfer?: { status: string; doneAt: Date | null; createdAt: Date } | null;
}

export function bookingSummary(b: BookingRow): TwinDockBookingSummary {
  return {
    id: b.id,
    direction: b.direction,
    carrier: b.carrier,
    truckRef: b.truckRef,
    status: b.status,
    eta: iso(b.eta),
    arrivedAt: iso(b.arrivedAt),
    ref: bookingRef(b),
  };
}

/** Why a booking is overdue right now (null when it isn't). */
export function bookingOverdue(b: Pick<BookingRow, "status" | "eta" | "arrivedAt" | "startedAt">, now: Date): string | null {
  const t = now.getTime();
  if (b.status === "booked" && t - b.eta.getTime() > DOCK_ETA_GRACE_MS) {
    return `${Math.round((t - b.eta.getTime()) / 60_000)} min past its ETA`;
  }
  if (ON_SITE_BOOKING_STATUSES.includes(b.status)) {
    const since = (b.arrivedAt ?? b.startedAt ?? b.eta).getTime();
    if (t - since > DOCK_ON_SITE_MAX_MS) return `on site for ${Math.floor((t - since) / 3_600_000)} h`;
  }
  return null;
}

export interface DerivedDock {
  state: Extract<TwinObjectState, { kind: "dock_door" }>;
  pill: string;
  alert: TwinObject["alert"];
}

const CAP = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A dock door from its bookings: the truck on it, else the next booked one. */
export function deriveDock(bookings: readonly BookingRow[], now: Date): DerivedDock {
  const onSite = bookings
    .filter((b) => ON_SITE_BOOKING_STATUSES.includes(b.status))
    .sort((a, b) => (a.arrivedAt ?? a.eta).getTime() - (b.arrivedAt ?? b.eta).getTime());
  const booked = bookings.filter((b) => b.status === "booked").sort((a, b) => a.eta.getTime() - b.eta.getTime());
  const current = onSite[0] ?? booked[0] ?? null;
  const upcoming = booked.filter((b) => b !== current).length;
  if (!current) return { state: { kind: "dock_door", status: "free", booking: null, upcoming: 0 }, pill: "Free", alert: null };
  const overdue = bookingOverdue(current, now);
  const status = overdue ? "overdue" : onSite.length ? "occupied" : "booked";
  const who = current.truckRef ?? current.carrier ?? "Truck";
  const ref = bookingRef(current);
  return {
    state: { kind: "dock_door", status, booking: bookingSummary(current), upcoming },
    pill: overdue ? "Overdue" : CAP(current.status),
    alert: overdue ? { key: "dock_overdue", message: `${who}${ref ? ` (${ref})` : ""} is ${overdue}` } : null,
  };
}

// ---------------------------------------------------------------------------
// Racks, bin zones, shelves (stock from the ledger via stockByLocation)
// ---------------------------------------------------------------------------

export interface LocationNode {
  id: string;
  parentId: string | null;
  kind: string;
  code: string;
  path: string;
}

/** The location and every location under it. */
export function locationSubtree(rootId: string, locations: readonly LocationNode[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const l of locations) {
    if (!l.parentId) continue;
    const arr = children.get(l.parentId) ?? [];
    arr.push(l.id);
    children.set(l.parentId, arr);
  }
  const out = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const c of children.get(id) ?? []) {
      if (!out.has(c)) {
        out.add(c);
        queue.push(c);
      }
    }
  }
  return out;
}

export interface StockQty {
  productId: string;
  locationId: string | null;
  qty: number;
}

export interface LowStockInput {
  /** Product → its low-stock threshold: the active reorder rule's min for this warehouse, else lowStockThreshold. Only stock-tracked products. */
  thresholds: ReadonlyMap<string, number>;
  /** Reorder rules' receiving locations (a product is watched there even when it ran out). */
  ruleLocations: ReadonlyArray<{ productId: string; locationId: string | null }>;
}

/** Products whose warehouse on-hand is at or under their threshold (same test as the reorder sweep: on-hand ≤ min). */
export function lowProducts(rows: readonly StockQty[], low: LowStockInput): Set<string> {
  const total = new Map<string, number>();
  for (const r of rows) total.set(r.productId, (total.get(r.productId) ?? 0) + r.qty);
  const out = new Set<string>();
  for (const [productId, threshold] of low.thresholds) {
    if ((total.get(productId) ?? 0) <= threshold) out.add(productId);
  }
  return out;
}

export interface DerivedStock {
  state: Extract<TwinObjectState, { kind: "rack" | "bin_zone" | "shelf" }>;
  pill: string;
  alert: TwinObject["alert"];
}

/**
 * Stock of a location subtree: units on hand, distinct SKUs, and how many
 * products held (or reorder-received) there are low across the warehouse.
 */
export function deriveStock(
  kind: "rack" | "bin_zone" | "shelf",
  subtree: ReadonlySet<string>,
  rows: readonly StockQty[],
  low: ReadonlySet<string>,
  ruleLocations: LowStockInput["ruleLocations"],
): DerivedStock {
  const perProduct = new Map<string, number>();
  for (const r of rows) {
    if (!r.locationId || !subtree.has(r.locationId)) continue;
    perProduct.set(r.productId, (perProduct.get(r.productId) ?? 0) + r.qty);
  }
  const held = [...perProduct.entries()].filter(([, q]) => q > 0);
  const watched = new Set(held.map(([p]) => p));
  for (const r of ruleLocations) if (r.locationId && subtree.has(r.locationId)) watched.add(r.productId);
  const lowStockCount = [...watched].filter((p) => low.has(p)).length;
  const onHand = held.reduce((s, [, q]) => s + q, 0);
  return finishStock(kind, onHand, held.length, lowStockCount);
}

/** A store shelf bound to ONE product: that product's on-hand in the site's warehouse. */
export function deriveProductShelf(productId: string, rows: readonly StockQty[], low: ReadonlySet<string>): DerivedStock {
  const onHand = rows.filter((r) => r.productId === productId).reduce((s, r) => s + r.qty, 0);
  return finishStock("shelf", Math.max(0, onHand), onHand > 0 ? 1 : 0, low.has(productId) ? 1 : 0);
}

function finishStock(kind: "rack" | "bin_zone" | "shelf", onHand: number, skuCount: number, lowStockCount: number): DerivedStock {
  return {
    state: { kind, onHand, skuCount, lowStockCount },
    pill: onHand === 0 ? "Empty" : `${onHand} on hand`,
    alert: lowStockCount > 0 ? { key: "bin_low", message: `${lowStockCount} product${lowStockCount === 1 ? "" : "s"} at or below the reorder point` } : null,
  };
}

// ---------------------------------------------------------------------------
// Work centres
// ---------------------------------------------------------------------------

export interface WorkOrderRow {
  id: string;
  workCenterId: string;
  name: string;
  sequence: number;
  status: "pending" | "in_progress" | "paused" | "done" | "cancelled";
  runningSince: Date | null;
  mo: { id: string; number: string | null; status: string; plannedStart: Date | null };
  /** False when an earlier step of the same MO is still open (this one waits upstream). Default true. */
  ready?: boolean;
}

export interface TimeLogRow {
  workCenterId: string;
  startedAt: Date;
  endedAt: Date;
  seconds: number;
}

/** Logged minutes ÷ (capacity × open minutes) over the window, 0–100. Running timers count up to now. */
export function utilisationPct(
  capacity: number,
  logs: readonly Pick<TimeLogRow, "startedAt" | "endedAt" | "seconds">[],
  running: readonly Date[],
  now: Date,
): number {
  const windowStart = now.getTime() - UTILISATION_WINDOW_DAYS * 86_400_000;
  let seconds = 0;
  for (const l of logs) {
    const end = l.endedAt.getTime();
    if (end <= windowStart) continue;
    const start = l.startedAt.getTime();
    // A segment straddling the window start counts only its in-window part.
    seconds += start >= windowStart ? l.seconds : Math.min(l.seconds, (end - windowStart) / 1000);
  }
  for (const since of running) seconds += Math.max(0, (now.getTime() - Math.max(since.getTime(), windowStart)) / 1000);
  const openMinutes = Math.max(1, capacity) * UTILISATION_WINDOW_DAYS * OPEN_HOURS_PER_DAY * 60;
  return Math.max(0, Math.min(100, Math.round((seconds / 60 / openMinutes) * 100)));
}

const OPEN_MO = new Set(["confirmed", "in_progress"]);

export interface DerivedWorkCenter {
  state: Extract<TwinObjectState, { kind: "work_center" }>;
  pill: string;
  alert: TwinObject["alert"];
}

/**
 * running = a work order's timer runs here; paused = one is paused; stopped
 * = work is ready here (the next open step of a confirmed / in-progress MO)
 * but nothing runs; idle = no work ready (steps waiting upstream don't
 * count). late = the shown work order's MO is past its planned start
 * and not done.
 */
export function deriveWorkCenter(
  workOrders: readonly WorkOrderRow[],
  capacity: number,
  logs: readonly TimeLogRow[],
  now: Date,
): DerivedWorkCenter {
  const open = workOrders.filter((w) => w.status === "in_progress" || w.status === "paused" || (w.status === "pending" && OPEN_MO.has(w.mo.status) && w.ready !== false));
  const by = (s: WorkOrderRow["status"]) => open.filter((w) => w.status === s);
  const running = by("in_progress").sort((a, b) => (b.runningSince?.getTime() ?? 0) - (a.runningSince?.getTime() ?? 0));
  const paused = by("paused");
  const pending = by("pending").sort((a, b) => (a.mo.status === "in_progress" ? 0 : 1) - (b.mo.status === "in_progress" ? 0 : 1) || a.sequence - b.sequence);
  const shown = running[0] ?? paused[0] ?? pending[0] ?? null;
  const status = running.length ? "running" : paused.length ? "paused" : pending.length ? "stopped" : "idle";
  const late = Boolean(shown && shown.mo.plannedStart && shown.mo.plannedStart.getTime() < now.getTime() && shown.mo.status !== "done");
  const utilisation = utilisationPct(capacity, logs, running.map((w) => w.runningSince).filter((d): d is Date => d instanceof Date), now);
  const pill = CAP(status) + (late ? " · late" : "");
  return {
    state: {
      kind: "work_center",
      status,
      workOrder: shown
        ? { id: shown.id, moId: shown.mo.id, moNumber: shown.mo.number, name: shown.name, runningSince: shown.status === "in_progress" ? iso(shown.runningSince) : null }
        : null,
      utilisationPct: utilisation,
      late,
    },
    pill,
    alert:
      late && (status === "paused" || status === "stopped")
        ? { key: "machine_stopped_late", message: `${CAP(status)} while ${shown!.mo.number ?? "its manufacturing order"} is past its planned start` }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Registers
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  number: string | null;
  status: "open" | "closing" | "closed";
  openedAt: Date;
}

export interface DerivedRegister {
  state: Extract<TwinObjectState, { kind: "register" }>;
  pill: string;
  alert: TwinObject["alert"];
}

/** A register from its open (or closing) till session; sales = that session's order totals. */
export function deriveRegister(session: SessionRow | null, salesCents: number, now: Date): DerivedRegister {
  if (!session || session.status === "closed") {
    return { state: { kind: "register", status: "closed", sessionId: null, sessionNumber: null, salesCents: 0, openedAt: null }, pill: "Closed", alert: null };
  }
  const openFor = now.getTime() - session.openedAt.getTime();
  return {
    state: { kind: "register", status: session.status, sessionId: session.id, sessionNumber: session.number, salesCents, openedAt: iso(session.openedAt) },
    pill: CAP(session.status),
    alert:
      openFor > REGISTER_LEFT_OPEN_MS
        ? { key: "register_left_open", message: `${session.number ?? "The till session"} has been ${session.status} for ${Math.floor(openFor / 3_600_000)} h` }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Equipment (stored state — the one exception)
// ---------------------------------------------------------------------------

export interface EquipmentRow {
  x: number;
  z: number;
  w: number;
  d: number;
  equipmentStatus: "available" | "busy" | "charging" | null;
  taskLocationId: string | null;
  taskNote: string | null;
  taskAssignedAt: Date | null;
  homeX: number | null;
  homeZ: number | null;
}

/** Where to draw equipment: the centre of the object bound to its task location, else its home cell (always an estimate — no telemetry). */
export function deriveEquipment(
  row: EquipmentRow,
  taskTarget: { label: string | null; centre: { x: number; z: number } | null } | null,
): { state: Extract<TwinObjectState, { kind: "equipment" }>; pill: string } {
  const status = row.equipmentStatus ?? "available";
  const busy = status === "busy";
  const home = { x: (row.homeX ?? row.x) + row.w / 2, z: (row.homeZ ?? row.z) + row.d / 2 };
  const position = busy && taskTarget?.centre ? taskTarget.centre : home;
  return {
    state: {
      kind: "equipment",
      status,
      task: busy ? { note: row.taskNote, locationId: row.taskLocationId, label: taskTarget?.label ?? null, assignedAt: iso(row.taskAssignedAt) } : null,
      position,
      positionIsEstimated: true,
    },
    pill: CAP(status),
  };
}

export function footprintCentre(fp: Pick<TwinFootprint, "x" | "z" | "w" | "d">): { x: number; z: number } {
  return { x: fp.x + fp.w / 2, z: fp.z + fp.d / 2 };
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

export interface KpiInput {
  kind: TwinSiteKind;
  stockRows: readonly StockQty[];
  bookings: readonly BookingRow[];
  workCenters: ReadonlyArray<{ status: string; utilisationPct: number }>;
  registers: ReadonlyArray<{ status: string }>;
  salesToday: { cents: number; count: number };
  now: Date;
}

/** On-time = arrived within the ETA grace; over bookings finished in the last 30 days. */
export function onTimeDelivery(bookings: readonly BookingRow[], now: Date): { pct: number; total: number; onTime: number } {
  const since = now.getTime() - ON_TIME_WINDOW_MS;
  const done = bookings.filter((b) => b.status === "done" && b.doneAt && b.doneAt.getTime() >= since);
  const onTime = done.filter((b) => b.arrivedAt && b.arrivedAt.getTime() <= b.eta.getTime() + DOCK_ETA_GRACE_MS).length;
  return { pct: done.length ? Math.round((onTime / done.length) * 100) : 0, total: done.length, onTime };
}

export function deriveKpis(input: KpiInput): TwinKpi[] {
  const held = input.stockRows.filter((r) => r.qty > 0);
  const onHand = held.reduce((s, r) => s + r.qty, 0);
  const skus = new Set(held.map((r) => r.productId)).size;
  const onSite = input.bookings.filter((b) => ON_SITE_BOOKING_STATUSES.includes(b.status));
  const docksBusy = new Set(onSite.map((b) => b.dockLocationId)).size;
  const otd = onTimeDelivery(input.bookings, input.now);
  const kpis: TwinKpi[] = [
    { key: "stock_on_hand", label: "Stock on hand", value: onHand, unit: "count", hint: `${skus} SKU${skus === 1 ? "" : "s"}` },
    { key: "trucks_on_site", label: "Trucks on site", value: onSite.length, unit: "count", hint: `${docksBusy} dock${docksBusy === 1 ? "" : "s"} busy` },
    {
      key: "on_time_delivery_30d",
      label: "On-time delivery",
      // No finished deliveries → no rate (a 0% here would read as "all late").
      value: otd.total ? otd.pct : null,
      unit: "pct",
      hint: otd.total ? `${otd.onTime} of ${otd.total} deliveries, 30 days` : "No deliveries in 30 days",
    },
  ];
  if (input.kind === "factory") {
    const wcs = input.workCenters;
    const avg = wcs.length ? Math.round(wcs.reduce((s, w) => s + w.utilisationPct, 0) / wcs.length) : null;
    const running = wcs.filter((w) => w.status === "running").length;
    kpis.push({ key: "work_center_utilisation", label: "Work centre utilisation", value: avg, unit: "pct", hint: `${running} of ${wcs.length} running · 7 days` });
  }
  if (input.kind === "store") {
    const open = input.registers.filter((r) => r.status !== "closed").length;
    kpis.push({ key: "open_registers", label: "Open registers", value: open, unit: "count", hint: `of ${input.registers.length}` });
    kpis.push({ key: "sales_today", label: "Sales today", value: input.salesToday.cents, unit: "cents", hint: `${input.salesToday.count} sale${input.salesToday.count === 1 ? "" : "s"}` });
  }
  return kpis;
}

// ---------------------------------------------------------------------------
// Shipments (the stepper) — one per active or recently finished booking
// ---------------------------------------------------------------------------

type Step = TwinShipment["steps"][number];
const step = (key: TwinShipmentStepKey, label: string, done: boolean, at: Date | null | undefined): Step => ({ key, label, done, at: done ? iso(at ?? null) : null });

/** Steps from the served record + the booking's own timestamps. Nothing is guessed: "delivered" needs a record we don't have yet, so it stays open. */
export function shipmentSteps(b: BookingRow): Step[] {
  const doneBooking = b.status === "done";
  if (b.direction === "outbound") {
    // A stock move or an unreferenced booking is confirmed by being booked.
    const confirmed = b.order ? b.order.status === "confirmed" || b.order.status === "fulfilled" : true;
    const confirmedAt = b.order ? b.order.paidAt ?? b.order.createdAt : b.transfer ? b.transfer.createdAt : b.createdAt;
    const picked = b.order?.status === "fulfilled" || b.transfer?.status === "done" || b.status === "loading" || doneBooking;
    const pickedAt = b.transfer?.doneAt ?? b.startedAt ?? b.doneAt;
    return [
      step("confirmed", "Order confirmed", confirmed, confirmedAt),
      step("picked", "Picked", picked, pickedAt),
      step("loaded", "Loaded", doneBooking, b.doneAt),
      step("in_transit", "In transit", doneBooking, b.doneAt),
      step("delivered", "Delivered", false, null),
    ];
  }
  const po = b.purchaseOrder;
  const confirmed = po ? ["sent", "partially_received", "received"].includes(po.status) : true;
  const received = doneBooking || po?.status === "received";
  return [
    step("confirmed", po ? "Order sent" : "Expected", confirmed, po?.sentAt ?? b.createdAt),
    step("booked", "Dock booked", true, b.createdAt),
    step("arrived", "Arrived", Boolean(b.arrivedAt) || ON_SITE_BOOKING_STATUSES.includes(b.status) || doneBooking, b.arrivedAt),
    step("unloading", "Unloading", b.status === "unloading" || doneBooking, b.startedAt),
    step("received", "Received", received, po?.receivedAt ?? b.doneAt),
  ];
}

export function deriveShipments(bookings: readonly BookingRow[], dockObjectOf: (dockLocationId: string) => string | null, now: Date): TwinShipment[] {
  const since = now.getTime() - SHIPMENT_RECENT_MS;
  return bookings
    .filter((b) => ACTIVE_BOOKING_STATUSES.includes(b.status) || (b.status === "done" && b.doneAt && b.doneAt.getTime() >= since))
    .sort((a, b) => a.eta.getTime() - b.eta.getTime() || a.id.localeCompare(b.id))
    .map((b) => {
      const steps = shipmentSteps(b);
      const firstOpen = steps.findIndex((s) => !s.done);
      return {
        id: b.id,
        direction: b.direction,
        ref: bookingRef(b),
        carrier: b.carrier,
        truckRef: b.truckRef,
        dockObjectId: dockObjectOf(b.dockLocationId),
        steps,
        currentStep: firstOpen === -1 ? steps.length - 1 : firstOpen,
        eta: iso(b.eta),
        late: ACTIVE_BOOKING_STATUSES.includes(b.status) && bookingOverdue(b, now) !== null,
      };
    });
}

// ---------------------------------------------------------------------------
// Agent markers
// ---------------------------------------------------------------------------

export interface AgentRunActivity {
  runId: string;
  agentKey: string | null;
  /** AgentRun.status */
  status: string;
  /** The run is waiting on a person (its latest event asked for an OK). */
  waiting: boolean;
  /** Text of its recent run events (summaries + payloads). */
  haystack: string;
}

/** An object is "worked on" when a recent run event mentions its id or its bound record's id. */
export function agentMarkers(
  runs: readonly AgentRunActivity[],
  objects: ReadonlyArray<{ id: string; binding: { id: string } | null }>,
): TwinAgentMarker[] {
  const out: TwinAgentMarker[] = [];
  for (const run of runs) {
    const status: AosStatus | null = run.waiting ? "needs" : fromAgentRunStatus(run.status);
    if (!status || status === "done" || status === "failed") continue;
    for (const o of objects) {
      const keys = [o.id, o.binding?.id].filter((k): k is string => Boolean(k && k.length >= 6));
      if (!keys.some((k) => run.haystack.includes(k))) continue;
      const who = run.agentKey && run.agentKey !== "lead" ? `${CAP(run.agentKey)} agent` : "Lead agent";
      out.push({ objectId: o.id, runId: run.runId, agentKey: run.agentKey, status, label: `${who}: ${statusLabel(status).toLowerCase()}` });
    }
  }
  return out.sort((a, b) => a.objectId.localeCompare(b.objectId) || a.runId.localeCompare(b.runId));
}

// ---------------------------------------------------------------------------
// siteDiff — a small exact differ (RFC 6902 replace ops)
// ---------------------------------------------------------------------------

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * Ops turning `prev` into `next`: per-object `replace /objects/<i>` while the
 * object set (ids, same order) is unchanged, else one `replace /objects`;
 * `replace` for site / kpis / shipments / agents when they changed. Empty
 * when nothing but generatedAt moved (generatedAt rides along with real
 * changes only, so an idle stream sends nothing).
 */
export function diffSnapshots(prev: TwinSnapshot, next: TwinSnapshot): TwinPatchOp[] {
  const ops: TwinPatchOp[] = [];
  if (!deepEqual(prev.site, next.site)) ops.push({ op: "replace", path: "/site", value: next.site });
  const sameSet = prev.objects.length === next.objects.length && prev.objects.every((o, i) => o.id === next.objects[i]!.id);
  if (!sameSet) ops.push({ op: "replace", path: "/objects", value: next.objects });
  else next.objects.forEach((o, i) => {
    if (!deepEqual(prev.objects[i], o)) ops.push({ op: "replace", path: `/objects/${i}`, value: o });
  });
  for (const k of ["kpis", "shipments", "agents"] as const) {
    if (!deepEqual(prev[k], next[k])) ops.push({ op: "replace", path: `/${k}`, value: next[k] });
  }
  if (ops.length && prev.generatedAt !== next.generatedAt) ops.push({ op: "replace", path: "/generatedAt", value: next.generatedAt });
  return ops;
}

/** Apply diffSnapshots' ops (replace / add / remove on top-level keys and /objects/<i>). Returns a new snapshot. */
export function applyTwinPatch(snap: TwinSnapshot, ops: readonly TwinPatchOp[]): TwinSnapshot {
  const out: TwinSnapshot = { ...snap, objects: [...snap.objects] };
  for (const op of ops) {
    const parts = op.path.split("/").slice(1);
    if (parts.length === 1) {
      const key = parts[0] as keyof TwinSnapshot;
      if (op.op === "remove") delete (out as unknown as Record<string, unknown>)[key];
      else (out as unknown as Record<string, unknown>)[key] = op.value;
    } else if (parts.length === 2 && parts[0] === "objects") {
      const i = Number(parts[1]);
      if (op.op === "remove") out.objects.splice(i, 1);
      else if (op.op === "add") out.objects.splice(i, 0, op.value as TwinObject);
      else out.objects[i] = op.value as TwinObject;
    } else {
      throw new Error(`applyTwinPatch: unsupported path ${op.path}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Alerts — the same conditions the snapshot shows on each object
// ---------------------------------------------------------------------------

export const TWIN_ALERT_TRIGGERS: Readonly<Record<TwinAlertKey, string>> = {
  dock_overdue: "twin.dock_overdue",
  bin_low: "twin.bin_low",
  machine_stopped_late: "twin.machine_stopped_late",
  register_left_open: "twin.register_left_open",
};

export interface TwinAlertCandidate {
  trigger: string;
  key: TwinAlertKey;
  objectId: string;
  label: string;
  message: string;
  /** One alert per condition: re-raised only when the underlying record changes. */
  dedupKey: string;
}

/** Alerts raised by a snapshot. The dedup key names the record that is late/low/open, so a condition alerts once. */
export function alertCandidates(snap: TwinSnapshot): TwinAlertCandidate[] {
  const out: TwinAlertCandidate[] = [];
  for (const o of snap.objects) {
    if (!o.alert) continue;
    const st = o.state;
    let subject = o.binding?.id ?? o.id;
    if (st.kind === "dock_door" && st.booking) subject = `${st.booking.id}:${st.booking.status}`;
    if (st.kind === "work_center" && st.workOrder) subject = `${st.workOrder.id}`;
    if (st.kind === "register" && st.sessionId) subject = st.sessionId;
    if (st.kind === "rack" || st.kind === "bin_zone" || st.kind === "shelf") subject = `${o.binding?.id ?? o.id}:${st.lowStockCount}`;
    out.push({
      trigger: TWIN_ALERT_TRIGGERS[o.alert.key],
      key: o.alert.key,
      objectId: o.id,
      label: o.label,
      message: o.alert.message,
      dedupKey: `${TWIN_ALERT_TRIGGERS[o.alert.key]}:${snap.site.id}:${o.id}:${subject}`,
    });
  }
  return out;
}
