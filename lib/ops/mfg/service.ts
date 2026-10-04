// ShapesOS — Phase 12 (mfgpos): manufacturing on the Ops layer.
//
// The create/patch hooks behind the manufacturing entities in OPS_ENTITIES
// (lib/ops/mfg/entities.ts): the generic /api/ops/{entity} route, audit,
// workspace scoping and the Phase 14 gate run around every one of them.
//
//   work centres     capacity + hourly cost (+ optional location)
//   routings         product → CAD BOM revision + ordered operations
//   manufacturing    draft → confirm (gated: components snapshotted from the
//   orders           CAD BOM, one work order per routing step, MO-0001) →
//                    in progress → done (gated, Tier 3: ONE transaction —
//                    claim, consume components, produce finished goods, scrap,
//                    costing, journal entries; a second completion is a no-op)
//   work orders      start / pause / finish timer, capped by work-centre
//                    capacity; every closed segment is a time log
//   time logs        append-only; manual entries add to the work order
//   scrap            gated: a "scrap" ledger row + Dr Scrap loss / Cr stock
//
// Stock only moves through recordInventoryTxn (the Phase 10 ledger); money
// only through postEntry (the append-only, DB-balanced journal).

import type { Prisma } from "@prisma/client";
import { auditOpsEvent, OpsError, OpsNotFoundError, recordInventoryTxn, type OpsActor } from "../doctype";
import { OPS_ENTITY_MAP } from "../entities";
import { hasFinanceLedger, nextDocumentNumber } from "../finance/numbering";
import { postMoCompletion, postScrap } from "../finance/posting";
import { defaultVariantId, onHandAt } from "../stock";
import {
  assertMoTransition,
  completionQuantities,
  componentsFromBom,
  consumption,
  hasCapacity,
  moCosting,
  orderOperations,
  plannedWorkOrders,
  timerStep,
  type MoComponent,
  type RoutingOperation,
} from "./rules";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

const def = (slug: string) => OPS_ENTITY_MAP[slug]!;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

async function mustProduct(tx: Tx, actor: OpsActor, id: string) {
  const p = await tx.opsProduct.findFirst({ where: { id, workspaceId: actor.workspaceId } });
  if (!p) throw new OpsNotFoundError("products", id);
  return p;
}

async function mustLocation(tx: Tx, actor: OpsActor, id: string | null) {
  if (!id) return null;
  const l = await tx.opsLocation.findFirst({ where: { id, workspaceId: actor.workspaceId } });
  if (!l) throw new OpsNotFoundError("locations", id);
  return l;
}

async function mustBomVersion(tx: Tx, actor: OpsActor, id: string | null) {
  if (!id) return null;
  const b = await tx.cadBomVersion.findFirst({ where: { id, workspaceId: actor.workspaceId } });
  if (!b) throw new OpsNotFoundError("bom-versions", id);
  return b;
}

async function mustVariantOf(tx: Tx, actor: OpsActor, productId: string, variantId: string | null) {
  if (!variantId) return null;
  const v = await tx.opsProductVariant.findFirst({ where: { id: variantId, workspaceId: actor.workspaceId } });
  if (!v) throw new OpsNotFoundError("product-variants", variantId);
  if (v.productId !== productId) throw new OpsError(422, `Variant "${variantId}" is not a variant of product "${productId}"`);
  return v;
}

// ---------------------------------------------------------------------------
// Work centres
// ---------------------------------------------------------------------------

export async function createWorkCenterRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  await mustLocation(tx, actor, str(body.locationId));
  return tx.opsWorkCenter.create({
    data: {
      workspaceId: actor.workspaceId,
      name: String(body.name).trim(),
      code: String(body.code).trim(),
      capacity: (body.capacity as number | undefined) ?? 1,
      hourlyCostCents: (body.hourlyCostCents as number | undefined) ?? 0,
      locationId: str(body.locationId),
      notes: str(body.notes),
    },
  }) as unknown as Row;
}

export async function patchWorkCenterRow(tx: Tx, actor: OpsActor, id: string, patch: Row): Promise<Row> {
  if (typeof patch.locationId === "string") await mustLocation(tx, actor, patch.locationId);
  return tx.opsWorkCenter.update({ where: { id, workspaceId: actor.workspaceId }, data: patch as Prisma.OpsWorkCenterUncheckedUpdateInput }) as unknown as Row;
}

