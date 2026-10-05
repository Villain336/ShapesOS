// ShapesOS — Phase 10 (finance): purchasing — vendors, RFQ stage, partial
// receipts and vendor bills, on top of OpsPurchaseOrder (lib/ops/doctype.ts).
//
//   PO lifecycle  rfq → rfq_sent → draft (prices agreed) → sent (gated
//                 OPS_PO_SEND) → partially_received → received
//   receipts      receivePurchaseOrder books one append-only receipt per
//                 delivery and a restock inventory txn per received line with
//                 a productId — in the same transaction, under a row lock on
//                 the PO so two receipts can't over-receive a line.
//   vendor bills  draft → open (posted Dr Expense + Input tax / Cr AP,
//                 numbered BILL-0001) → paid (payBill: gated OPS_BILL_PAY,
//                 Dr AP / Cr Cash, partial payments allowed).

import type { Prisma } from "@prisma/client";
import { OpsError, recordInventoryTxn, type OpsActor } from "../doctype";
import { assertApplicable, fmtMoney, MoneyError } from "./money";
import { postBillPayment } from "./posting";

type Tx = Prisma.TransactionClient;

export interface PoLine {
  productId?: string;
  name: string;
  sku?: string;
  qty: number;
  priceCents: number;
  receivedQty?: number;
  /** Phase 10 (ops-core): where the received stock lands. */
  variantId?: string;
  locationId?: string;
}

export function remainingQty(line: PoLine): number {
  return Math.max(0, line.qty - (line.receivedQty ?? 0));
}

export interface ReceiptLineInput {
  /** Index into the PO's lineItems. */
  index: number;
  qty: number;
}

/**
 * Apply a receipt to PO lines (PURE): returns the updated lines and the
 * resulting status. Over-receiving a line or receiving nothing is an error.
 */
export function applyReceipt(lines: PoLine[], receipt: ReceiptLineInput[]): { lines: PoLine[]; status: "partially_received" | "received" } {
  if (receipt.length === 0) throw new OpsError(400, "A receipt needs at least one line");
  const out = lines.map((l) => ({ ...l }));
  const seen = new Set<number>();
  for (const r of receipt) {
    if (!Number.isInteger(r.index) || r.index < 0 || r.index >= out.length) throw new OpsError(400, `No line ${r.index} on this purchase order`);
    if (seen.has(r.index)) throw new OpsError(400, `Line ${r.index} appears twice in the receipt`);
    seen.add(r.index);
    if (!Number.isInteger(r.qty) || r.qty < 1) throw new OpsError(400, "Received quantities must be whole numbers of at least 1");
    const line = out[r.index]!;
    const left = remainingQty(line);
    if (r.qty > left) throw new OpsError(422, `Line "${line.name}" has only ${left} left to receive`);
    line.receivedQty = (line.receivedQty ?? 0) + r.qty;
  }
  const status = out.every((l) => remainingQty(l) === 0) ? "received" : "partially_received";
  return { lines: out, status };
}

async function lockPo(tx: Tx, workspaceId: string, id: string) {
  await tx.$queryRaw`SELECT id FROM "ops_purchase_orders" WHERE id = ${id} AND workspace_id = ${workspaceId} FOR UPDATE`;
  const po = await tx.opsPurchaseOrder.findFirst({ where: { id, workspaceId } });
  if (!po) throw new OpsError(404, `purchase-orders "${id}" not found in workspace`);
  return po;
}

