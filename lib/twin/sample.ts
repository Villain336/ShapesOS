// ShapesOS — Phase 13 (twincore): the optional SAMPLE SITE per kind.
//
// POST /api/twin/sites/sample { kind } (admin) calls createSampleSite inside
// one workspace-scoped transaction. It builds REAL ops records — never a
// simulator — through the same DocType service every other caller uses
// (validation, audit, hooks): a warehouse with zones / racks / bins /
// shelves / docks, products and stock through the ledger (restock moves),
// a reorder rule (one product runs low), a purchase order and a sales
// order with dock bookings at different stages, two forklifts; a factory
// adds work centres, a routing and a manufacturing order with a running
// work order and logged time; a store adds registers, an open till session
// and one cash sale. Then it lays the site out with objects bound to those
// records. The layout goes through the twin-objects validation too.
//
// Idempotent per kind per workspace: the site code (SAMPLE-WH / SAMPLE-FAC /
// SAMPLE-STORE) is the key — a second call returns the existing site.
//
// One deliberate shortcut: confirming the sample manufacturing order calls
// the MO service directly (lib/ops/mfg/service.ts confirmMo) instead of the
// gated PATCH, because it is seed data an admin asked for and confirming
// moves no stock or money (completing it stays gated). The site itself is
// left as a DRAFT: publishing stays a person's gated step.

import type { Prisma } from "@prisma/client";
import { OpsError, opsCreate, opsEntityDef, opsPatch, type OpsActor } from "@/lib/ops/doctype";
import type { TwinSiteKind } from "./types";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

export const SAMPLE_SITE_CODES: Readonly<Record<TwinSiteKind, string>> = {
  warehouse: "SAMPLE-WH",
  factory: "SAMPLE-FAC",
  store: "SAMPLE-STORE",
};

export interface SampleSiteResult {
  siteId: string;
  kind: TwinSiteKind;
  created: boolean;
  objectCount: number;
}

const MIN = 60_000;