// ---------------------------------------------------------------------------
// Routings
// ---------------------------------------------------------------------------

async function validOperations(tx: Tx, actor: OpsActor, raw: unknown): Promise<RoutingOperation[]> {
  const ops = orderOperations((raw ?? []) as RoutingOperation[]);
  const ids = [...new Set(ops.map((o) => o.workCenterId))];
  if (ids.length) {
    const found = await tx.opsWorkCenter.findMany({ where: { workspaceId: actor.workspaceId, id: { in: ids } }, select: { id: true, active: true, name: true } });
    for (const id of ids) {
      const wc = found.find((f) => f.id === id);
      if (!wc) throw new OpsNotFoundError("work-centers", id);
      if (!wc.active) throw new OpsError(422, `Work centre "${wc.name}" is inactive`);
    }
  }
  return ops.map((o) => ({ sequence: o.sequence, name: o.name.trim(), workCenterId: o.workCenterId, plannedMinutes: o.plannedMinutes }));
}

export async function createRoutingRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const productId = String(body.productId);
  await mustProduct(tx, actor, productId);
  await mustBomVersion(tx, actor, str(body.bomVersionId));
  const operations = await validOperations(tx, actor, body.operations);
  return tx.opsRouting.create({
    data: {
      workspaceId: actor.workspaceId,
      productId,
      bomVersionId: str(body.bomVersionId),
      name: String(body.name).trim(),
      operations: operations as unknown as Prisma.InputJsonValue,
    },
  }) as unknown as Row;
}

export async function patchRoutingRow(tx: Tx, actor: OpsActor, id: string, patch: Row): Promise<Row> {
  const data: Row = { ...patch };
  if (patch.operations !== undefined) data.operations = (await validOperations(tx, actor, patch.operations)) as unknown as Prisma.InputJsonValue;
  if (typeof patch.bomVersionId === "string") await mustBomVersion(tx, actor, patch.bomVersionId);
  return tx.opsRouting.update({ where: { id, workspaceId: actor.workspaceId }, data: data as Prisma.OpsRoutingUncheckedUpdateInput }) as unknown as Row;
}

/** The product's active routing (newest first). */
export async function activeRouting(tx: Tx, workspaceId: string, productId: string) {
  return tx.opsRouting.findFirst({ where: { workspaceId, productId, active: true }, orderBy: { createdAt: "desc" } });
}

// ---------------------------------------------------------------------------
// Product BOM — DERIVED from the CAD BOM revision (no second BOM model)
// ---------------------------------------------------------------------------

