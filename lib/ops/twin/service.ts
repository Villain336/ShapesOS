// ShapesOS — Phase 13 (twincore): create/patch hooks of the twin entities
// (lib/ops/twin/entities.ts). The DocType service (lib/ops/doctype.ts) has
// already validated the zod contract, run the gate and the status table
// when these run; they add the twin's own rules:
//
//   - layout: the footprint is inside the grid, rotation in the set, no two
//     footprints overlap (paths and equipment excepted), a grid never shrinks
//     under its objects;
//   - bindings: the type is allowed for the kind (TWIN_BINDABLE) and the
//     bound record EXISTS IN THIS WORKSPACE — a location must also belong to
//     the site's warehouse and be the right kind (a dock door binds a dock);
//   - dock bookings: the dock is a dock of the site's warehouse, what it
//     serves exists here, and no two active bookings of a dock overlap
//     (checked here, and by the ops_dock_bookings_no_overlap constraint);
//   - status moves are status-guarded writes (a racing move gets 409).
//
// Rule failures are OpsError (the generic route maps them to HTTP).

import type { Prisma } from "@prisma/client";
import { OpsError, OpsNotFoundError, auditOpsEvent, type OpsActor } from "../doctype";
import {
  DEFAULT_DOCK_SLOT_MINUTES,
  TwinRuleError,
  assertBindable,
  assertBookingMove,
  assertLocationKindFits,
  bookingClash,
  footprintProblem,
  gridProblem,
  overlapWith,
  type LayoutItem,
} from "@/lib/twin/derive";
import type { TwinBindingType, TwinObjectKind, TwinRotation } from "@/lib/twin/types";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Pure rule failures → the HTTP-mapped ops error. */
function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof TwinRuleError) throw new OpsError(e.status, e.message);
    throw e;
  }
}

async function mustSite(tx: Tx, actor: OpsActor, siteId: string) {
  const site = await tx.opsSite.findFirst({ where: { id: siteId, workspaceId: actor.workspaceId } });
  if (!site) throw new OpsNotFoundError("twin-sites", siteId);
  return site;
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export async function createSiteRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const warehouseId = String(body.warehouseId);
  const wh = await tx.opsWarehouse.findFirst({ where: { id: warehouseId, workspaceId: actor.workspaceId } });
  if (!wh) throw new OpsNotFoundError("warehouses", warehouseId);
  const grid = { gridW: Number(body.gridW), gridD: Number(body.gridD) };
  const bad = gridProblem(grid);
  if (bad) throw new OpsError(400, bad);
  if (await tx.opsSite.findFirst({ where: { workspaceId: actor.workspaceId, warehouseId } })) {
    throw new OpsError(409, `Warehouse ${wh.code} already has a twin site — one site per warehouse`);
  }
  const code = String(body.code).trim();
  if (await tx.opsSite.findFirst({ where: { workspaceId: actor.workspaceId, code } })) {
    throw new OpsError(409, `A twin site with code ${code} already exists`);
  }
  return (await tx.opsSite.create({
    data: {
      workspaceId: actor.workspaceId,
      kind: body.kind as "warehouse" | "factory" | "store",
      status: "draft",
      name: String(body.name),
      code,
      ...grid,
      warehouseId,
      notes: str(body.notes),
      createdBy: actor.userId,
    },
  })) as unknown as Row;
}