/** Create (or return) the workspace's sample site for `kind`. Run inside withWorkspaceScope. */
export async function createSampleSite(tx: Tx, actor: OpsActor, kind: TwinSiteKind, now: Date = new Date()): Promise<SampleSiteResult> {
  const code = SAMPLE_SITE_CODES[kind];
  const existing = await tx.opsSite.findFirst({ where: { workspaceId: actor.workspaceId, code }, include: { _count: { select: { objects: true } } } });
  if (existing) return { siteId: existing.id, kind, created: false, objectCount: existing._count.objects };

  const create = async (slug: string, body: Row): Promise<Row> => {
    const r = await opsCreate(tx, opsEntityDef(slug), actor, body);
    if (r.outcome !== "done") throw new OpsError(500, `sample site: creating ${slug} needed an approval`);
    return r.row;
  };
  const patch = async (slug: string, body: Row): Promise<Row> => {
    const r = await opsPatch(tx, opsEntityDef(slug), actor, body);
    if (r.outcome !== "done") throw new OpsError(500, `sample site: changing ${slug} needed an approval`);
    return r.row;
  };
  const idOf = (r: Row) => String(r.id);
  const prefix = { warehouse: "SWH", factory: "SFA", store: "SST" }[kind];
  const iso = (ms: number) => new Date(now.getTime() + ms).toISOString();

  const wh = await create("warehouses", { name: `Sample ${kind}`, code: `${prefix}-01`, address: "Sample data — safe to explore" });
  const loc = async (k: string, c: string, name: string, parentId?: string) =>
    idOf(await create("locations", { warehouseId: wh.id, kind: k, code: c, name, ...(parentId ? { parentId } : {}) }));
  const product = async (sku: string, name: string, priceCents: number) => idOf(await create("products", { name, sku: `${prefix}-${sku}`, priceCents }));
  const restock = (productId: string, locationId: string, delta: number) =>
    create("inventory-txns", { productId, delta, reason: "restock", locationId, note: "Sample site stock" });

  const objects: Row[] = [];
  const site = await create("twin-sites", {
    kind,
    name: `Sample ${kind}`,
    code,
    gridW: kind === "warehouse" ? 40 : kind === "factory" ? 36 : 30,
    gridD: kind === "warehouse" ? 28 : kind === "factory" ? 24 : 20,
    warehouseId: wh.id,
    notes: "Created from real sample records (Ops → Digital twin → sample site).",
  });
  const siteId = idOf(site);
  const place = async (o: Row) => objects.push(await create("twin-objects", { siteId, ...o }));
  const at = (type: string, id: string) => ({ bindingType: type, bindingId: id });

  // ---------------------------------------------------------------- warehouse
  if (kind === "warehouse") {
    const zone = await loc("zone", "A", "Storage");
    const staging = await loc("zone", "STG", "Staging");
    const racks: string[] = [];
    const bins: string[][] = [];
    for (let i = 1; i <= 4; i++) {
      const r = await loc("rack", `A-0${i}`, `Rack A-0${i}`, zone);
      racks.push(r);
      bins.push([await loc("bin", `A-0${i}-1`, `Bin A-0${i}-1`, r), await loc("bin", `A-0${i}-2`, `Bin A-0${i}-2`, r)]);
    }
    const docks: string[] = [];
    for (let i = 1; i <= 4; i++) docks.push(await loc("dock", `D${i}`, `Dock ${i}`));
    const widgets = await product("WID", "Pallet — widgets", 1200);
    const gears = await product("GEA", "Pallet — gears", 2400);
    const bolts = await product("BOL", "Pallet — bolts", 600);
    const cable = await product("CAB", "Pallet — cable", 900);
    await restock(widgets, bins[0]![0]!, 40);
    await restock(gears, bins[1]![0]!, 25);
    await restock(bolts, bins[2]![0]!, 8);
    await restock(cable, bins[3]![1]!, 60);
    await restock(widgets, staging, 12);
    // Bolts run low: 8 on hand against a minimum of 20.
    await create("reorder-rules", { productId: bolts, warehouseId: wh.id, receiveLocationId: bins[2]![0]!, minQty: 20, maxQty: 80, supplierName: "Acme Supply" });

    await place({ kind: "building", label: "Office", x: 32, z: 0, w: 8, d: 6, h: 4 });
    for (let i = 0; i < 4; i++) await place({ kind: "rack", label: `Rack A-0${i + 1}`, x: 2 + i * 7, z: 2, w: 4, d: 10, h: 4, ...at("location", racks[i]!) });
    await place({ kind: "path", label: "Main aisle", x: 0, z: 13, w: 32, d: 2, h: 1 });
    await place({ kind: "bin_zone", label: "Staging", x: 2, z: 16, w: 22, d: 6, h: 1, ...at("location", staging) });
    for (let i = 0; i < 4; i++) {
      await place({ kind: "dock_door", label: `Dock ${i + 1}`, x: 2 + i * 6, z: 24, w: 4, d: 2, h: 3, ...at("location", docks[i]!) });
      await place({ kind: "yard_slot", label: `Yard ${i + 1}`, x: 2 + i * 6, z: 26, w: 4, d: 2, h: 1 });
    }
    await place({ kind: "equipment", label: "Forklift 1", x: 4, z: 13, w: 1, d: 1, h: 2, equipmentStatus: "available" });
    const f1 = idOf(objects.at(-1)!);
    await place({ kind: "equipment", label: "Forklift 2", x: 10, z: 13, w: 1, d: 1, h: 2, equipmentStatus: "available" });
    const f2 = idOf(objects.at(-1)!);
    await patch("twin-objects", { id: f1, equipmentStatus: "busy", taskLocationId: racks[1]!, taskNote: "Put away gears from dock 1" });
    await patch("twin-objects", { id: f2, equipmentStatus: "charging" });

    // Inbound: a purchase order unloading at dock 1.
    const po = await create("purchase-orders", { supplierName: "Acme Supply", lineItems: [{ name: "Pallet — gears", sku: `${prefix}-GEA`, qty: 10, priceCents: 1800 }] });
    const b1 = await create("dock-bookings", { siteId, dockLocationId: docks[0]!, purchaseOrderId: po.id, carrier: "Acme Freight", truckRef: "TRK-101", eta: iso(-20 * MIN) });
    await patch("dock-bookings", { id: b1.id, status: "arrived" });
    await patch("dock-bookings", { id: b1.id, status: "unloading" });
    // Outbound: a confirmed sales order booked at dock 2.
    const so = await create("orders", { lineItems: [{ name: "Pallet — widgets", sku: `${prefix}-WID`, qty: 6, priceCents: 1200 }] });
    await patch("orders", { id: so.id, status: "confirmed" });
    await create("dock-bookings", { siteId, dockLocationId: docks[1]!, orderId: so.id, carrier: "City Haulage", truckRef: "TRK-204", eta: iso(45 * MIN) });
    // A later inbound truck, and one delivered on time earlier.
    await create("dock-bookings", { siteId, dockLocationId: docks[2]!, direction: "inbound", carrier: "Northline", truckRef: "TRK-330", eta: iso(3 * 60 * MIN) });
    const b4 = await create("dock-bookings", { siteId, dockLocationId: docks[3]!, direction: "inbound", carrier: "Northline", truckRef: "TRK-312", eta: iso(5 * MIN), durationMinutes: 30 });
    for (const status of ["arrived", "unloading", "done"]) await patch("dock-bookings", { id: b4.id, status });
  }

  // ---------------------------------------------------------------- factory
  if (kind === "factory") {
    const raw = await loc("zone", "RAW", "Raw materials");
    const fg = await loc("zone", "FG", "Finished goods");
    const rack = await loc("rack", "R-01", "Rack R-01", raw);
    const d1 = await loc("dock", "D1", "Dock 1");
    const d2 = await loc("dock", "D2", "Dock 2");
    const steel = await product("STL", "Steel blank", 800);
    const gearbox = await product("GBX", "Gearbox", 14_000);
    await restock(steel, rack, 30);
    await restock(gearbox, fg, 4);
    await create("reorder-rules", { productId: steel, warehouseId: wh.id, receiveLocationId: rack, minQty: 10, maxQty: 60, supplierName: "Steelworks" });
    const cnc = idOf(await create("work-centers", { name: "CNC mill", code: `${prefix}-CNC1`, capacity: 1, hourlyCostCents: 6000, locationId: raw }));
    const asm = idOf(await create("work-centers", { name: "Assembly bench", code: `${prefix}-ASM1`, capacity: 1, hourlyCostCents: 4000, locationId: fg }));
    const routing = await create("routings", {
      productId: gearbox,
      name: "Gearbox standard",
      operations: [
        { sequence: 1, name: "Machine housing", workCenterId: cnc, plannedMinutes: 30 },
        { sequence: 2, name: "Assemble", workCenterId: asm, plannedMinutes: 20 },
      ],
    });
    const draft = await create("manufacturing-orders", { productId: gearbox, qty: 6, routingId: routing.id, componentLocationId: raw, finishedLocationId: fg, plannedStart: iso(-30 * MIN), note: "Sample order" });
    const { confirmMo } = await import("@/lib/ops/mfg/service");
    const mo = await confirmMo(tx, actor, draft);
    const wos = await tx.opsWorkOrder.findMany({ where: { workspaceId: actor.workspaceId, moId: String(mo.id) }, orderBy: { sequence: "asc" } });
    await create("work-time-logs", { workOrderId: wos[0]!.id, minutes: 90, note: "Sample: first shift" });
    await patch("work-orders", { id: wos[0]!.id, status: "in_progress" });

    await place({ kind: "building", label: "Office", x: 28, z: 0, w: 8, d: 5, h: 4 });
    await place({ kind: "bin_zone", label: "Raw materials", x: 2, z: 2, w: 8, d: 6, h: 1, ...at("location", raw) });
    await place({ kind: "rack", label: "Rack R-01", x: 2, z: 9, w: 8, d: 2, h: 4, ...at("location", rack) });
    await place({ kind: "work_center", label: "CNC mill", x: 13, z: 2, w: 5, d: 5, h: 3, ...at("work_center", cnc) });
    await place({ kind: "work_center", label: "Assembly bench", x: 20, z: 2, w: 5, d: 4, h: 2, ...at("work_center", asm) });
    await place({ kind: "bin_zone", label: "Finished goods", x: 13, z: 10, w: 12, d: 4, h: 1, ...at("location", fg) });
    await place({ kind: "path", label: "Main aisle", x: 0, z: 15, w: 36, d: 2, h: 1 });
    await place({ kind: "dock_door", label: "Dock 1", x: 4, z: 20, w: 4, d: 2, h: 3, ...at("location", d1) });
    await place({ kind: "dock_door", label: "Dock 2", x: 12, z: 20, w: 4, d: 2, h: 3, ...at("location", d2) });
    await place({ kind: "yard_slot", label: "Yard", x: 4, z: 22, w: 12, d: 2, h: 1 });
    await place({ kind: "equipment", label: "Forklift 1", x: 3, z: 15, w: 1, d: 1, h: 2, equipmentStatus: "available" });
    const f1 = idOf(objects.at(-1)!);
    await place({ kind: "equipment", label: "Forklift 2", x: 8, z: 15, w: 1, d: 1, h: 2, equipmentStatus: "charging" });
    await patch("twin-objects", { id: f1, equipmentStatus: "busy", taskLocationId: rack, taskNote: "Bring steel blanks to the CNC mill" });

    await create("dock-bookings", { siteId, dockLocationId: d1, direction: "inbound", carrier: "Steelworks", truckRef: "TRK-501", eta: iso(30 * MIN) });
    await create("dock-bookings", { siteId, dockLocationId: d2, direction: "outbound", carrier: "City Haulage", truckRef: "TRK-502", eta: iso(2 * 60 * MIN) });
  }

  // ---------------------------------------------------------------- store
  if (kind === "store") {
    const floor = await loc("zone", "FLOOR", "Shop floor");
    const back = await loc("zone", "BACK", "Stockroom");
    const shelves: string[] = [];
    for (let i = 1; i <= 4; i++) shelves.push(await loc("shelf", `S-0${i}`, `Shelf S-0${i}`, floor));
    const d1 = await loc("dock", "D1", "Back door");
    const mugs = await product("MUG", "Mug", 1200);
    const tea = await product("TEA", "Tea tin", 800);
    const cups = await product("CUP", "Travel cup", 2200);
    const bags = await product("BAG", "Tote bag", 1500);
    await restock(mugs, shelves[0]!, 24);
    await restock(tea, shelves[1]!, 40);
    await restock(cups, shelves[2]!, 3);
    await restock(bags, shelves[3]!, 15);
    await restock(mugs, back, 48);
    await create("reorder-rules", { productId: cups, warehouseId: wh.id, receiveLocationId: shelves[2]!, minQty: 6, maxQty: 30, supplierName: "Cup Co" });
    const till1 = idOf(await create("pos-registers", { name: `Sample till 1 (${prefix})`, locationId: floor }));
    const till2 = idOf(await create("pos-registers", { name: `Sample till 2 (${prefix})`, locationId: floor }));
    const session = await create("pos-sessions", { registerId: till1, openingCashCents: 10_000, note: "Sample session" });
    const { quoteSale, recordPosSale } = await import("@/lib/ops/pos/service");
    const { newClientOrderId } = await import("@/lib/ops/pos/rules");
    const lines = [{ productId: mugs, qty: 2 }];
    const q = await quoteSale(tx, actor, String(session.id), lines);
    await recordPosSale(tx, actor, String(session.id), {
      clientOrderId: newClientOrderId(now.getTime()),
      lines,
      payments: [{ method: "cash", amountCents: q.totalCents, tenderedCents: q.totalCents, provider: "cash" }],
    });

    for (let i = 0; i < 4; i++) await place({ kind: "shelf", label: `Shelf S-0${i + 1}`, x: 3 + i * 5, z: 3, w: 3, d: 8, h: 2, ...at("location", shelves[i]!) });
    await place({ kind: "register", label: "Till 1", x: 4, z: 14, w: 3, d: 2, h: 1, ...at("register", till1) });
    await place({ kind: "register", label: "Till 2", x: 9, z: 14, w: 3, d: 2, h: 1, ...at("register", till2) });
    await place({ kind: "path", label: "Shop aisle", x: 0, z: 12, w: 24, d: 1, h: 1 });
    await place({ kind: "bin_zone", label: "Stockroom", x: 24, z: 2, w: 6, d: 10, h: 1, ...at("location", back) });
    await place({ kind: "dock_door", label: "Back door", x: 25, z: 14, w: 4, d: 2, h: 3, ...at("location", d1) });
    await place({ kind: "yard_slot", label: "Delivery bay", x: 25, z: 17, w: 4, d: 3, h: 1 });
    await place({ kind: "equipment", label: "Cart 1", x: 2, z: 12, w: 1, d: 1, h: 1, equipmentStatus: "available" });
    const c1 = idOf(objects.at(-1)!);
    await place({ kind: "equipment", label: "Cart 2", x: 20, z: 12, w: 1, d: 1, h: 1, equipmentStatus: "available" });
    await patch("twin-objects", { id: c1, equipmentStatus: "busy", taskLocationId: shelves[2]!, taskNote: "Refill travel cups" });

    await create("dock-bookings", { siteId, dockLocationId: d1, direction: "inbound", carrier: "Cup Co", truckRef: "VAN-11", eta: iso(60 * MIN), durationMinutes: 30 });
    await create("dock-bookings", { siteId, dockLocationId: d1, direction: "inbound", carrier: "Local Dairy", truckRef: "VAN-12", eta: iso(3 * 60 * MIN), durationMinutes: 30 });
  }

  return { siteId, kind, created: true, objectCount: objects.length };
}