export async function bomComponents(tx: Tx, workspaceId: string, bomVersionId: string): Promise<MoComponent[]> {
  const lines = await tx.cadBomLine.findMany({
    where: { workspaceId, bomVersionId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { inventoryPart: { select: { sku: true, opsProductId: true, opsProduct: { select: { sku: true, trackInventory: true } } } } },
  });
  return componentsFromBom(
    lines.map((l) => ({
      id: l.id,
      partName: l.partName,
      qty: l.qty,
      unitCostUsd: l.unitCostUsd,
      productId: l.inventoryPart?.opsProductId ?? null,
      productSku: l.inventoryPart?.opsProduct?.sku ?? null,
      partSku: l.inventoryPart?.sku ?? null,
      trackInventory: l.inventoryPart?.opsProduct?.trackInventory ?? false,
    })),
  );
}

export interface ProductBomView {
  productId: string;
  routingId: string | null;
  bomVersionId: string | null;
  components: MoComponent[];
  operations: RoutingOperation[];
  /** BOM lines whose CAD part isn't linked to an Ops product (cost only, no stock move). */
  unlinked: number;
}

export async function productBom(tx: Tx, workspaceId: string, productId: string): Promise<ProductBomView> {
  const routing = await activeRouting(tx, workspaceId, productId);
  const bomVersionId = routing?.bomVersionId ?? null;
  const components = bomVersionId ? await bomComponents(tx, workspaceId, bomVersionId) : [];
  return {
    productId,
    routingId: routing?.id ?? null,
    bomVersionId,
    components,
    operations: routing ? orderOperations(routing.operations as unknown as RoutingOperation[]) : [],
    unlinked: components.filter((c) => !c.productId).length,
  };
}

// ---------------------------------------------------------------------------
// Manufacturing orders
// ---------------------------------------------------------------------------

export async function createMoRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const productId = String(body.productId);
  const product = await mustProduct(tx, actor, productId);
  if (!product.trackInventory) throw new OpsError(422, `"${product.name}" does not track inventory — turn tracking on to manufacture it`);
  await mustVariantOf(tx, actor, productId, str(body.variantId));
  let routing = null as Awaited<ReturnType<typeof activeRouting>>;
  if (str(body.routingId)) {
    routing = await tx.opsRouting.findFirst({ where: { id: String(body.routingId), workspaceId: actor.workspaceId } });
    if (!routing) throw new OpsNotFoundError("routings", String(body.routingId));
    if (routing.productId !== productId) throw new OpsError(422, "That routing makes a different product");
  } else {
    routing = await activeRouting(tx, actor.workspaceId, productId);
  }
  const bomVersionId = str(body.bomVersionId) ?? routing?.bomVersionId ?? null;
  await mustBomVersion(tx, actor, bomVersionId);
  await mustLocation(tx, actor, str(body.componentLocationId));
  await mustLocation(tx, actor, str(body.finishedLocationId));
  return tx.opsManufacturingOrder.create({
    data: {
      workspaceId: actor.workspaceId,
      productId,
      variantId: str(body.variantId),
      qty: body.qty as number,
      status: "draft",
      routingId: routing?.id ?? null,
      bomVersionId,
      componentLocationId: str(body.componentLocationId),
      finishedLocationId: str(body.finishedLocationId),
      plannedStart: (body.plannedStart as Date | undefined) ?? null,
      note: str(body.note),
      createdBy: actor.userId,
    },
  }) as unknown as Row;
}

async function reloadMo(tx: Tx, actor: OpsActor, id: string): Promise<Row> {
  return (await tx.opsManufacturingOrder.findFirst({ where: { id, workspaceId: actor.workspaceId } })) as unknown as Row;
}

/** Hook for PATCH /api/ops/manufacturing-orders (gate + transition table already ran). */
export async function patchMo(tx: Tx, actor: OpsActor, id: string, patch: Row, existing: Row): Promise<Row> {
  const to = typeof patch.status === "string" ? patch.status : null;
  if (!to && (patch.producedQty !== undefined || patch.scrappedQty !== undefined)) {
    throw new OpsError(400, "producedQty / scrappedQty go with status \"done\"");
  }
  if (to === "confirmed") return confirmMo(tx, actor, existing);
  if (to === "in_progress") return startMo(tx, actor, existing);
  if (to === "done") return (await completeMo(tx, actor, id, { producedQty: patch.producedQty as number | undefined, scrappedQty: patch.scrappedQty as number | undefined })).mo;
  if (to === "cancelled") return cancelMo(tx, actor, existing);
  // Plan edits: draft only.
  if (existing.status !== "draft") throw new OpsError(409, "Only a draft manufacturing order can be edited — confirm freezes the plan");
  const data: Row = { ...patch };
  delete data.status;
  if (typeof patch.variantId === "string") await mustVariantOf(tx, actor, String(existing.productId), patch.variantId);
  if (typeof patch.bomVersionId === "string") await mustBomVersion(tx, actor, patch.bomVersionId);
  if (typeof patch.componentLocationId === "string") await mustLocation(tx, actor, patch.componentLocationId);
  if (typeof patch.finishedLocationId === "string") await mustLocation(tx, actor, patch.finishedLocationId);
  if (typeof patch.routingId === "string") {
    const r = await tx.opsRouting.findFirst({ where: { id: patch.routingId, workspaceId: actor.workspaceId } });
    if (!r) throw new OpsNotFoundError("routings", patch.routingId);
    if (r.productId !== existing.productId) throw new OpsError(422, "That routing makes a different product");
  }
  const claimed = await tx.opsManufacturingOrder.updateMany({ where: { id, workspaceId: actor.workspaceId, status: "draft" }, data: data as Prisma.OpsManufacturingOrderUncheckedUpdateManyInput });
  if (claimed.count !== 1) throw new OpsError(409, "The manufacturing order changed concurrently — reload and retry");
  return reloadMo(tx, actor, id);
}

