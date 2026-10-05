// ShapesOS Phase 10 (ops-core): inventory on real Postgres — RLS on the new
// tables, transfers keep the ledger balanced (and book exactly once), PO
// receipts land in a location, the reorder sweep drafts once per breach.
// Run as the least-privilege app role (scripts/test/db-tests.txt):
//   DATABASE_URL=<app role url> npx tsx --test lib/ops/__tests__/p10-inventory-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { OpsError, opsCreate, opsPatch, type OpsActor } from "../doctype";
import { runReorderSweep, stockByLocation } from "../stock";

const WS_A = "p10inv-ws-a";
const WS_B = "p10inv-ws-b";
const A: OpsActor = { workspaceId: WS_A, userId: "user-p10inv" };
const def = (slug: string) => OPS_ENTITY_MAP[slug]!;

async function createWorkspace(id: string) {
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at)
    VALUES (${id}, ${id}, ${"test:" + id}, now()) ON CONFLICT DO NOTHING`;
}

const inA = <T>(fn: Parameters<typeof withWorkspaceScope<T>>[1]) => withWorkspaceScope(WS_A, fn);

async function create(slug: string, body: Record<string, unknown>) {
  const r = await inA((tx) => opsCreate(tx, def(slug), A, body));
  assert.equal(r.outcome, "done");
  return (r as { row: Record<string, unknown> }).row;
}

let productId = "";
let whId = "";
let binA = "";
let binB = "";

before(async () => {
  for (const id of [WS_A, WS_B]) {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
    await createWorkspace(id);
  }
  const p = await create("products", { name: "Widget", sku: "WID-1", priceCents: 500 });
  productId = String(p.id);
  const wh = await create("warehouses", { name: "Main", code: "WH-01" });
  whId = String(wh.id);
  const zone = await create("locations", { warehouseId: whId, kind: "zone", code: "A" });
  binA = String((await create("locations", { warehouseId: whId, parentId: zone.id, kind: "bin", code: "A-01" })).id);
  binB = String((await create("locations", { warehouseId: whId, parentId: zone.id, kind: "bin", code: "A-02" })).id);
  // 10 units restocked into bin A-01.
  await create("inventory-txns", { productId, delta: 10, reason: "restock", locationId: binA });
});

after(async () => {
  for (const id of [WS_A, WS_B]) await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$disconnect();
});

describe("p10 inventory (real Postgres, app role)", () => {
  it("locations carry the warehouse path; bins cannot hold children", async () => {
    const loc = await inA((tx) => tx.opsLocation.findFirst({ where: { id: binA } }));
    assert.equal(loc?.path, "WH-01/A/A-01");
    await assert.rejects(
      inA((tx) => opsCreate(tx, def("locations"), A, { warehouseId: whId, parentId: binA, kind: "bin", code: "X" })),
      (e: unknown) => e instanceof OpsError && e.status === 422,
    );
  });

  it("the first stock move materializes the product's default variant", async () => {
    const v = await inA((tx) => tx.opsProductVariant.findMany({ where: { productId } }));
    assert.equal(v.length, 1);
    assert.equal(v[0]!.id, `pvd_${productId}`);
    assert.equal(v[0]!.isDefault, true);
    const txns = await inA((tx) => tx.opsInventoryTxn.findMany({ where: { productId } }));
    assert.ok(txns.every((t) => t.variantId === `pvd_${productId}`));
  });

  it("RLS: workspace B sees none of A's inventory rows; no GUC sees nothing", async () => {
    const counts = await withWorkspaceScope(WS_B, async (tx) => [
      await tx.opsWarehouse.count({ where: { workspaceId: WS_A } }),
      await tx.opsLocation.count({ where: { workspaceId: WS_A } }),
      await tx.opsProductVariant.count({ where: { workspaceId: WS_A } }),
      await tx.opsTransfer.count({ where: { workspaceId: WS_A } }),
      await tx.opsReorderRule.count({ where: { workspaceId: WS_A } }),
    ]);
    assert.deepEqual(counts, [0, 0, 0, 0, 0]);
    const raw = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM ops_locations`;
    assert.equal(Number(raw[0]!.n), 0, "no GUC → zero rows (FORCE RLS)");
    await assert.rejects(
      withWorkspaceScope(WS_B, (tx) =>
        tx.opsWarehouse.create({ data: { workspaceId: WS_A, name: "x", code: "X" } }),
      ),
      "WITH CHECK blocks cross-tenant inserts",
    );
  });

  it("transfer done books paired legs once and keeps the product total", async () => {
    const t = await create("transfers", { fromLocationId: binA, toLocationId: binB, lines: [{ productId, qty: 4 }] });
    const before = await inA((tx) => tx.opsProduct.findFirst({ where: { id: productId } }));
    const done = await inA((tx) => opsPatch(tx, def("transfers"), A, { id: t.id, status: "done" }));
    assert.equal(done.outcome, "done");
    // A second "done" is an illegal transition (409), nothing books twice.
    await assert.rejects(
      inA((tx) => opsPatch(tx, def("transfers"), A, { id: t.id, status: "done" })),
      (e: unknown) => e instanceof OpsError && e.status === 409,
    );
    const legs = await inA((tx) => tx.opsInventoryTxn.findMany({ where: { transferId: String(t.id) } }));
    assert.equal(legs.length, 2);
    assert.equal(legs.reduce((s, l) => s + l.delta, 0), 0);
    const afterP = await inA((tx) => tx.opsProduct.findFirst({ where: { id: productId } }));
    assert.equal(afterP!.stockQty, before!.stockQty, "product total unchanged");
    const stock = await inA((tx) => stockByLocation(tx, A, { warehouseId: whId }));
    assert.equal(stock.find((s) => s.locationId === binA)?.qty, 6);
    assert.equal(stock.find((s) => s.locationId === binB)?.qty, 4);
  });

  it("a transfer larger than the source stock is refused and books nothing", async () => {
    const t = await create("transfers", { fromLocationId: binB, toLocationId: binA, lines: [{ productId, qty: 99 }] });
    await assert.rejects(
      inA((tx) => opsPatch(tx, def("transfers"), A, { id: t.id, status: "done" })),
      (e: unknown) => e instanceof OpsError && e.status === 409,
    );
    const row = await inA((tx) => tx.opsTransfer.findFirst({ where: { id: String(t.id) } }));
    assert.equal(row?.status, "draft", "the claim rolled back with the refusal");
    const legs = await inA((tx) => tx.opsInventoryTxn.count({ where: { transferId: String(t.id) } }));
    assert.equal(legs, 0);
  });

  it("reorder sweep drafts one PO per breach, re-arms after receipt", async () => {
    await create("reorder-rules", { productId, warehouseId: whId, receiveLocationId: binB, minQty: 12, maxQty: 30, supplierName: "Acme", unitCostCents: 200 });
    const first = await inA((tx) => runReorderSweep(tx, A));
    assert.equal(first.drafted.length, 1);
    assert.equal(first.drafted[0]!.qty, 20, "30 − 10 on hand");
    const second = await inA((tx) => runReorderSweep(tx, A));
    assert.equal(second.drafted.length, 0, "an open draft blocks a second draft");
    const poId = first.drafted[0]!.purchaseOrderId;
    const po = await inA((tx) => tx.opsPurchaseOrder.findFirst({ where: { id: poId } }));
    assert.equal(po?.status, "draft", "drafts only — never sent");
    assert.equal(po?.totalCents, 20 * 200);
    // Receive it (sent → received is the real path; set sent directly here —
    // the send gate is covered by the Phase 17 suites).
    await inA((tx) => tx.opsPurchaseOrder.update({ where: { id: poId }, data: { status: "sent" } }));
    const recv = await inA((tx) => opsPatch(tx, def("purchase-orders"), A, { id: poId, status: "received" }));
    assert.equal(recv.outcome, "done");
    const stock = await inA((tx) => stockByLocation(tx, A, { locationId: binB }));
    assert.equal(stock[0]?.qty, 24, "4 transferred + 20 received into the rule's bin");
    const third = await inA((tx) => runReorderSweep(tx, A));
    assert.equal(third.drafted.length, 0, "30 on hand is above the minimum");
  });
});
