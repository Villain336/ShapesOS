// ShapesOS — Phase 10 (finance): purchasing on real Postgres (app role).
//   - vendor backfill target + vendor-linked PO through the generic route
//   - RFQ → draft → sent (gated) → partial receipts restock exactly the
//     received quantity; the generic "received" move restocks only the rest
//   - concurrent receipts can't over-receive (row lock)
//   - bill from PO → open posts Dr Expense / Cr AP (BILL-0001) → pay (gated
//     OPS_BILL_PAY) partially then fully, Dr AP / Cr Cash
// Run (DB suite): DATABASE_URL=… npx tsx --test lib/ops/__tests__/finance-purchasing-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { opsCreate, opsPatch, type OpsActor } from "../doctype";
import { opsBindingFor, phase14GatePort, type OpsGatePort } from "../gate";
import { findEntryBySource } from "../accounting";
import { billFromPurchaseOrder, payBill, receivePurchaseOrder } from "../finance/purchasing";
import { runGated } from "../finance/gated";

const WS = "p10fin-pur";
const ACTOR: OpsActor = { workspaceId: WS, userId: "user_p10fin" };
const POS = OPS_ENTITY_MAP["purchase-orders"]!;
const VENDORS = OPS_ENTITY_MAP["vendors"]!;
const BILLS = OPS_ENTITY_MAP["vendor-bills"]!;
const proposeOnly: OpsGatePort = { ...phase14GatePort, propose: async () => ({ id: "appr_pending", status: "pending", riskTier: "medium" }) };

async function approved(slug: string, binding: Parameters<typeof opsBindingFor>[0]): Promise<string> {
  const row = await withWorkspaceScope(WS, (tx) =>
    tx.composioActionApproval.create({
      data: { workspaceId: WS, appKey: "ops", toolName: slug, riskTier: "medium", proposedArgs: opsBindingFor(binding) as object, plainSummary: "t", status: "approved", expiresAt: new Date(Date.now() + 3600_000) },
    }),
  );
  return row.id;
}
const rowOf = (r: unknown) => (r as { row: Record<string, unknown> }).row;
const stock = (id: string) => withWorkspaceScope(WS, (tx) => tx.opsProduct.findFirstOrThrow({ where: { id } })).then((p) => p.stockQty);

let productId = "";
let vendorId = "";