/**
 * Confirm: snapshot the components from the CAD BOM, create one work order
 * per routing step, take the next MO number and the planned cost of the
 * latest CAD cost estimate — status-guarded (one confirm per order).
 */
export async function confirmMo(tx: Tx, actor: OpsActor, mo: Row): Promise<Row> {
  const id = String(mo.id);
  assertMoTransition(String(mo.status), "confirmed");
  const qty = Number(mo.qty);
  const bomVersionId = str(mo.bomVersionId);
  const components = bomVersionId ? await bomComponents(tx, actor.workspaceId, bomVersionId) : [];
  let workOrders: Array<RoutingOperation> = [];
  if (str(mo.routingId)) {
    const routing = await tx.opsRouting.findFirst({ where: { id: String(mo.routingId), workspaceId: actor.workspaceId } });
    if (routing) workOrders = plannedWorkOrders(await validOperations(tx, actor, routing.operations), qty);
  }
  let plannedCostCents: number | null = null;
  let costEstimateId: string | null = null;
  if (bomVersionId) {
    const est = await tx.cadCostEstimate.findFirst({ where: { workspaceId: actor.workspaceId, bomVersionId }, orderBy: { createdAt: "desc" } });
    if (est) {
      costEstimateId = est.id;
      const perUnit = est.perUnitUsd ?? (est.quantity > 0 ? est.grandTotalUsd / est.quantity : null);
      if (perUnit != null && Number.isFinite(perUnit)) plannedCostCents = Math.min(2_147_483_647, Math.round(perUnit * 100 * qty));
    }
  }
  const number = await nextDocumentNumber(tx, actor.workspaceId, "mo");
  const claimed = await tx.opsManufacturingOrder.updateMany({
    where: { id, workspaceId: actor.workspaceId, status: "draft" },
    data: {
      status: "confirmed",
      number,
      components: components as unknown as Prisma.InputJsonValue,
      plannedCostCents,
      costEstimateId,
      confirmedAt: new Date(),
    },
  });
  if (claimed.count !== 1) throw new OpsError(409, "The manufacturing order is no longer a draft — reload and retry");
  for (const w of workOrders) {
    await tx.opsWorkOrder.create({
      data: { workspaceId: actor.workspaceId, moId: id, sequence: w.sequence, name: w.name, workCenterId: w.workCenterId, plannedMinutes: w.plannedMinutes },
    });
  }
  return reloadMo(tx, actor, id);
}

export async function startMo(tx: Tx, actor: OpsActor, mo: Row): Promise<Row> {
  const id = String(mo.id);
  assertMoTransition(String(mo.status), "in_progress");
  const claimed = await tx.opsManufacturingOrder.updateMany({
    where: { id, workspaceId: actor.workspaceId, status: "confirmed" },
    data: { status: "in_progress", startedAt: new Date() },
  });
  if (claimed.count !== 1) throw new OpsError(409, "The manufacturing order is no longer confirmed — reload and retry");
  return reloadMo(tx, actor, id);
}

/** Close every open work order of an MO (running timers log their last segment). */
async function closeWorkOrders(tx: Tx, actor: OpsActor, moId: string, to: "done" | "cancelled", now: Date) {
  const wos = await tx.opsWorkOrder.findMany({ where: { workspaceId: actor.workspaceId, moId, status: { in: ["pending", "in_progress", "paused"] } } });
  for (const wo of wos) {
    // A never-started step closes as `to` directly; a running one logs its segment.
    const fromStatus = wo.status === "pending" && to === "done" ? "paused" : wo.status;
    const step = timerStep({ status: fromStatus, runningSince: wo.runningSince, actualSeconds: wo.actualSeconds }, to, now);
    if (step.segment) {
      await tx.opsWorkTimeLog.create({
        data: { workspaceId: actor.workspaceId, workOrderId: wo.id, userId: actor.userId, startedAt: step.segment.startedAt, endedAt: step.segment.endedAt, seconds: step.segment.seconds, source: "timer", note: `stopped when the order was ${to === "done" ? "completed" : "cancelled"}` },
      });
    }
    await tx.opsWorkOrder.update({
      where: { id: wo.id },
      data: { status: step.status as "done" | "cancelled", runningSince: null, actualSeconds: step.actualSeconds, ...(to === "done" ? { finishedAt: now } : {}) },
    });
  }
}

