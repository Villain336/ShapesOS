// ShapesOS Phase 12 (mfgpos): manufacturing on real Postgres, as the
// least-privilege app role — the CAD BOM drives the components (through the
// CAD part ↔ product link), confirm and complete are gated, completion
// consumes and produces through the stock ledger in one transaction (the
// ledger still balances; a second completion is a no-op), costing posts
// balanced WIP/finish entries, scrap writes stock and value off, and every
// new table is FORCE RLS.
//   DATABASE_URL=<app role url> npx tsx --test lib/ops/__tests__/p12-mfg-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { OpsError, opsCreate, opsPatch, type OpsActor } from "../doctype";
import { opsBindingFor } from "../gate";
import { completeMo, linkCadPart, productBom } from "../mfg/service";
import { __setOpsToolsTestGatePort } from "@/lib/chat/ops-tools";
import {
  completeManufacturingOrderCore,
  confirmManufacturingOrderCore,
  createManufacturingOrderCore,
  listManufacturingOrdersCore,
  logWorkTimeCore,
} from "@/lib/chat/ops-mfgpos-tools";

const WS = "p12mfg-ws-a";
const WS_B = "p12mfg-ws-b";
const A: OpsActor = { workspaceId: WS, userId: "user-p12mfg" };
const def = (slug: string) => OPS_ENTITY_MAP[slug]!;
const inA = <T>(fn: Parameters<typeof withWorkspaceScope<T>>[1]) => withWorkspaceScope(WS, fn);
const rowOf = (r: unknown) => (r as { row: Record<string, unknown> }).row;

async function create(slug: string, body: Record<string, unknown>) {
  const r = await inA((tx) => opsCreate(tx, def(slug), A, body));
  assert.equal(r.outcome, "done", `${slug} create should be free`);
  return rowOf(r);
}

async function approved(slug: string, binding: Parameters<typeof opsBindingFor>[0]): Promise<string> {
  const row = await inA((tx) =>
    tx.composioActionApproval.create({
      data: { workspaceId: WS, appKey: "ops", toolName: slug, riskTier: "medium", proposedArgs: opsBindingFor(binding) as object, plainSummary: "test", status: "approved", expiresAt: new Date(Date.now() + 3600_000) },
    }),
  );
  return row.id;
}

/** PATCH a gated MO move with a real approved approval bound to exactly that mutation. */
async function gatedMoPatch(id: string, patch: Record<string, unknown>, slug: string) {
  const approvalId = await approved(slug, { entity: "manufacturing-orders", entityId: id, slug, mutation: { id, ...patch } });
  return inA((tx) => opsPatch(tx, def("manufacturing-orders"), A, { id, ...patch, approvalId }));
}

const stockOf = (productId: string) => inA((tx) => tx.opsProduct.findFirstOrThrow({ where: { id: productId } })).then((p) => p.stockQty);
const ledgerSum = (productId: string) =>
  inA((tx) => tx.opsInventoryTxn.aggregate({ where: { productId }, _sum: { delta: true } })).then((a) => a._sum.delta ?? 0);
const atLocation = (productId: string, locationId: string) =>
  inA((tx) => tx.opsInventoryTxn.aggregate({ where: { productId, locationId }, _sum: { delta: true } })).then((a) => a._sum.delta ?? 0);

let chair = "";
let leg = "";
let seat = "";
let raw = "";
let fg = "";
let wc = "";
let routing = "";
let bom = "";
let partLeg = "";
let partSeat = "";
let moId = "";