export async function patchSiteRow(tx: Tx, actor: OpsActor, id: string, patch: Row, existing: Row): Promise<Row> {
  const data: Prisma.OpsSiteUncheckedUpdateManyInput = {};
  if (typeof patch.name === "string") data.name = patch.name;
  if (patch.notes !== undefined) data.notes = (patch.notes as string | null) ?? null;
  if (patch.gridW !== undefined || patch.gridD !== undefined) {
    const grid = { gridW: Number(patch.gridW ?? existing.gridW), gridD: Number(patch.gridD ?? existing.gridD) };
    const bad = gridProblem(grid);
    if (bad) throw new OpsError(400, bad);
    const objects = await tx.opsSiteObject.findMany({ where: { workspaceId: actor.workspaceId, siteId: id } });
    for (const o of objects) {
      const problem = footprintProblem({ x: o.x, z: o.z, w: o.w, d: o.d, h: o.h, rotation: o.rotation as TwinRotation }, grid);
      if (problem) throw new OpsError(409, `"${o.label}" would no longer fit: ${problem}`);
      if ((o.homeX ?? 0) + o.w > grid.gridW || (o.homeZ ?? 0) + o.d > grid.gridD) throw new OpsError(409, `"${o.label}"'s home cell would fall outside the grid`);
    }
    Object.assign(data, grid);
  }
  if (typeof patch.status === "string" && patch.status !== existing.status) {
    data.status = patch.status as "draft" | "published";
    data.publishedAt = patch.status === "published" ? new Date() : null;
  }
  // Status-guarded: a racing publish / un-publish matches 0 rows → 409.
  const claimed = await tx.opsSite.updateMany({ where: { id, workspaceId: actor.workspaceId, status: existing.status as "draft" | "published" }, data });
  if (claimed.count !== 1) throw new OpsError(409, "The twin site changed concurrently — reload and retry");
  return (await tx.opsSite.findFirst({ where: { id, workspaceId: actor.workspaceId } })) as unknown as Row;
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/**
 * The bound record must exist in THIS workspace (RLS + an explicit filter);
 * a location must also be in the site's warehouse and the right kind.
 * Returns a display label.
 */
export async function assertBindingTarget(
  tx: Tx,
  actor: OpsActor,
  site: { warehouseId: string },
  kind: TwinObjectKind,
  type: TwinBindingType,
  bindingId: string,
): Promise<string> {
  rule(() => assertBindable(kind, type));
  const ws = actor.workspaceId;
  if (type === "location") {
    const loc = await tx.opsLocation.findFirst({ where: { id: bindingId, workspaceId: ws } });
    if (!loc) throw new OpsNotFoundError("locations", bindingId);
    if (loc.warehouseId !== site.warehouseId) throw new OpsError(422, `Location ${loc.path} is in a different warehouse than this site`);
    rule(() => assertLocationKindFits(kind, loc.kind));
    return loc.path;
  }
  if (type === "work_center") {
    const wc = await tx.opsWorkCenter.findFirst({ where: { id: bindingId, workspaceId: ws } });
    if (!wc) throw new OpsNotFoundError("work-centers", bindingId);
    return wc.code;
  }
  if (type === "register") {
    const r = await tx.opsPosRegister.findFirst({ where: { id: bindingId, workspaceId: ws } });
    if (!r) throw new OpsNotFoundError("pos-registers", bindingId);
    return r.name;
  }
  const p = await tx.opsProduct.findFirst({ where: { id: bindingId, workspaceId: ws } });
  if (!p) throw new OpsNotFoundError("products", bindingId);
  return p.sku;
}

async function assertPlacement(tx: Tx, actor: OpsActor, site: { id: string; gridW: number; gridD: number }, candidate: LayoutItem & { h: number; rotation: number }) {
  const problem = footprintProblem({ ...candidate.footprint, h: candidate.h, rotation: candidate.rotation as TwinRotation }, site);
  if (problem) throw new OpsError(422, `"${candidate.label}": ${problem}`);
  const others = await tx.opsSiteObject.findMany({
    where: { workspaceId: actor.workspaceId, siteId: site.id },
    select: { id: true, kind: true, label: true, x: true, z: true, w: true, d: true },
  });
  const clash = overlapWith(
    candidate,
    others.map((o) => ({ id: o.id, kind: o.kind as TwinObjectKind, label: o.label, footprint: { x: o.x, z: o.z, w: o.w, d: o.d } })),
  );
  if (clash) throw new OpsError(409, `"${candidate.label}" would overlap "${clash.label}"`);
}

async function assertTaskLocation(tx: Tx, actor: OpsActor, site: { warehouseId: string }, locationId: string) {
  const loc = await tx.opsLocation.findFirst({ where: { id: locationId, workspaceId: actor.workspaceId } });
  if (!loc) throw new OpsNotFoundError("locations", locationId);
  if (loc.warehouseId !== site.warehouseId) throw new OpsError(422, `Location ${loc.path} is in a different warehouse than this site`);
}

const EQUIPMENT_FIELDS = ["equipmentStatus", "taskLocationId", "taskNote", "homeX", "homeZ"] as const;

export async function createObjectRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const site = await mustSite(tx, actor, String(body.siteId));
  const kind = body.kind as TwinObjectKind;
  const isEquipment = kind === "equipment";
  if (!isEquipment && EQUIPMENT_FIELDS.some((f) => body[f] !== undefined)) {
    throw new OpsError(400, "equipmentStatus / home cell are for equipment objects only — other objects derive their state from their binding");
  }
  if (body.equipmentStatus === "busy") throw new OpsError(400, "New equipment starts available or charging — assign a task with a PATCH (equipmentStatus busy + taskLocationId / taskNote)");
  const type = (str(body.bindingType) as TwinBindingType | null) ?? null;
  const bindingId = str(body.bindingId);
  if (Boolean(type) !== Boolean(bindingId)) throw new OpsError(400, "bindingType and bindingId go together");
  if (type && bindingId) await assertBindingTarget(tx, actor, site, kind, type, bindingId);
  const fp = { x: Number(body.x), z: Number(body.z), w: Number(body.w ?? 1), d: Number(body.d ?? 1) };
  const h = Number(body.h ?? 1);
  const rotation = Number(body.rotation ?? 0);
  await assertPlacement(tx, actor, site, { id: "(new)", kind, label: String(body.label), footprint: fp, h, rotation });
  const homeX = isEquipment ? Number(body.homeX ?? fp.x) : null;
  const homeZ = isEquipment ? Number(body.homeZ ?? fp.z) : null;
  if (isEquipment && (homeX! + fp.w > site.gridW || homeZ! + fp.d > site.gridD)) throw new OpsError(422, "The home cell is outside the grid");
  return (await tx.opsSiteObject.create({
    data: {
      workspaceId: actor.workspaceId,
      siteId: site.id,
      kind,
      label: String(body.label),
      ...fp,
      h,
      rotation,
      bindingType: type,
      bindingId,
      ...(isEquipment ? { equipmentStatus: (body.equipmentStatus as "available" | "busy" | "charging" | undefined) ?? "available", homeX, homeZ } : {}),
    },
  })) as unknown as Row;
}