async function bookReceipt(tx: Tx, actor: OpsActor, poId: string, lines: PoLine[], receipt: ReceiptLineInput[], note: string | null) {
  // Phase 10 (ops-core): receive into the line's variant / location (the
  // inventory ledger defaults to the product's default variant, unlocated).
  const received = receipt.map((r) => ({
    index: r.index,
    productId: lines[r.index]!.productId ?? null,
    variantId: lines[r.index]!.variantId ?? null,
    locationId: lines[r.index]!.locationId ?? null,
    name: lines[r.index]!.name,
    qty: r.qty,
  }));
  const row = await tx.opsPurchaseReceipt.create({
    data: { workspaceId: actor.workspaceId, purchaseOrderId: poId, lines: received as unknown as Prisma.InputJsonValue, note, actor: actor.userId },
  });
  let restocked = 0;
  for (const r of received) {
    if (!r.productId) continue;
    await recordInventoryTxn(tx, actor, { productId: r.productId, delta: r.qty, reason: "restock", note: `purchase order ${poId} receipt ${row.id}`, variantId: r.variantId, locationId: r.locationId });
    restocked += 1;
  }
  return { receipt: row, restocked };
}

/** Record a (partial) delivery against a sent PO. Free logged write (fulfilment). */
export async function receivePurchaseOrder(tx: Tx, actor: OpsActor, poId: string, receipt: ReceiptLineInput[], note?: string | null) {
  const po = await lockPo(tx, actor.workspaceId, poId);
  if (po.status !== "sent" && po.status !== "partially_received") {
    throw new OpsError(422, `Only a sent purchase order can be received (it is ${po.status})`);
  }
  const lines = (Array.isArray(po.lineItems) ? po.lineItems : []) as unknown as PoLine[];
  const next = applyReceipt(lines, receipt);
  const { receipt: row, restocked } = await bookReceipt(tx, actor, poId, lines, receipt, note ?? null);
  await tx.opsPurchaseOrder.update({
    where: { id: poId },
    data: { lineItems: next.lines as unknown as Prisma.InputJsonValue, status: next.status, ...(next.status === "received" ? { receivedAt: new Date() } : {}) },
  });
  await tx.opsAuditEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      entity: "purchase-orders",
      entityId: poId,
      action: "receipt",
      actor: actor.userId,
      summary: `receipt ${row.id}: ${receipt.map((r) => `${r.qty}× ${lines[r.index]!.name}`).join(", ")} → ${next.status} (${restocked} restock txn(s))`,
    },
  });
  return { receipt: row, status: next.status, restocked, lines: next.lines };
}

/**
 * The generic "mark received" move (sent / partially_received → received):
 * receive whatever is still outstanding on every line in one receipt. Runs as
 * the PO afterTransition hook, so the status write and the restock commit
 * together — and lines already received by earlier receipts are not
 * restocked twice.
 */
export async function receiveRemaining(tx: Tx, actor: OpsActor, poId: string, linesBefore: PoLine[]): Promise<{ restocked: number }> {
  const receipt = linesBefore.map((l, index) => ({ index, qty: remainingQty(l) })).filter((r) => r.qty > 0);
  if (receipt.length === 0) return { restocked: 0 };
  const next = applyReceipt(linesBefore, receipt);
  const { restocked } = await bookReceipt(tx, actor, poId, linesBefore, receipt, "Marked received");
  await tx.opsPurchaseOrder.update({ where: { id: poId }, data: { lineItems: next.lines as unknown as Prisma.InputJsonValue } });
  return { restocked };
}

// ---------------------------------------------------------------------------
// Vendor bills
// ---------------------------------------------------------------------------

/** Draft bill lines from a PO: received quantities when anything was received, else ordered. */
export function billLinesFromPo(lines: PoLine[], vendorAccountId?: string | null) {
  const anyReceived = lines.some((l) => (l.receivedQty ?? 0) > 0);
  return lines
    .map((l) => ({ description: l.sku ? `${l.name} (${l.sku})` : l.name, qty: anyReceived ? (l.receivedQty ?? 0) : l.qty, priceCents: l.priceCents, ...(vendorAccountId ? { accountId: vendorAccountId } : {}) }))
    .filter((l) => l.qty > 0);
}