before(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${WS}, ${WS}, ${"test:" + WS}, now())`;
  productId = await withWorkspaceScope(WS, (tx) => tx.opsProduct.create({ data: { workspaceId: WS, name: "Widget", sku: "W-1", priceCents: 900 } })).then((p) => p.id);
  vendorId = String(rowOf(await withWorkspaceScope(WS, (tx) => opsCreate(tx, VENDORS, ACTOR, { name: "Parts Co", paymentTermsDays: 15 }))).id);
});

after(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$disconnect();
});

async function sentPo(qty = 10): Promise<string> {
  const po = rowOf(await withWorkspaceScope(WS, (tx) => opsCreate(tx, POS, ACTOR, { vendorId, rfq: true, lineItems: [{ productId, name: "Widget", qty, priceCents: 500 }, { name: "Freight", qty: 1, priceCents: 2_000 }] })));
  const id = String(po.id);
  assert.equal(po.status, "rfq");
  assert.equal(po.supplierName, "Parts Co", "legacy supplier name kept readable");
  await withWorkspaceScope(WS, (tx) => opsPatch(tx, POS, ACTOR, { id, status: "rfq_sent" }));
  // Vendor quoted a better price: RFQs stay editable.
  await withWorkspaceScope(WS, (tx) => opsPatch(tx, POS, ACTOR, { id, lineItems: [{ productId, name: "Widget", qty, priceCents: 450 }, { name: "Freight", qty: 1, priceCents: 2_000 }] }));
  await withWorkspaceScope(WS, (tx) => opsPatch(tx, POS, ACTOR, { id, status: "draft" }));
  const approvalId = await approved("OPS_PO_SEND", { entity: "purchase-orders", entityId: id, slug: "OPS_PO_SEND", mutation: { id, status: "sent" } });
  await withWorkspaceScope(WS, (tx) => opsPatch(tx, POS, ACTOR, { id, status: "sent", approvalId }, { gatePort: phase14GatePort }));
  return id;
}

describe("vendor linking", () => {
  it("a PO with only a free-text supplier is linked to a (found or created) vendor", async () => {
    const a = rowOf(await withWorkspaceScope(WS, (tx) => opsCreate(tx, POS, ACTOR, { supplierName: "Bolt Supply", lineItems: [{ name: "Bolts", qty: 1, priceCents: 100 }] })));
    const b = rowOf(await withWorkspaceScope(WS, (tx) => opsCreate(tx, POS, ACTOR, { supplierName: "Bolt Supply", lineItems: [{ name: "Nuts", qty: 1, priceCents: 100 }] })));
    assert.ok(a.vendorId);
    assert.equal(a.vendorId, b.vendorId, "same name → same vendor");
    assert.equal(a.supplierName, "Bolt Supply", "legacy field stays readable");
  });
});

describe("RFQ and partial receipts", () => {
  it("receipts restock exactly what arrived; 'received' restocks only the rest", async () => {
    const id = await sentPo(10);
    const before = await stock(productId);
    const r1 = await withWorkspaceScope(WS, (tx) => receivePurchaseOrder(tx, ACTOR, id, [{ index: 0, qty: 4 }], "first pallet"));
    assert.equal(r1.status, "partially_received");
    assert.equal((await stock(productId)) - before, 4);
    const done = await withWorkspaceScope(WS, (tx) => opsPatch(tx, POS, ACTOR, { id, status: "received" }));
    assert.equal(rowOf(done).restocked, 1);
    assert.equal((await stock(productId)) - before, 10, "6 more, never 10 more");
    const receipts = await withWorkspaceScope(WS, (tx) => tx.opsPurchaseReceipt.count({ where: { purchaseOrderId: id } }));
    assert.equal(receipts, 2);
  });

  it("concurrent receipts can't over-receive a line", async () => {
    const id = await sentPo(5);
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => withWorkspaceScope(WS, (tx) => receivePurchaseOrder(tx, ACTOR, id, [{ index: 0, qty: 3 }]))),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const po = await withWorkspaceScope(WS, (tx) => tx.opsPurchaseOrder.findFirstOrThrow({ where: { id } }));
    assert.equal((po.lineItems as Array<{ receivedQty?: number }>)[0]!.receivedQty, 3);
  });
});

describe("vendor bills", () => {
  it("bill from PO → open posts to AP → gated partial then full payment", async () => {
    const id = await sentPo(10);
    await withWorkspaceScope(WS, (tx) => receivePurchaseOrder(tx, ACTOR, id, [{ index: 0, qty: 10 }, { index: 1, qty: 1 }]));
    const { bill, created } = await withWorkspaceScope(WS, (tx) => billFromPurchaseOrder(tx, ACTOR, id));
    assert.equal(created, true);
    assert.equal(bill.totalCents, 6_500);
    assert.equal(bill.vendorId, vendorId);
    assert.equal(Math.round((bill.dueAt!.getTime() - bill.billDate.getTime()) / 86_400_000), 15, "vendor terms");
    const again = await withWorkspaceScope(WS, (tx) => billFromPurchaseOrder(tx, ACTOR, id));
    assert.equal(again.created, false);

    const open = rowOf(await withWorkspaceScope(WS, (tx) => opsPatch(tx, BILLS, ACTOR, { id: bill.id, status: "open" })));
    assert.equal(open.number, "BILL-0001");
    const posted = await withWorkspaceScope(WS, (tx) => findEntryBySource(tx, WS, `bill:${bill.id}:post`));
    const byCode = Object.fromEntries(posted!.lines.map((l) => [l.accountCode, l.debitCents || -l.creditCents]));
    assert.deepEqual(byCode, { "6000": 6_500, "2000": -6_500 });

    const pay = (amountCents: number, approvalId?: string, port: OpsGatePort = phase14GatePort) =>
      withWorkspaceScope(WS, (tx) =>
        runGated(tx, ACTOR, { slug: "OPS_BILL_PAY", entity: "vendor-bills", entityId: bill.id, mutation: { id: bill.id, pay: { amountCents } }, summary: "pay", approvalId, gatePort: port }, () =>
          payBill(tx, ACTOR, bill.id, { amountCents }),
        ),
      );
    const proposed = await pay(2_500, undefined, proposeOnly);
    assert.equal(proposed.outcome, "approval_required");
    const a1 = await approved("OPS_BILL_PAY", { entity: "vendor-bills", entityId: bill.id, slug: "OPS_BILL_PAY", mutation: { id: bill.id, pay: { amountCents: 2_500 } } });
    await pay(2_500, a1);
    let b = await withWorkspaceScope(WS, (tx) => tx.opsVendorBill.findFirstOrThrow({ where: { id: bill.id } }));
    assert.equal(b.status, "open");
    assert.equal(b.paidCents, 2_500);
    const a2 = await approved("OPS_BILL_PAY", { entity: "vendor-bills", entityId: bill.id, slug: "OPS_BILL_PAY", mutation: { id: bill.id, pay: { amountCents: 4_000 } } });
    await pay(4_000, a2);
    b = await withWorkspaceScope(WS, (tx) => tx.opsVendorBill.findFirstOrThrow({ where: { id: bill.id } }));
    assert.equal(b.status, "paid");
    const payouts = await withWorkspaceScope(WS, (tx) => tx.opsPayment.findMany({ where: { billId: bill.id } }));
    assert.deepEqual(payouts.map((p) => p.kind), ["payout", "payout"]);
  });

  it("a manual bill with line accounts posts to them; cancelling an open bill reverses the posting", async () => {
    const acct = await withWorkspaceScope(WS, (tx) => tx.opsAccount.findFirstOrThrow({ where: { workspaceId: WS, systemKey: "expense_software" } }));
    const bill = rowOf(await withWorkspaceScope(WS, (tx) => opsCreate(tx, BILLS, ACTOR, { vendorId, vendorRef: "PC-77", lineItems: [{ description: "Licences", qty: 2, priceCents: 1_500, accountId: acct.id }], taxCents: 300 })));
    const id = String(bill.id);
    await withWorkspaceScope(WS, (tx) => opsPatch(tx, BILLS, ACTOR, { id, status: "open" }));
    const posted = await withWorkspaceScope(WS, (tx) => findEntryBySource(tx, WS, `bill:${id}:post`));
    const byCode = Object.fromEntries(posted!.lines.map((l) => [l.accountCode, l.debitCents || -l.creditCents]));
    assert.deepEqual(byCode, { "6200": 3_000, "1300": 300, "2000": -3_300 });
    const approvalId = await approved("OPS_RECORD_DELETE", { entity: "vendor-bills", entityId: id, slug: "OPS_RECORD_DELETE", mutation: { id, status: "cancelled" } });
    const r = await withWorkspaceScope(WS, (tx) => opsPatch(tx, BILLS, ACTOR, { id, status: "cancelled", approvalId }, { gatePort: phase14GatePort }));
    assert.ok(rowOf(r).reversalEntryId);
  });
});