export async function cancelMo(tx: Tx, actor: OpsActor, mo: Row): Promise<Row> {
  const id = String(mo.id);
  assertMoTransition(String(mo.status), "cancelled");
  const now = new Date();
  const claimed = await tx.opsManufacturingOrder.updateMany({
    where: { id, workspaceId: actor.workspaceId, status: { in: ["draft", "confirmed", "in_progress"] } },
    data: { status: "cancelled", cancelledAt: now },
  });
  if (claimed.count !== 1) throw new OpsError(409, "The manufacturing order changed concurrently — reload and retry");
  await closeWorkOrders(tx, actor, id, "cancelled", now);
  return reloadMo(tx, actor, id);
}

export interface CompleteMoResult {
  mo: Row;
  /** False when the order was already done (idempotent no-op). */
  completed: boolean;
  stockMoves: number;
  journalEntryIds: string[];
}

/** On hand of the default variant where components are taken from (null = the product's total). */
async function available(tx: Tx, actor: OpsActor, productId: string, locationId: string | null): Promise<number> {
  if (locationId) return onHandAt(tx, actor, productId, defaultVariantId(productId), [locationId]);
  const p = await tx.opsProduct.findFirst({ where: { id: productId, workspaceId: actor.workspaceId }, select: { stockQty: true } });
  return p?.stockQty ?? 0;
}

/**
 * Complete an MO in ONE transaction: claim (confirmed/in_progress → done),
 * stop timers, consume components (consumption rows), produce the finished
 * goods (a production row; scrapped units leave again as a scrap row with an
 * OpsScrap record), cost it, post the WIP + finish entries. A second call on
 * a done order changes nothing and returns completed=false.
 */