export async function billFromPurchaseOrder(tx: Tx, actor: OpsActor, poId: string) {
  const po = await tx.opsPurchaseOrder.findFirst({ where: { id: poId, workspaceId: actor.workspaceId }, include: { vendor: true } });
  if (!po) throw new OpsError(404, `purchase-orders "${poId}" not found in workspace`);
  if (!["sent", "partially_received", "received"].includes(po.status)) {
    throw new OpsError(422, `Bill a purchase order once it's sent (it is ${po.status})`);
  }
  const existing = await tx.opsVendorBill.findFirst({ where: { workspaceId: actor.workspaceId, purchaseOrderId: poId, status: { not: "cancelled" } } });
  if (existing) return { bill: existing, created: false };
  const lines = billLinesFromPo((Array.isArray(po.lineItems) ? po.lineItems : []) as unknown as PoLine[], po.vendor?.defaultAccountId);
  if (lines.length === 0) throw new OpsError(422, "Nothing to bill on this purchase order");
  const subtotalCents = lines.reduce((s, l) => s + l.qty * l.priceCents, 0);
  // PO tax is carried pro rata to the billed share.
  const taxCents = po.subtotalCents > 0 ? Math.floor((po.taxCents * subtotalCents + Math.floor(po.subtotalCents / 2)) / po.subtotalCents) : 0;
  const billDate = new Date();
  const bill = await tx.opsVendorBill.create({
    data: {
      workspaceId: actor.workspaceId,
      vendorId: po.vendorId,
      purchaseOrderId: poId,
      lineItems: lines as unknown as Prisma.InputJsonValue,
      subtotalCents,
      taxCents,
      totalCents: subtotalCents + taxCents,
      billDate,
      dueAt: new Date(billDate.getTime() + (po.vendor?.paymentTermsDays ?? 30) * 86_400_000),
      status: "draft",
    },
  });
  await tx.opsAuditEvent.create({
    data: { workspaceId: actor.workspaceId, entity: "vendor-bills", entityId: bill.id, action: "create", actor: actor.userId, summary: `draft bill from purchase order ${poId} (${fmtMoney(bill.totalCents)})` },
  });
  return { bill, created: true };
}

/** Pay (part of) an open bill. Callers run this under the OPS_BILL_PAY gate. */
export async function payBill(tx: Tx, actor: OpsActor, billId: string, input: { amountCents: number; note?: string | null; providerRef?: string | null }) {
  const bill = await tx.opsVendorBill.findFirst({ where: { id: billId, workspaceId: actor.workspaceId } });
  if (!bill) throw new OpsError(404, `vendor-bills "${billId}" not found in workspace`);
  if (bill.status !== "open") throw new OpsError(422, `Only an open (posted) bill can be paid (it is ${bill.status})`);
  const balance = bill.totalCents - bill.paidCents;
  try {
    assertApplicable(input.amountCents, balance);
  } catch (err) {
    if (err instanceof MoneyError) throw new OpsError(422, err.message);
    throw err;
  }
  const payment = await tx.opsPayment.create({
    data: {
      workspaceId: actor.workspaceId,
      billId,
      kind: "payout",
      provider: "manual",
      providerRef: input.providerRef ?? null,
      amountCents: input.amountCents,
      status: "succeeded",
      note: input.note ?? null,
    },
  });
  const paidCents = bill.paidCents + input.amountCents;
  const full = paidCents === bill.totalCents;
  const moved = await tx.opsVendorBill.updateMany({
    where: { id: billId, workspaceId: actor.workspaceId, status: "open", paidCents: bill.paidCents },
    data: { paidCents, ...(full ? { status: "paid", paidAt: new Date() } : {}) },
  });
  if (moved.count !== 1) throw new OpsError(409, "The bill changed while paying it — reload and retry");
  await postBillPayment(tx, actor, { id: payment.id, amountCents: input.amountCents, billId, createdAt: payment.createdAt }, bill.number ?? undefined);
  await tx.opsAuditEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      entity: "vendor-bills",
      entityId: billId,
      action: "payment",
      actor: actor.userId,
      summary: `paid ${fmtMoney(input.amountCents)} on bill ${bill.number ?? billId}; ${full ? "paid in full" : `${fmtMoney(bill.totalCents - paidCents)} left`}`,
    },
  });
  return { payment, bill: { ...bill, paidCents, status: full ? "paid" : "open" } };
}