export async function patchObjectRow(tx: Tx, actor: OpsActor, id: string, patch: Row, existing: Row): Promise<Row> {
  const site = await mustSite(tx, actor, String(existing.siteId));
  const kind = existing.kind as TwinObjectKind;
  const isEquipment = kind === "equipment";
  if (!isEquipment && EQUIPMENT_FIELDS.some((f) => patch[f] !== undefined)) {
    throw new OpsError(400, "Only equipment has a status and a task — other objects derive their state from their binding");
  }
  const data: Prisma.OpsSiteObjectUncheckedUpdateInput = {};

  // Binding: both together, or both null to unbind.
  if (patch.bindingType !== undefined || patch.bindingId !== undefined) {
    const type = (patch.bindingType === undefined ? existing.bindingType : patch.bindingType) as TwinBindingType | null;
    const bindingId = (patch.bindingId === undefined ? existing.bindingId : patch.bindingId) as string | null;
    if (Boolean(type) !== Boolean(bindingId)) throw new OpsError(400, "bindingType and bindingId go together (null both to unbind)");
    if (type && bindingId) await assertBindingTarget(tx, actor, site, kind, type, bindingId);
    data.bindingType = type;
    data.bindingId = bindingId;
  }

  // Footprint: validated as a whole against the grid and the other objects.
  const moved = ["x", "z", "w", "d", "h", "rotation", "label"].some((k) => patch[k] !== undefined);
  if (moved) {
    const next = {
      x: Number(patch.x ?? existing.x),
      z: Number(patch.z ?? existing.z),
      w: Number(patch.w ?? existing.w),
      d: Number(patch.d ?? existing.d),
    };
    const h = Number(patch.h ?? existing.h);
    const rotation = Number(patch.rotation ?? existing.rotation);
    const label = String(patch.label ?? existing.label);
    await assertPlacement(tx, actor, site, { id, kind, label, footprint: next, h, rotation });
    Object.assign(data, next, { h, rotation, label });
  }

  if (isEquipment) {
    if (patch.homeX !== undefined) data.homeX = patch.homeX as number;
    if (patch.homeZ !== undefined) data.homeZ = patch.homeZ as number;
    const hx = Number(patch.homeX ?? existing.homeX ?? existing.x);
    const hz = Number(patch.homeZ ?? existing.homeZ ?? existing.z);
    if (hx + Number(existing.w) > site.gridW || hz + Number(existing.d) > site.gridD) throw new OpsError(422, "The home cell is outside the grid");
    // Assign (busy + task) / free (available) / charging. A task without a
    // status means busy; a non-busy status clears the task.
    const taskGiven = patch.taskLocationId !== undefined || patch.taskNote !== undefined;
    const status = (patch.equipmentStatus as string | undefined) ?? (taskGiven ? "busy" : undefined);
    if (status === "busy") {
      const locationId = (patch.taskLocationId === undefined ? existing.taskLocationId : patch.taskLocationId) as string | null;
      const note = (patch.taskNote === undefined ? existing.taskNote : patch.taskNote) as string | null;
      if (!locationId && !note) throw new OpsError(400, "A busy equipment item needs a task: taskLocationId and/or taskNote");
      if (locationId) await assertTaskLocation(tx, actor, site, locationId);
      Object.assign(data, { equipmentStatus: "busy", taskLocationId: locationId, taskNote: note, taskAssignedAt: new Date() });
    } else if (status === "available" || status === "charging") {
      if (taskGiven && (patch.taskLocationId || patch.taskNote)) throw new OpsError(400, `An ${status} equipment item has no task — set equipmentStatus "busy" to assign one`);
      Object.assign(data, { equipmentStatus: status, taskLocationId: null, taskNote: null, taskAssignedAt: null });
    }
  }

  return (await tx.opsSiteObject.update({ where: { id, workspaceId: actor.workspaceId }, data })) as unknown as Row;
}