export async function completeMo(
  tx: Tx,
  actor: OpsActor,
  id: string,
  input: { producedQty?: number; scrappedQty?: number },
): Promise<CompleteMoResult> {
  const mo = await tx.opsManufacturingOrder.findFirst({ where: { id, workspaceId: actor.workspaceId } });
  if (!mo) throw new OpsNotFoundError("manufacturing-orders", id);
  if (mo.status === "done") return { mo: mo as unknown as Row, completed: false, stockMoves: 0, journalEntryIds: [] };
  assertMoTransition(mo.status, "done");
  const q = completionQuantities({ qty: mo.qty, producedQty: input.producedQty, scrappedQty: input.scrappedQty });
  const now = new Date();
  const claimed = await tx.opsManufacturingOrder.updateMany({
    where: { id, workspaceId: actor.workspaceId, status: { in: ["confirmed", "in_progress"] } },
    data: { status: "done", doneAt: now, producedQty: q.producedQty, scrappedQty: q.scrappedQty, ...(mo.startedAt ? {} : { startedAt: now }) },
  });
  if (claimed.count !== 1) {
    const again = await tx.opsManufacturingOrder.findFirst({ where: { id, workspaceId: actor.workspaceId } });
    if (again?.status === "done") return { mo: again as unknown as Row, completed: false, stockMoves: 0, journalEntryIds: [] };
    throw new OpsError(409, "The manufacturing order changed concurrently — reload and retry");
  }
  const label = mo.number ?? id;
  await closeWorkOrders(tx, actor, id, "done", now);

  // Components: availability first (an approved completion still refuses to
  // drive stock negative), then one consumption row per stocked component.
  const lines = consumption((mo.components ?? []) as unknown as MoComponent[], q.unitsStarted);
  const shortages: string[] = [];
  for (const l of lines) {
    if (!l.stocked || !l.productId || l.consumedQty <= 0) continue;
    const have = await available(tx, actor, l.productId, mo.componentLocationId);
    if (have < l.consumedQty) shortages.push(`${l.name}: ${l.consumedQty} needed, ${have} on hand`);
  }
  if (shortages.length) throw new OpsError(409, `Not enough components to complete ${label} — ${shortages.join("; ")}`);
  let stockMoves = 0;
  const actorName = `mo:${label}`;
  for (const l of lines) {
    if (!l.stocked || !l.productId || l.consumedQty <= 0) continue;
    await recordInventoryTxn(tx, actor, { productId: l.productId, delta: -l.consumedQty, reason: "consumption", locationId: mo.componentLocationId, note: `consumed by ${label}`, actorName });
    stockMoves += 1;
  }
  await recordInventoryTxn(tx, actor, { productId: mo.productId, variantId: mo.variantId, delta: q.unitsStarted, reason: "production", locationId: mo.finishedLocationId, note: `produced by ${label}`, actorName });
  stockMoves += 1;

  // Costing: components + labour (logged time × work-centre rate).
  const wos = await tx.opsWorkOrder.findMany({ where: { workspaceId: actor.workspaceId, moId: id }, include: { workCenter: { select: { hourlyCostCents: true } } } });
  const cost = moCosting(lines, wos.map((w) => ({ actualSeconds: w.actualSeconds, hourlyCostCents: w.workCenter.hourlyCostCents })), q.producedQty, q.scrappedQty);

  let scrapId: string | null = null;
  if (q.scrappedQty > 0) {
    const txn = await recordInventoryTxn(tx, actor, { productId: mo.productId, variantId: mo.variantId, delta: -q.scrappedQty, reason: "scrap", locationId: mo.finishedLocationId, note: `scrapped in ${label}`, actorName });
    stockMoves += 1;
    const scrap = await tx.opsScrap.create({
      data: {
        workspaceId: actor.workspaceId,
        productId: mo.productId,
        variantId: mo.variantId,
        qty: q.scrappedQty,
        locationId: mo.finishedLocationId,
        moId: id,
        reason: "Scrapped during production",
        unitCostCents: q.scrappedQty ? Math.floor(cost.scrapCostCents / q.scrappedQty) : 0,
        totalCostCents: cost.scrapCostCents,
        inventoryTxnId: String(txn.id),
        createdBy: actor.userId,
      },
    });
    scrapId = scrap.id;
  }

  const journalEntryIds: string[] = [];
  if (hasFinanceLedger(tx)) {
    const posted = await postMoCompletion(tx, actor, { id, number: mo.number, doneAt: now }, cost);
    for (const p of [posted.wip, posted.finish]) if (p) journalEntryIds.push(p.entry.id);
    if (scrapId && posted.finish) await tx.opsScrap.update({ where: { id: scrapId }, data: { journalEntryId: posted.finish.entry.id } });
  }
  await tx.opsManufacturingOrder.update({
    where: { id },
    data: {
      components: lines.map(({ costCents: _c, ...c }) => c) as unknown as Prisma.InputJsonValue,
      componentCostCents: cost.componentCostCents,
      labourCostCents: cost.labourCostCents,
      scrapCostCents: cost.scrapCostCents,
      finishedCostCents: cost.finishedCostCents,
    },
  });
  await auditOpsEvent(
    tx,
    def("manufacturing-orders"),
    actor,
    "complete",
    id,
    `${label} done: produced ${q.producedQty}${q.scrappedQty ? `, scrapped ${q.scrappedQty}` : ""}; ${stockMoves} stock move(s); cost ${cost.componentCostCents}c components + ${cost.labourCostCents}c labour${journalEntryIds.length ? `; journal ${journalEntryIds.join(", ")}` : ""}`,
  );
  return { mo: await reloadMo(tx, actor, id), completed: true, stockMoves, journalEntryIds };
}

// ---------------------------------------------------------------------------
// Work orders + time logs
// ---------------------------------------------------------------------------

async function openMoOf(tx: Tx, actor: OpsActor, moId: string) {
  const mo = await tx.opsManufacturingOrder.findFirst({ where: { id: moId, workspaceId: actor.workspaceId } });
  if (!mo) throw new OpsNotFoundError("manufacturing-orders", moId);
  if (mo.status !== "confirmed" && mo.status !== "in_progress") {
    throw new OpsError(409, `Work can only be logged on a confirmed or in-progress order (${mo.number ?? mo.id} is ${mo.status.replace("_", " ")})`);
  }
  return mo;
}