before(async () => {
  for (const id of [WS, WS_B]) {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
    await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${id}, ${"test:" + id}, now())`;
  }
  chair = String((await create("products", { name: "Chair", sku: "CHAIR", priceCents: 9900 })).id);
  leg = String((await create("products", { name: "Leg", sku: "LEG", priceCents: 300 })).id);
  seat = String((await create("products", { name: "Seat", sku: "SEAT", priceCents: 1500 })).id);
  const wh = await create("warehouses", { name: "Plant", code: "PL-1" });
  const zone = await create("locations", { warehouseId: wh.id, kind: "zone", code: "Z" });
  raw = String((await create("locations", { warehouseId: wh.id, parentId: zone.id, kind: "bin", code: "RAW" })).id);
  fg = String((await create("locations", { warehouseId: wh.id, parentId: zone.id, kind: "bin", code: "FG" })).id);
  await create("inventory-txns", { productId: leg, delta: 40, reason: "restock", locationId: raw });
  await create("inventory-txns", { productId: seat, delta: 10, reason: "restock", locationId: raw });

  // The CAD side: a model version with a BOM revision (2 linked parts + 1 unlinked consumable) and a cost estimate.
  const ids = await inA(async (tx) => {
    const project = await tx.cadProject.create({ data: { workspaceId: WS, name: "Chair project" } });
    const model = await tx.cadModel.create({ data: { workspaceId: WS, projectId: project.id, name: "Chair v1" } });
    const file = await tx.workspaceFile.create({
      data: { workspaceId: WS, logicalPath: "/cad/chair.stl", storageKey: `p12mfg-${Date.now()}`, filename: "chair.stl", mimeType: "model/stl", sizeBytes: 10, kind: "file", createdBy: A.userId },
    });
    const version = await tx.cadModelVersion.create({
      data: { workspaceId: WS, modelId: model.id, versionNumber: 1, workspaceFileId: file.id, fileName: "chair.stl", sizeBytes: 10, checksum: "x", format: "stl", previewAvailable: false, uploadedBy: A.userId },
    });
    const pLeg = await tx.cadPart.create({ data: { workspaceId: WS, name: "Leg", sku: "P-LEG" } });
    const pSeat = await tx.cadPart.create({ data: { workspaceId: WS, name: "Seat", sku: "P-SEAT" } });
    const b = await tx.cadBomVersion.create({ data: { workspaceId: WS, modelId: model.id, modelVersionId: version.id, bomNumber: 1, createdBy: A.userId } });
    await tx.cadBomLine.createMany({
      data: [
        { workspaceId: WS, bomVersionId: b.id, partName: "Leg", qty: 4, unitCostUsd: 2.5, inventoryPartId: pLeg.id, sortOrder: 1 },
        { workspaceId: WS, bomVersionId: b.id, partName: "Seat", qty: 1, unitCostUsd: 10, inventoryPartId: pSeat.id, sortOrder: 2 },
        { workspaceId: WS, bomVersionId: b.id, partName: "Glue", qty: 0.5, unitCostUsd: 1, sortOrder: 3 },
      ],
    });
    const card = await tx.cadRateCard.create({ data: { workspaceId: WS, name: "Shop", process: "cnc" } });
    await tx.cadCostEstimate.create({
      data: { workspaceId: WS, modelVersionId: version.id, bomVersionId: b.id, rateCardId: card.id, quantity: 10, bomTotalUsd: 150, processCostUsd: 100, grandTotalUsd: 250, perUnitUsd: 25, basis: {}, createdBy: A.userId },
    });
    return { bom: b.id, pLeg: pLeg.id, pSeat: pSeat.id };
  });
  bom = ids.bom;
  partLeg = ids.pLeg;
  partSeat = ids.pSeat;
  wc = String((await create("work-centers", { name: "Bench", code: "BENCH-1", capacity: 1, hourlyCostCents: 6000 })).id);
  routing = String(
    (
      await create("routings", {
        productId: chair,
        name: "Chair assembly",
        bomVersionId: bom,
        operations: [
          { sequence: 20, name: "Assemble", workCenterId: wc, plannedMinutes: 5 },
          { sequence: 10, name: "Cut", workCenterId: wc, plannedMinutes: 10 },
        ],
      })
    ).id,
  );
});

after(async () => {
  for (const id of [WS, WS_B]) await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$disconnect();
});

describe("p12 manufacturing (real Postgres, app role)", () => {
  it("the product BOM is derived from the CAD BOM through the CAD part ↔ product link", async () => {
    await inA((tx) => linkCadPart(tx, A, partLeg, leg));
    await inA((tx) => linkCadPart(tx, A, partSeat, seat));
    const view = await inA((tx) => productBom(tx, WS, chair));
    assert.equal(view.routingId, routing);
    assert.equal(view.bomVersionId, bom);
    assert.deepEqual(view.components.map((c) => [c.name, c.productId, c.qtyPerUnit, c.unitCostCents, c.stocked]), [
      ["Leg", leg, 4, 250, true],
      ["Seat", seat, 1, 1000, true],
      ["Glue", null, 0.5, 100, false],
    ]);
    assert.equal(view.unlinked, 1);
    assert.deepEqual(view.operations.map((o) => o.name), ["Cut", "Assemble"], "routing steps in sequence order");
    await assert.rejects(inA((tx) => linkCadPart(tx, A, partLeg, "no-such-product")), (e: unknown) => e instanceof OpsError && e.status === 404);
  });

  it("a routing refuses a duplicate step sequence or another workspace's work centre", async () => {
    await assert.rejects(
      inA((tx) => opsCreate(tx, def("routings"), A, { productId: chair, name: "bad", operations: [{ sequence: 1, name: "a", workCenterId: wc, plannedMinutes: 1 }, { sequence: 1, name: "b", workCenterId: wc, plannedMinutes: 1 }] })),
      (e: unknown) => e instanceof OpsError && e.status === 422,
    );
    await assert.rejects(
      inA((tx) => opsCreate(tx, def("routings"), A, { productId: chair, name: "bad", operations: [{ sequence: 1, name: "a", workCenterId: "wc-elsewhere", plannedMinutes: 1 }] })),
      (e: unknown) => e instanceof OpsError && e.status === 404,
    );
  });

  it("a draft MO picks the active routing and its BOM; confirm is gated, then snapshots components and work orders", async () => {
    const mo = await create("manufacturing-orders", { productId: chair, qty: 5, componentLocationId: raw, finishedLocationId: fg });
    moId = String(mo.id);
    assert.equal(mo.status, "draft");
    assert.equal(mo.routingId, routing);
    assert.equal(mo.bomVersionId, bom);
    assert.equal(mo.number, null, "drafts have no number");

    const proposed = await inA((tx) => opsPatch(tx, def("manufacturing-orders"), A, { id: moId, status: "confirmed" }, { gatePort: { propose: async () => ({ id: "appr_x", status: "pending", riskTier: "medium" }), getApproval: async () => { throw new Error("unused"); } } }));
    assert.equal(proposed.outcome, "approval_required");
    assert.equal((await inA((tx) => tx.opsManufacturingOrder.findFirstOrThrow({ where: { id: moId } }))).status, "draft", "nothing moved without approval");

    const done = await gatedMoPatch(moId, { status: "confirmed" }, "OPS_MO_CONFIRM");
    assert.equal(done.outcome, "done");
    const row = rowOf(done);
    assert.equal(row.status, "confirmed");
    assert.match(String(row.number), /^MO-\d{4}$/);
    assert.equal((row.components as unknown[]).length, 3);
    assert.equal(row.plannedCostCents, 12_500, "planned cost = the CAD estimate's $25/unit × 5 (labelled estimate)");
    const wos = await inA((tx) => tx.opsWorkOrder.findMany({ where: { moId }, orderBy: { sequence: "asc" } }));
    assert.deepEqual(wos.map((w) => [w.sequence, w.name, w.plannedMinutes]), [[10, "Cut", 50], [20, "Assemble", 25]]);
    // A replayed approval can't confirm twice.
    await assert.rejects(gatedMoPatch(moId, { status: "confirmed" }, "OPS_MO_CONFIRM"), (e: unknown) => e instanceof OpsError && e.status === 409);
  });

  it("work orders: the timer starts the MO, capacity caps the bench, time is logged (append-only)", async () => {
    const [cut, asm] = await inA((tx) => tx.opsWorkOrder.findMany({ where: { moId }, orderBy: { sequence: "asc" } }));
    const started = await inA((tx) => opsPatch(tx, def("work-orders"), A, { id: cut!.id, status: "in_progress" }));
    assert.equal(rowOf(started).status, "in_progress");
    assert.equal((await inA((tx) => tx.opsManufacturingOrder.findFirstOrThrow({ where: { id: moId } }))).status, "in_progress", "the first step starts the order");
    await assert.rejects(
      inA((tx) => opsPatch(tx, def("work-orders"), A, { id: asm!.id, status: "in_progress" })),
      (e: unknown) => e instanceof OpsError && e.status === 409 && /capacity/.test(e.message),
    );
    const log = await create("work-time-logs", { workOrderId: cut!.id, minutes: 60, note: "cutting" });
    assert.equal(log.seconds, 3600);
    await inA((tx) => opsPatch(tx, def("work-orders"), A, { id: cut!.id, status: "paused" }));
    const logs = await inA((tx) => tx.opsWorkTimeLog.findMany({ where: { workOrderId: cut!.id } }));
    assert.equal(logs.length, 2, "manual entry + the timer segment");
    const w = await inA((tx) => tx.opsWorkOrder.findFirstOrThrow({ where: { id: cut!.id } }));
    assert.equal(w.actualSeconds, logs.reduce((s, l) => s + l.seconds, 0));
    await assert.rejects(
      inA((tx) => tx.$executeRaw`UPDATE ops_work_time_logs SET seconds = 1 WHERE id = ${String(log.id)}`),
      /append-only/,
    );
    await assert.rejects(inA((tx) => opsCreate(tx, def("work-orders"), A, { moId })), (e: unknown) => e instanceof OpsError && e.status === 405);
  });

  it("completion (gated) consumes, produces and scraps through the ledger in one go; the ledger balances", async () => {
    const before = { leg: await stockOf(leg), seat: await stockOf(seat), chair: await stockOf(chair) };
    const r = await gatedMoPatch(moId, { status: "done", producedQty: 4, scrappedQty: 1 }, "OPS_MO_COMPLETE");
    assert.equal(r.outcome, "done");
    const mo = rowOf(r);
    assert.equal(mo.status, "done");
    assert.equal(mo.producedQty, 4);
    assert.equal(mo.scrappedQty, 1);
    // 5 units started: 20 legs, 5 seats consumed; 5 made, 1 scrapped.
    assert.equal(await stockOf(leg), before.leg - 20);
    assert.equal(await stockOf(seat), before.seat - 5);
    assert.equal(await stockOf(chair), before.chair + 4);
    assert.equal(await atLocation(leg, raw), 20);
    assert.equal(await atLocation(chair, fg), 4);
    for (const p of [leg, seat, chair]) assert.equal(await ledgerSum(p), await stockOf(p), "stock total = Σ ledger");
    const reasons = await inA((tx) => tx.opsInventoryTxn.groupBy({ by: ["reason"], where: { note: { contains: String(mo.number) } }, _sum: { delta: true } }));
    const by = Object.fromEntries(reasons.map((g) => [g.reason, g._sum.delta]));
    assert.deepEqual(by, { consumption: -25, production: 5, scrap: -1 });
    const scrap = await inA((tx) => tx.opsScrap.findFirstOrThrow({ where: { moId } }));
    assert.equal(scrap.qty, 1);
    // Work orders closed; costing = components + labour.
    const wos = await inA((tx) => tx.opsWorkOrder.findMany({ where: { moId } }));
    assert.ok(wos.every((w) => w.status === "done" && w.runningSince === null));
    assert.equal(mo.componentCostCents, 20 * 250 + 5 * 1000 + 3 * 100, "glue: ceil(0.5 × 5) = 3 units at $1");
    const labourSeconds = wos.reduce((s, w) => s + w.actualSeconds, 0);
    assert.equal(mo.labourCostCents, Math.floor((2 * labourSeconds * 6000 + 3600) / 7200));
    assert.equal(Number(mo.finishedCostCents) + Number(mo.scrapCostCents), Number(mo.componentCostCents) + Number(mo.labourCostCents));
  });

  it("costing posts two balanced entries keyed to the MO; WIP nets to zero", async () => {
    const entries = await inA((tx) => tx.opsJournalEntry.findMany({ where: { sourceType: "manufacturing_order", sourceId: moId }, include: { lines: { include: { account: true } } } }));
    assert.deepEqual(entries.map((e) => e.sourceKey).sort(), [`mo:${moId}:finish`, `mo:${moId}:wip`]);
    for (const e of entries) {
      const d = e.lines.reduce((s, l) => s + l.debitCents, 0);
      const c = e.lines.reduce((s, l) => s + l.creditCents, 0);
      assert.equal(d, c, `${e.sourceKey} balances`);
    }
    const all = entries.flatMap((e) => e.lines);
    const net = (key: string) => all.filter((l) => l.account.systemKey === key).reduce((s, l) => s + l.debitCents - l.creditCents, 0);
    const mo = await inA((tx) => tx.opsManufacturingOrder.findFirstOrThrow({ where: { id: moId } }));
    assert.equal(net("wip"), 0);
    assert.equal(net("inventory"), -mo.componentCostCents);
    assert.equal(net("labour_absorbed"), -mo.labourCostCents);
    assert.equal(net("finished_goods"), mo.finishedCostCents);
    assert.equal(net("scrap_loss"), mo.scrapCostCents);
    const scrap = await inA((tx) => tx.opsScrap.findFirstOrThrow({ where: { moId } }));
    assert.equal(scrap.journalEntryId, entries.find((e) => e.sourceKey?.endsWith(":finish"))!.id);
  });

  it("completing twice is a no-op (and an illegal PATCH)", async () => {
    const txnsBefore = await inA((tx) => tx.opsInventoryTxn.count());
    const jeBefore = await inA((tx) => tx.opsJournalEntry.count());
    const again = await inA((tx) => completeMo(tx, A, moId, { producedQty: 4, scrappedQty: 1 }));
    assert.equal(again.completed, false);
    assert.equal(again.stockMoves, 0);
    await assert.rejects(gatedMoPatch(moId, { status: "done" }, "OPS_MO_COMPLETE"), (e: unknown) => e instanceof OpsError && e.status === 409);
    assert.equal(await inA((tx) => tx.opsInventoryTxn.count()), txnsBefore);
    assert.equal(await inA((tx) => tx.opsJournalEntry.count()), jeBefore);
  });

  it("an approved completion still refuses to drive components negative — and rolls back whole", async () => {
    const big = String((await create("manufacturing-orders", { productId: chair, qty: 50, componentLocationId: raw, finishedLocationId: fg })).id);
    await gatedMoPatch(big, { status: "confirmed" }, "OPS_MO_CONFIRM");
    const legBefore = await stockOf(leg);
    await assert.rejects(gatedMoPatch(big, { status: "done" }, "OPS_MO_COMPLETE"), (e: unknown) => e instanceof OpsError && e.status === 409 && /Not enough components/.test(e.message));
    const after = await inA((tx) => tx.opsManufacturingOrder.findFirstOrThrow({ where: { id: big } }));
    assert.equal(after.status, "confirmed", "the claim rolled back with the refusal");
    assert.equal(await stockOf(leg), legBefore);
    // Cancel is free and moves nothing.
    const c = await inA((tx) => opsPatch(tx, def("manufacturing-orders"), A, { id: big, status: "cancelled" }));
    assert.equal(rowOf(c).status, "cancelled");
    assert.ok((await inA((tx) => tx.opsWorkOrder.findMany({ where: { moId: big } }))).every((w) => w.status === "cancelled"));
  });

  it("scrap is gated, writes a scrap ledger row and posts Dr Scrap loss / Cr Finished goods", async () => {
    const body = { productId: chair, qty: 1, locationId: fg, reason: "Dropped in the yard" };
    const proposed = await inA((tx) => opsCreate(tx, def("scraps"), A, body, { gatePort: { propose: async () => ({ id: "appr_y", status: "pending", riskTier: "medium" }), getApproval: async () => { throw new Error("unused"); } } }));
    assert.equal(proposed.outcome, "approval_required");
    const approvalId = await approved("OPS_SCRAP_POST", { entity: "scraps", slug: "OPS_SCRAP_POST", mutation: body });
    const chairBefore = await stockOf(chair);
    const r = await inA((tx) => opsCreate(tx, def("scraps"), A, { ...body, approvalId }));
    assert.equal(r.outcome, "done");
    const scrap = rowOf(r);
    assert.equal(await stockOf(chair), chairBefore - 1);
    assert.equal(await ledgerSum(chair), await stockOf(chair));
    const mo = await inA((tx) => tx.opsManufacturingOrder.findFirstOrThrow({ where: { id: moId } }));
    assert.equal(scrap.unitCostCents, Math.round(mo.finishedCostCents / mo.producedQty), "valued at the last manufactured unit cost");
    const je = await inA((tx) => tx.opsJournalEntry.findFirstOrThrow({ where: { id: String(scrap.journalEntryId) }, include: { lines: { include: { account: true } } } }));
    assert.deepEqual(
      je.lines.map((l) => [l.account.systemKey, l.debitCents, l.creditCents]).sort(),
      [["finished_goods", 0, Number(scrap.totalCostCents)], ["scrap_loss", Number(scrap.totalCostCents), 0]].sort(),
    );
    await assert.rejects(
      inA((tx) => opsCreate(tx, def("scraps"), A, { productId: chair, qty: 999, locationId: fg, reason: "x", approvalId: "nope" })),
      "an unknown approval never executes",
    );
  });

  it("agent tools: a draft is free; confirm and complete only propose (nothing moves)", async () => {
    __setOpsToolsTestGatePort({ propose: async () => ({ id: "appr_tool", status: "pending", riskTier: "high" }), getApproval: async () => { throw new Error("unused"); } });
    try {
      const draft = await inA((tx) => createManufacturingOrderCore(tx, A, { productId: chair, qty: "1", componentLocationId: raw, finishedLocationId: fg }));
      const id = String((draft.details as { id: string }).id);
      const proposed = await inA((tx) => confirmManufacturingOrderCore(tx, A, { id }));
      assert.equal((proposed.details as { approvalRequired: boolean }).approvalRequired, true);
      assert.equal((await inA((tx) => tx.opsManufacturingOrder.findFirstOrThrow({ where: { id } }))).status, "draft");
      await gatedMoPatch(id, { status: "confirmed" }, "OPS_MO_CONFIRM");
      const [wo] = await inA((tx) => tx.opsWorkOrder.findMany({ where: { moId: id }, orderBy: { sequence: "asc" } }));
      const logged = await inA((tx) => logWorkTimeCore(tx, A, { workOrderId: wo!.id, minutes: "15" }));
      assert.match(logged.summary, /15 min/);
      const legBefore = await stockOf(leg);
      const complete = await inA((tx) => completeManufacturingOrderCore(tx, A, { id, producedQty: "1" }));
      assert.equal((complete.details as { approvalRequired: boolean }).approvalRequired, true);
      assert.equal((await inA((tx) => tx.opsManufacturingOrder.findFirstOrThrow({ where: { id } }))).status, "confirmed");
      assert.equal(await stockOf(leg), legBefore, "a proposal moves no stock");
      const list = await inA((tx) => listManufacturingOrdersCore(tx, A, { status: "confirmed" }));
      assert.ok((list.details as { rows: Array<{ id: string }> }).rows.some((r) => r.id === id));
    } finally {
      __setOpsToolsTestGatePort(null);
    }
  });

  it("RLS: workspace B sees none of A's manufacturing rows; no GUC sees nothing; WITH CHECK blocks cross-tenant inserts", async () => {
    const counts = await withWorkspaceScope(WS_B, async (tx) => [
      await tx.opsWorkCenter.count({ where: { workspaceId: WS } }),
      await tx.opsRouting.count({ where: { workspaceId: WS } }),
      await tx.opsManufacturingOrder.count({ where: { workspaceId: WS } }),
      await tx.opsWorkOrder.count({ where: { workspaceId: WS } }),
      await tx.opsWorkTimeLog.count({ where: { workspaceId: WS } }),
      await tx.opsScrap.count({ where: { workspaceId: WS } }),
    ]);
    assert.deepEqual(counts, [0, 0, 0, 0, 0, 0]);
    for (const t of ["ops_work_centers", "ops_routings", "ops_manufacturing_orders", "ops_work_orders", "ops_work_time_logs", "ops_scraps"]) {
      const n = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM ${t}`);
      assert.equal(Number(n[0]!.n), 0, `${t}: no GUC → zero rows (FORCE RLS)`);
    }
    await assert.rejects(withWorkspaceScope(WS_B, (tx) => tx.opsWorkCenter.create({ data: { workspaceId: WS, name: "x", code: "X" } })));
    // B can't reach A's MO through the service either (404).
    await assert.rejects(
      withWorkspaceScope(WS_B, (tx) => opsPatch(tx, def("manufacturing-orders"), { workspaceId: WS_B, userId: "b" }, { id: moId, status: "cancelled" })),
      (e: unknown) => e instanceof OpsError && e.status === 404,
    );
  });
});