// ---------------------------------------------------------------------------
// Dock bookings
// ---------------------------------------------------------------------------

/** A DB-level overlap (the exclusion constraint) as the same 409 the code check gives. */
function isOverlapViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("ops_dock_bookings_no_overlap") || msg.includes("23P01");
}

async function assertNoClash(
  tx: Tx,
  actor: OpsActor,
  dockLocationId: string,
  candidate: { id?: string; status: string; eta: Date; durationMinutes: number },
) {
  const span = candidate.durationMinutes * 60_000;
  const sameDock = await tx.opsDockBooking.findMany({
    where: {
      workspaceId: actor.workspaceId,
      dockLocationId,
      status: { in: ["booked", "arrived", "loading", "unloading"] },
      // Only bookings whose slot can touch the candidate's (slots are ≤ 24 h).
      eta: { gt: new Date(candidate.eta.getTime() - 1440 * 60_000), lt: new Date(candidate.eta.getTime() + span) },
    },
    select: { id: true, status: true, eta: true, durationMinutes: true, truckRef: true, carrier: true },
  });
  const clash = bookingClash(candidate, sameDock);
  if (clash) {
    const c = sameDock.find((b) => b.id === clash.id)!;
    throw new OpsError(409, `That dock is already booked from ${c.eta.toISOString()} for ${c.durationMinutes} min (${c.truckRef ?? c.carrier ?? c.id})`);
  }
}