/** Hook for PATCH /api/ops/work-orders: start / pause / finish / cancel the timer. */
export async function patchWorkOrder(tx: Tx, actor: OpsActor, id: string, patch: Row, existing: Row): Promise<Row> {
  const to = patch.status as "in_progress" | "paused" | "done" | "cancelled" | undefined;
  if (!to) throw new OpsError(400, "Send a status: in_progress (start), paused, done or cancelled");
  const mo = await openMoOf(tx, actor, String(existing.moId));
  const now = new Date();
  if (to === "in_progress") {
    const wc = await tx.opsWorkCenter.findFirst({ where: { id: String(existing.workCenterId), workspaceId: actor.workspaceId } });
    const running = await tx.opsWorkOrder.count({ where: { workspaceId: actor.workspaceId, workCenterId: String(existing.workCenterId), status: "in_progress", NOT: { id } } });
    if (wc && !hasCapacity(wc.capacity, running)) {
      throw new OpsError(409, `${wc.name} is at capacity (${wc.capacity} running) — pause or finish another work order first`);
    }
  }
  const step = timerStep(
    { status: String(existing.status), runningSince: (existing.runningSince as Date | null) ?? null, actualSeconds: Number(existing.actualSeconds ?? 0) },
    to,
    now,
  );
  const claimed = await tx.opsWorkOrder.updateMany({
    where: { id, workspaceId: actor.workspaceId, status: existing.status as "pending" },
    data: {
      status: step.status as "in_progress",
      runningSince: step.runningSince,
      actualSeconds: step.actualSeconds,
      ...(to === "in_progress" && !existing.startedAt ? { startedAt: now } : {}),
      ...(to === "done" ? { finishedAt: now } : {}),
    },
  });
  if (claimed.count !== 1) throw new OpsError(409, "The work order changed concurrently — reload and retry");
  if (step.segment) {
    await tx.opsWorkTimeLog.create({
      data: { workspaceId: actor.workspaceId, workOrderId: id, userId: actor.userId, startedAt: step.segment.startedAt, endedAt: step.segment.endedAt, seconds: step.segment.seconds, source: "timer" },
    });
  }
  // Starting the first step starts the order.
  if (to === "in_progress" && mo.status === "confirmed") {
    await tx.opsManufacturingOrder.updateMany({ where: { id: mo.id, workspaceId: actor.workspaceId, status: "confirmed" }, data: { status: "in_progress", startedAt: now } });
  }
  return (await tx.opsWorkOrder.findFirst({ where: { id, workspaceId: actor.workspaceId } })) as unknown as Row;
}

export async function createWorkOrderRow(): Promise<Row> {
  throw new OpsError(405, "Work orders are created when a manufacturing order is confirmed (one per routing step)");
}

/** Manual time entry (append-only); adds to the work order's actual time. */
export async function createTimeLogRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const workOrderId = String(body.workOrderId);
  const wo = await tx.opsWorkOrder.findFirst({ where: { id: workOrderId, workspaceId: actor.workspaceId } });
  if (!wo) throw new OpsNotFoundError("work-orders", workOrderId);
  if (wo.status === "cancelled") throw new OpsError(409, "That work order was cancelled");
  await openMoOf(tx, actor, wo.moId);
  const seconds = Math.round(Number(body.minutes) * 60);
  const endedAt = (body.endedAt as Date | undefined) ?? new Date();
  const startedAt = new Date(endedAt.getTime() - seconds * 1000);
  const log = await tx.opsWorkTimeLog.create({
    data: { workspaceId: actor.workspaceId, workOrderId, userId: actor.userId, startedAt, endedAt, seconds, source: "manual", note: str(body.note) },
  });
  await tx.opsWorkOrder.update({ where: { id: workOrderId }, data: { actualSeconds: { increment: seconds } } });
  return log as unknown as Row;
}

// ---------------------------------------------------------------------------
// Scrap (gated create)
// ---------------------------------------------------------------------------

/**
 * Write stock off: availability at the location, one "scrap" ledger row,
 * the OpsScrap record, then Dr Scrap loss / Cr stock at the unit cost (the
 * given cost, else the product's last manufactured unit cost).
 */
