// ShapesOS — Phase 13 (twinui): pure derivations from a TwinSnapshot for the
// twin overlays — the tabbed tables, the shipment stepper's pick, search,
// the inspector's facts, KPI formatting and record links. No React, no DOM,
// no prisma: unit-tested in lib/twin/__tests__/twin-ui.test.ts.

import type {
  TwinAgentMarker,
  TwinBindingType,
  TwinKpi,
  TwinObject,
  TwinObjectKind,
  TwinShipment,
  TwinSiteKind,
  TwinSnapshot,
} from "./types";

// ---------------------------------------------------------------------------
// Labels and formatting
// ---------------------------------------------------------------------------

export const KIND_LABEL: Readonly<Record<TwinObjectKind, string>> = {
  building: "Building",
  dock_door: "Dock door",
  rack: "Rack",
  bin_zone: "Bin zone",
  yard_slot: "Yard slot",
  work_center: "Work centre",
  register: "Register",
  shelf: "Shelf",
  path: "Path",
  equipment: "Equipment",
};

export const SITE_KIND_LABEL: Readonly<Record<TwinSiteKind, string>> = {
  warehouse: "Warehouse",
  factory: "Factory",
  store: "Store",
};

/** "in_transit" → "In transit". */
export function sentenceCase(s: string): string {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const num = new Intl.NumberFormat("en-US");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatCount(n: number): string {
  return num.format(Math.round(n));
}

export function formatCents(c: number): string {
  return money.format(c / 100);
}

export function formatKpiValue(k: Pick<TwinKpi, "value" | "unit">): string {
  if (k.unit === "pct") return `${Math.round(k.value)}%`;
  if (k.unit === "cents") return formatCents(k.value);
  return formatCount(k.value);
}

/** "09:30" in the viewer's locale (24 h); "—" for null/invalid. */
export function formatTime(isoStr: string | null | undefined, locale = "en-GB"): string {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/** "Oct 4, 09:30". */
export function formatDateTime(isoStr: string | null | undefined): string {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${formatTime(isoStr)}`;
}

// ---------------------------------------------------------------------------
// Record links (the bound record's ops page)
// ---------------------------------------------------------------------------

export function recordHref(binding: { type: TwinBindingType; id: string } | null): string | null {
  if (!binding) return null;
  switch (binding.type) {
    case "location":
      return "/dashboard/ops/inventory?view=stock";
    case "product":
      return "/dashboard/ops/inventory?view=products";
    case "work_center":
      return "/dashboard/ops/manufacturing?view=work-centres";
    case "register":
      return "/dashboard/ops/pos";
  }
}

export const BINDING_LABEL: Readonly<Record<TwinBindingType, string>> = {
  location: "Location",
  product: "Product",
  work_center: "Work centre",
  register: "Register",
};

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Agent markers grouped by object id (several agents may work on one object). */
export function agentsByObject(s: Pick<TwinSnapshot, "agents">): Map<string, TwinAgentMarker[]> {
  const out = new Map<string, TwinAgentMarker[]>();
  for (const a of s.agents) {
    const list = out.get(a.objectId);
    if (list) list.push(a);
    else out.set(a.objectId, [a]);
  }
  return out;
}

/** Object kinds present in the snapshot (each kind's scene code loads only when used). */
export function kindsPresent(s: Pick<TwinSnapshot, "objects">): Set<TwinObjectKind> {
  return new Set(s.objects.map((o) => o.kind));
}

// ---------------------------------------------------------------------------
// Tabbed tables
// ---------------------------------------------------------------------------

export type TwinTabKey = "docks" | "equipment" | "trucks" | "work_centres" | "orders" | "registers" | "shelves";

export const TWIN_TABS: Readonly<Record<TwinSiteKind, readonly { key: TwinTabKey; label: string }[]>> = {
  warehouse: [
    { key: "docks", label: "Docks" },
    { key: "equipment", label: "Equipment" },
    { key: "trucks", label: "Trucks" },
  ],
  factory: [
    { key: "work_centres", label: "Work centres" },
    { key: "orders", label: "Orders" },
    { key: "equipment", label: "Equipment" },
  ],
  store: [
    { key: "registers", label: "Registers" },
    { key: "shelves", label: "Shelves" },
  ],
};

export interface TwinTableColumn {
  key: string;
  label: string;
  align?: "right";
  /** render the cell as a neutral pill */
  pill?: boolean;
  mono?: boolean;
}

export interface TwinTableRow {
  /** the row's own key */
  key: string;
  /** the object a click selects (null = nothing to select) */
  objectId: string | null;
  cells: Record<string, string>;
}

export interface TwinTable {
  columns: TwinTableColumn[];
  rows: TwinTableRow[];
  empty: string;
}

const dash = (v: string | null | undefined) => (v && v.trim() ? v : "—");

function ofKind<K extends TwinObject["state"]["kind"]>(s: TwinSnapshot, kinds: readonly K[]) {
  return s.objects.filter((o) => (kinds as readonly string[]).includes(o.state.kind)) as (TwinObject & {
    state: Extract<TwinObject["state"], { kind: K }>;
  })[];
}

export function twinTable(s: TwinSnapshot, tab: TwinTabKey): TwinTable {
  switch (tab) {
    case "docks": {
      const rows = ofKind(s, ["dock_door"] as const).map((o) => ({
        key: o.id,
        objectId: o.id,
        cells: {
          dock: o.label,
          state: o.pill ?? sentenceCase(o.state.status),
          truck: dash(o.state.booking?.truckRef),
          carrier: dash(o.state.booking?.carrier),
          eta: o.state.booking ? formatTime(o.state.booking.eta) : "—",
          ref: dash(o.state.booking?.ref),
          upcoming: String(o.state.upcoming),
        },
      }));
      return {
        columns: [
          { key: "dock", label: "Dock" },
          { key: "state", label: "State", pill: true },
          { key: "truck", label: "Truck", mono: true },
          { key: "carrier", label: "Carrier" },
          { key: "eta", label: "ETA", align: "right" },
          { key: "ref", label: "For", mono: true },
          { key: "upcoming", label: "Next", align: "right" },
        ],
        rows,
        empty: "No dock doors on this site yet.",
      };
    }
    case "equipment": {
      const rows = ofKind(s, ["equipment"] as const).map((o) => ({
        key: o.id,
        objectId: o.id,
        cells: {
          name: o.label,
          state: o.pill ?? sentenceCase(o.state.status),
          task: dash(o.state.task?.note ?? o.state.task?.label),
          at: dash(o.state.task?.label),
          position: "Estimated",
        },
      }));
      return {
        columns: [
          { key: "name", label: "Equipment" },
          { key: "state", label: "State", pill: true },
          { key: "task", label: "Task" },
          { key: "at", label: "At" },
          { key: "position", label: "Position" },
        ],
        rows,
        empty: "No equipment on this site yet.",
      };
    }
    case "trucks": {
      const rows = s.shipments.map((sh) => {
        const dock = sh.dockObjectId ? s.objects.find((o) => o.id === sh.dockObjectId) : undefined;
        const step = sh.steps[sh.currentStep];
        return {
          key: sh.id,
          objectId: sh.dockObjectId,
          cells: {
            truck: dash(sh.truckRef),
            carrier: dash(sh.carrier),
            direction: sh.direction === "inbound" ? "Inbound" : "Outbound",
            dock: dash(dock?.label),
            step: sh.late ? "Late" : dash(step?.label),
            eta: formatTime(sh.eta),
            ref: dash(sh.ref),
          },
        };
      });
      return {
        columns: [
          { key: "truck", label: "Truck", mono: true },
          { key: "carrier", label: "Carrier" },
          { key: "direction", label: "Direction" },
          { key: "dock", label: "Dock" },
          { key: "step", label: "Step", pill: true },
          { key: "eta", label: "ETA", align: "right" },
          { key: "ref", label: "For", mono: true },
        ],
        rows,
        empty: "No trucks booked.",
      };
    }
    case "work_centres": {
      const rows = ofKind(s, ["work_center"] as const).map((o) => ({
        key: o.id,
        objectId: o.id,
        cells: {
          name: o.label,
          state: o.pill ?? sentenceCase(o.state.status),
          order: dash(o.state.workOrder ? `${o.state.workOrder.moNumber ?? "MO"} · ${o.state.workOrder.name}` : null),
          utilisation: `${Math.round(o.state.utilisationPct)}%`,
          late: o.state.late ? "Late" : "On time",
        },
      }));
      return {
        columns: [
          { key: "name", label: "Work centre" },
          { key: "state", label: "State", pill: true },
          { key: "order", label: "Work order" },
          { key: "utilisation", label: "Utilisation", align: "right" },
          { key: "late", label: "Schedule" },
        ],
        rows,
        empty: "No work centres on this site yet.",
      };
    }
    case "orders": {
      const rows = ofKind(s, ["work_center"] as const)
        .filter((o) => o.state.workOrder)
        .map((o) => {
          const wo = o.state.workOrder!;
          return {
            key: wo.id,
            objectId: o.id,
            cells: {
              mo: dash(wo.moNumber),
              op: wo.name,
              centre: o.label,
              state: sentenceCase(o.state.status === "running" ? "in progress" : o.state.status),
              since: wo.runningSince ? formatTime(wo.runningSince) : "—",
              late: o.state.late ? "Late" : "On time",
            },
          };
        });
      return {
        columns: [
          { key: "mo", label: "Order", mono: true },
          { key: "op", label: "Operation" },
          { key: "centre", label: "Work centre" },
          { key: "state", label: "State", pill: true },
          { key: "since", label: "Running since", align: "right" },
          { key: "late", label: "Schedule" },
        ],
        rows,
        empty: "No open work orders at this site.",
      };
    }
    case "registers": {
      const rows = ofKind(s, ["register"] as const).map((o) => ({
        key: o.id,
        objectId: o.id,
        cells: {
          name: o.label,
          state: o.pill ?? sentenceCase(o.state.status),
          session: dash(o.state.sessionNumber),
          sales: o.state.sessionId ? formatCents(o.state.salesCents) : "—",
          opened: formatDateTime(o.state.openedAt),
        },
      }));
      return {
        columns: [
          { key: "name", label: "Register" },
          { key: "state", label: "State", pill: true },
          { key: "session", label: "Session", mono: true },
          { key: "sales", label: "Sales", align: "right" },
          { key: "opened", label: "Opened" },
        ],
        rows,
        empty: "No registers on this site yet.",
      };
    }
    case "shelves": {
      const rows = ofKind(s, ["shelf", "rack", "bin_zone"] as const).map((o) => ({
        key: o.id,
        objectId: o.id,
        cells: {
          name: o.label,
          kind: KIND_LABEL[o.kind],
          onHand: formatCount(o.state.onHand),
          skus: formatCount(o.state.skuCount),
          low: o.state.lowStockCount ? `${o.state.lowStockCount} low` : "—",
          bound: o.bindingBroken ? "Unbound" : dash(o.binding?.label),
        },
      }));
      return {
        columns: [
          { key: "name", label: "Shelf" },
          { key: "kind", label: "Kind" },
          { key: "onHand", label: "On hand", align: "right" },
          { key: "skus", label: "SKUs", align: "right" },
          { key: "low", label: "Low stock", pill: true },
          { key: "bound", label: "Bound to", mono: true },
        ],
        rows,
        empty: "No shelves on this site yet.",
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Shipment stepper: the selected dock's shipment, else the most urgent one
// ---------------------------------------------------------------------------

function isFinished(sh: TwinShipment): boolean {
  return sh.steps.length > 0 && sh.steps[sh.steps.length - 1]!.done;
}

/** Most urgent first: late, then on site (past the first steps), then soonest ETA. */
export function shipmentUrgency(a: TwinShipment, b: TwinShipment): number {
  if (a.late !== b.late) return a.late ? -1 : 1;
  const ea = a.eta ? Date.parse(a.eta) : Number.POSITIVE_INFINITY;
  const eb = b.eta ? Date.parse(b.eta) : Number.POSITIVE_INFINITY;
  if (ea !== eb) return ea - eb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function pickShipment(s: Pick<TwinSnapshot, "shipments" | "objects">, selectedObjectId: string | null): TwinShipment | null {
  if (selectedObjectId) {
    const own = s.shipments.find((sh) => sh.dockObjectId === selectedObjectId);
    if (own) return own;
    const obj = s.objects.find((o) => o.id === selectedObjectId);
    if (obj?.state.kind === "dock_door" && obj.state.booking) {
      const byBooking = s.shipments.find((sh) => sh.id === obj.state.booking!.id);
      if (byBooking) return byBooking;
    }
  }
  const open = s.shipments.filter((sh) => !isFinished(sh));
  if (open.length === 0) return null;
  return [...open].sort(shipmentUrgency)[0]!;
}

// ---------------------------------------------------------------------------
// Search: objects, bookings, shipments
// ---------------------------------------------------------------------------

export interface TwinSearchHit {
  key: string;
  objectId: string;
  title: string;
  hint: string;
  score: number;
}

export function searchTwin(s: TwinSnapshot, query: string, limit = 8): TwinSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: TwinSearchHit[] = [];
  const score = (text: string | null | undefined): number => {
    if (!text) return 0;
    const t = text.toLowerCase();
    if (t === q) return 3;
    if (t.startsWith(q)) return 2;
    return t.includes(q) ? 1 : 0;
  };
  for (const o of s.objects) {
    const best = Math.max(score(o.label), score(o.binding?.label), score(KIND_LABEL[o.kind]) && 0.5, score(o.pill) && 0.5);
    if (best > 0) {
      hits.push({ key: `o:${o.id}`, objectId: o.id, title: o.label, hint: [KIND_LABEL[o.kind], o.pill].filter(Boolean).join(" · "), score: best });
    }
    if (o.state.kind === "dock_door" && o.state.booking) {
      const b = o.state.booking;
      const bs = Math.max(score(b.truckRef), score(b.carrier), score(b.ref));
      if (bs > 0) {
        hits.push({
          key: `b:${b.id}`,
          objectId: o.id,
          title: [b.truckRef, b.carrier].filter(Boolean).join(" · ") || "Booking",
          hint: `${b.direction === "inbound" ? "Inbound" : "Outbound"} at ${o.label}${b.ref ? ` for ${b.ref}` : ""}`,
          score: bs + 0.1,
        });
      }
    }
  }
  for (const sh of s.shipments) {
    if (!sh.dockObjectId || hits.some((h) => h.key === `b:${sh.id}`)) continue;
    const ss = Math.max(score(sh.ref), score(sh.truckRef), score(sh.carrier));
    if (ss > 0) {
      hits.push({
        key: `s:${sh.id}`,
        objectId: sh.dockObjectId,
        title: [sh.ref, sh.truckRef].filter(Boolean).join(" · ") || "Shipment",
        hint: `${sh.direction === "inbound" ? "Inbound" : "Outbound"} shipment${sh.carrier ? ` · ${sh.carrier}` : ""}`,
        score: ss,
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Inspector facts
// ---------------------------------------------------------------------------

export interface TwinFact {
  label: string;
  value: string;
  mono?: boolean;
}

export function inspectorFacts(o: TwinObject): TwinFact[] {
  const facts: TwinFact[] = [];
  const st = o.state;
  switch (st.kind) {
    case "dock_door":
      facts.push({ label: "State", value: o.pill ?? sentenceCase(st.status) });
      if (st.booking) {
        const b = st.booking;
        facts.push({ label: "Truck", value: dash(b.truckRef), mono: true });
        facts.push({ label: "Carrier", value: dash(b.carrier) });
        facts.push({ label: "Direction", value: b.direction === "inbound" ? "Inbound" : "Outbound" });
        facts.push({ label: "Booking", value: sentenceCase(b.status) });
        facts.push({ label: "ETA", value: formatDateTime(b.eta) });
        if (b.arrivedAt) facts.push({ label: "Arrived", value: formatDateTime(b.arrivedAt) });
        if (b.ref) facts.push({ label: "For", value: b.ref, mono: true });
      }
      facts.push({ label: "Upcoming bookings", value: String(st.upcoming) });
      break;
    case "rack":
    case "bin_zone":
    case "shelf":
      facts.push({ label: "On hand", value: formatCount(st.onHand) });
      facts.push({ label: "SKUs", value: formatCount(st.skuCount) });
      facts.push({ label: "Below reorder point", value: formatCount(st.lowStockCount) });
      break;
    case "work_center":
      facts.push({ label: "State", value: o.pill ?? sentenceCase(st.status) });
      facts.push({ label: "Utilisation (7 days)", value: `${Math.round(st.utilisationPct)}%` });
      if (st.workOrder) {
        facts.push({ label: "Order", value: dash(st.workOrder.moNumber), mono: true });
        facts.push({ label: "Operation", value: st.workOrder.name });
        if (st.workOrder.runningSince) facts.push({ label: "Running since", value: formatDateTime(st.workOrder.runningSince) });
      } else {
        facts.push({ label: "Work order", value: "None" });
      }
      facts.push({ label: "Schedule", value: st.late ? "Late" : "On time" });
      break;
    case "register":
      facts.push({ label: "State", value: o.pill ?? sentenceCase(st.status) });
      facts.push({ label: "Session", value: dash(st.sessionNumber), mono: true });
      facts.push({ label: "Sales this session", value: st.sessionId ? formatCents(st.salesCents) : "—" });
      facts.push({ label: "Opened", value: formatDateTime(st.openedAt) });
      break;
    case "equipment":
      facts.push({ label: "State", value: o.pill ?? sentenceCase(st.status) });
      facts.push({ label: "Task", value: dash(st.task?.note) });
      facts.push({ label: "At", value: dash(st.task?.label) });
      if (st.task?.assignedAt) facts.push({ label: "Assigned", value: formatDateTime(st.task.assignedAt) });
      facts.push({ label: "Position", value: `Estimated (cell ${Math.round(st.position.x)}, ${Math.round(st.position.z)})` });
      break;
    default:
      break;
  }
  const s = o.footprint;
  facts.push({ label: "Footprint", value: `${s.w} × ${s.d} m at ${s.x}, ${s.z}${s.rotation ? ` · ${s.rotation}°` : ""}` });
  return facts;
}