export async function createBookingRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const ws = actor.workspaceId;
  const site = await mustSite(tx, actor, String(body.siteId));
  // The dock: a location id, or the twin dock door drawn for it.
  let dockLocationId = str(body.dockLocationId);
  const dockObjectId = str(body.dockObjectId);
  if (dockObjectId) {
    const o = await tx.opsSiteObject.findFirst({ where: { id: dockObjectId, workspaceId: ws, siteId: site.id } });
    if (!o) throw new OpsNotFoundError("twin-objects", dockObjectId);
    if (o.kind !== "dock_door" || o.bindingType !== "location" || !o.bindingId) throw new OpsError(422, `"${o.label}" is not a dock door bound to a dock`);
    if (dockLocationId && dockLocationId !== o.bindingId) throw new OpsError(400, "dockLocationId and dockObjectId point at different docks");
    dockLocationId = o.bindingId;
  }
  const dock = await tx.opsLocation.findFirst({ where: { id: dockLocationId!, workspaceId: ws } });
  if (!dock) throw new OpsNotFoundError("locations", dockLocationId!);
  if (dock.kind !== "dock") throw new OpsError(422, `${dock.path} is a ${dock.kind}, not a dock`);
  if (dock.warehouseId !== site.warehouseId) throw new OpsError(422, `Dock ${dock.path} is not in this site's warehouse`);

  // What it serves must exist here; the direction follows from it.
  let direction = str(body.direction) as "inbound" | "outbound" | null;
  const want = (d: "inbound" | "outbound", what: string) => {
    if (direction && direction !== d) throw new OpsError(422, `A booking for ${what} is ${d}`);
    direction = d;
  };
  const purchaseOrderId = str(body.purchaseOrderId);
  const orderId = str(body.orderId);
  const transferId = str(body.transferId);
  if (purchaseOrderId) {
    if (!(await tx.opsPurchaseOrder.findFirst({ where: { id: purchaseOrderId, workspaceId: ws }, select: { id: true } }))) throw new OpsNotFoundError("purchase-orders", purchaseOrderId);
    want("inbound", "a purchase order");
  }
  if (orderId) {
    if (!(await tx.opsOrder.findFirst({ where: { id: orderId, workspaceId: ws }, select: { id: true } }))) throw new OpsNotFoundError("orders", orderId);
    want("outbound", "a sales order");
  }
  if (transferId) {
    const t = await tx.opsTransfer.findFirst({
      where: { id: transferId, workspaceId: ws },
      select: { fromLocation: { select: { warehouseId: true } }, toLocation: { select: { warehouseId: true } } },
    });
    if (!t) throw new OpsNotFoundError("transfers", transferId);
    const into = t.toLocation.warehouseId === site.warehouseId;
    const outOf = t.fromLocation.warehouseId === site.warehouseId;
    if (!direction) direction = into && !outOf ? "inbound" : outOf && !into ? "outbound" : null;
    if (!direction) throw new OpsError(400, "Say whether the truck for this stock move is inbound or outbound");
  }
  const eta = body.eta as Date;
  const durationMinutes = Number(body.durationMinutes ?? DEFAULT_DOCK_SLOT_MINUTES);
  await assertNoClash(tx, actor, dock.id, { status: "booked", eta, durationMinutes });
  try {
    return (await tx.opsDockBooking.create({
      data: {
        workspaceId: ws,
        siteId: site.id,
        dockLocationId: dock.id,
        direction: direction ?? "inbound",
        carrier: str(body.carrier),
        truckRef: str(body.truckRef),
        purchaseOrderId,
        orderId,
        transferId,
        eta,
        durationMinutes,
        status: "booked",
        notes: str(body.notes),
        createdBy: actor.userId,
      },
    })) as unknown as Row;
  } catch (e) {
    if (isOverlapViolation(e)) throw new OpsError(409, "That dock is already booked for an overlapping slot");
    throw e;
  }
}