export async function createScrapRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const productId = String(body.productId);
  const product = await mustProduct(tx, actor, productId);
  if (!product.trackInventory) throw new OpsError(422, `"${product.name}" does not track inventory`);
  await mustVariantOf(tx, actor, productId, str(body.variantId));
  const locationId = str(body.locationId);
  await mustLocation(tx, actor, locationId);
  const qty = Number(body.qty);
  const variantId = str(body.variantId) ?? defaultVariantId(productId);
  const have = locationId ? await onHandAt(tx, actor, productId, variantId, [locationId]) : product.stockQty;
  if (have < qty) throw new OpsError(409, `Not enough "${product.name}" to scrap: ${qty} asked, ${have} on hand`);
  let unitCostCents = typeof body.unitCostCents === "number" ? body.unitCostCents : null;
  let from: "inventory" | "finished_goods" = "inventory";
  if (unitCostCents === null) {
    const lastMo = await tx.opsManufacturingOrder.findFirst({
      where: { workspaceId: actor.workspaceId, productId, status: "done", producedQty: { gt: 0 } },
      orderBy: { doneAt: "desc" },
      select: { finishedCostCents: true, producedQty: true },
    });
    unitCostCents = lastMo ? Math.round(lastMo.finishedCostCents / lastMo.producedQty) : 0;
    if (lastMo) from = "finished_goods";
  }
  const totalCostCents = unitCostCents * qty;
  if (totalCostCents > 2_147_483_647) throw new OpsError(400, "Scrap value exceeds the maximum amount");
  const txn = await recordInventoryTxn(tx, actor, { productId, variantId: str(body.variantId), delta: -qty, reason: "scrap", locationId, note: `scrap: ${String(body.reason)}` });
  const scrap = await tx.opsScrap.create({
    data: {
      workspaceId: actor.workspaceId,
      productId,
      variantId: str(body.variantId),
      qty,
      locationId,
      reason: String(body.reason).trim(),
      unitCostCents,
      totalCostCents,
      inventoryTxnId: String(txn.id),
      createdBy: actor.userId,
    },
  });
  if (hasFinanceLedger(tx)) {
    const posted = await postScrap(tx, actor, { id: scrap.id, totalCostCents, createdAt: scrap.createdAt, label: `${qty} × ${product.sku} (${scrap.reason})`, from });
    if (posted) return (await tx.opsScrap.update({ where: { id: scrap.id }, data: { journalEntryId: posted.entry.id } })) as unknown as Row;
  }
  return scrap as unknown as Row;
}

// ---------------------------------------------------------------------------
// Read model for the page and the agent tools
// ---------------------------------------------------------------------------

export interface MoView {
  id: string;
  number: string | null;
  status: string;
  productId: string;
  productName: string;
  productSku: string;
  qty: number;
  producedQty: number;
  scrappedQty: number;
  plannedStart: Date | null;
  plannedCostCents: number | null;
  componentCostCents: number;
  labourCostCents: number;
  finishedCostCents: number;
  scrapCostCents: number;
  workOrders: { total: number; done: number; running: number };
  createdAt: Date;
}

export async function listMos(tx: Tx, workspaceId: string, opts: { status?: string; limit?: number } = {}): Promise<MoView[]> {
  const rows = await tx.opsManufacturingOrder.findMany({
    where: { workspaceId, ...(opts.status ? { status: opts.status as "draft" } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
    include: { product: { select: { name: true, sku: true } }, workOrders: { select: { status: true } } },
  });
  return rows.map((m) => ({
    id: m.id,
    number: m.number,
    status: m.status,
    productId: m.productId,
    productName: m.product.name,
    productSku: m.product.sku,
    qty: m.qty,
    producedQty: m.producedQty,
    scrappedQty: m.scrappedQty,
    plannedStart: m.plannedStart,
    plannedCostCents: m.plannedCostCents,
    componentCostCents: m.componentCostCents,
    labourCostCents: m.labourCostCents,
    finishedCostCents: m.finishedCostCents,
    scrapCostCents: m.scrapCostCents,
    workOrders: {
      total: m.workOrders.length,
      done: m.workOrders.filter((w) => w.status === "done").length,
      running: m.workOrders.filter((w) => w.status === "in_progress").length,
    },
    createdAt: m.createdAt,
  }));
}