export async function patchBookingRow(tx: Tx, actor: OpsActor, id: string, patch: Row, existing: Row): Promise<Row> {
  const from = String(existing.status);
  const data: Prisma.OpsDockBookingUncheckedUpdateManyInput = {};
  for (const k of ["carrier", "truckRef", "notes"] as const) if (patch[k] !== undefined) data[k] = (patch[k] as string | null) ?? null;
  const to = typeof patch.status === "string" && patch.status !== from ? patch.status : null;
  if (to) {
    rule(() => assertBookingMove(from, to, existing.direction as "inbound" | "outbound"));
    const now = new Date();
    data.status = to as "arrived";
    if (to === "arrived") data.arrivedAt = now;
    if (to === "loading" || to === "unloading") data.startedAt = now;
    if (to === "done") data.doneAt = now;
    if (to === "cancelled") data.cancelledAt = now;
  }
  if (patch.eta !== undefined || patch.durationMinutes !== undefined) {
    if (from !== "booked") throw new OpsError(409, `Only a booked truck's slot can move (this one is ${from})`);
    data.eta = (patch.eta as Date | undefined) ?? (existing.eta as Date);
    data.durationMinutes = Number(patch.durationMinutes ?? existing.durationMinutes);
    if (to !== "cancelled") {
      await assertNoClash(tx, actor, String(existing.dockLocationId), { id, status: "booked", eta: data.eta as Date, durationMinutes: data.durationMinutes as number });
    }
  }
  try {
    const claimed = await tx.opsDockBooking.updateMany({ where: { id, workspaceId: actor.workspaceId, status: from as "booked" }, data });
    if (claimed.count !== 1) throw new OpsError(409, `The dock booking changed concurrently (no longer ${from}) — reload and retry`);
  } catch (e) {
    if (isOverlapViolation(e)) throw new OpsError(409, "That dock is already booked for an overlapping slot");
    throw e;
  }
  return (await tx.opsDockBooking.findFirst({ where: { id, workspaceId: actor.workspaceId } })) as unknown as Row;
}

// ---------------------------------------------------------------------------
// Object delete (DELETE /api/twin/objects/[id] — the layout editor)
// ---------------------------------------------------------------------------

/**
 * Remove ONE layout object. Layout edits are not money, so drafts and
 * published sites alike; refused (409) for equipment that is busy on a task
 * and for a dock door whose dock has an active booking. Audited like every
 * ops write (entity twin-objects, action "delete"). Nothing it is bound to
 * is touched — the record stays, only its drawing goes.
 */
export async function deleteObjectRow(tx: Tx, actor: OpsActor, id: string): Promise<Row> {
  const existing = await tx.opsSiteObject.findFirst({ where: { id, workspaceId: actor.workspaceId } });
  if (!existing) throw new OpsNotFoundError("twin-objects", id);
  if (existing.kind === "equipment" && existing.equipmentStatus === "busy") {
    throw new OpsError(409, `"${existing.label}" is busy on a task${existing.taskNote ? ` (${existing.taskNote})` : ""} — free it before removing it`);
  }
  if (existing.kind === "dock_door" && existing.bindingType === "location" && existing.bindingId) {
    const active = await tx.opsDockBooking.findFirst({
      where: { workspaceId: actor.workspaceId, dockLocationId: existing.bindingId, status: { in: ["booked", "arrived", "loading", "unloading"] } },
      orderBy: { eta: "asc" },
    });
    if (active) {
      throw new OpsError(
        409,
        `"${existing.label}" has an active booking (${active.truckRef ?? active.carrier ?? active.id}, ${active.status}, ETA ${active.eta.toISOString()}) — finish or cancel it before removing the dock door`,
      );
    }
  }
  const removed = await tx.opsSiteObject.deleteMany({ where: { id, workspaceId: actor.workspaceId } });
  if (removed.count !== 1) throw new OpsNotFoundError("twin-objects", id);
  const { twinObjectDef } = await import("./entities");
  await auditOpsEvent(tx, twinObjectDef, actor, "delete", id, `removed ${twinObjectDef.summarize(existing as unknown as Row)} from site ${existing.siteId}`);
  return existing as unknown as Row;
}
