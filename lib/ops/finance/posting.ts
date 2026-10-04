// ShapesOS — Phase 10 (finance): post business documents to the ledger.
//
// Each function maps one document event to a posting rule
// (lib/ops/accounting/rules.ts) and posts it with a stable sourceKey, so a
// re-post of the same event is a no-op (idempotent). They run inside the
// transaction that changes the document, so the document and its journal
// entry commit together.

import type { Prisma } from "@prisma/client";
import type { OpsActor } from "../doctype";
import {
  billPaymentLines,
  billPostLines,
  creditNoteLines,
  expenseApproveLines,
  expenseReimburseLines,
  invoiceIssueLines,
  paymentReceivedLines,
  postEntry,
  webOrderSaleLines,
  type AccountRef,
  type PostResult,
  type TaxedLine,
  type TaxRateLike,
} from "../accounting";

type Tx = Prisma.TransactionClient;

export async function loadTaxRates(tx: Tx, workspaceId: string, opts: { activeOnly?: boolean } = {}): Promise<Map<string, TaxRateLike & { name: string; active: boolean }>> {
  const rows = await tx.opsTaxRate.findMany({
    where: { workspaceId, ...(opts.activeOnly ? { active: true } : {}) },
    select: { id: true, name: true, rateBps: true, salesAccountId: true, purchaseAccountId: true, active: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

/** Active rates as id → basis points (for computeDocumentTotals). */
export async function activeRateBps(tx: Tx, workspaceId: string): Promise<Map<string, number>> {
  const rates = await loadTaxRates(tx, workspaceId, { activeOnly: true });
  return new Map([...rates.values()].map((r) => [r.id, r.rateBps]));
}

function lines(v: unknown): TaxedLine[] {
  return Array.isArray(v) ? (v as TaxedLine[]) : [];
}

function dayOf(d: Date | string | null | undefined): Date {
  const x = d ? new Date(d) : new Date();
  return Number.isNaN(x.getTime()) ? new Date() : x;
}

export interface InvoiceForPosting {
  id: string;
  number?: string | null;
  totalCents: number;
  taxCents: number;
  lineItems: unknown;
  sentAt?: Date | string | null;
}

export async function postInvoiceIssued(tx: Tx, actor: OpsActor, inv: InvoiceForPosting): Promise<PostResult | null> {
  if (inv.totalCents <= 0) return null;
  const rates = await loadTaxRates(tx, actor.workspaceId);
  return postEntry(tx, actor, {
    entryDate: dayOf(inv.sentAt),
    memo: `Invoice ${inv.number ?? inv.id} issued`,
    sourceType: "invoice",
    sourceId: inv.id,
    sourceKey: `invoice:${inv.id}:issue`,
    lines: invoiceIssueLines({ totalCents: inv.totalCents, taxCents: inv.taxCents, lineItems: lines(inv.lineItems) }, rates),
  });
}

export async function postCreditNote(tx: Tx, actor: OpsActor, note: InvoiceForPosting & { creditNoteOfId?: string | null }): Promise<PostResult | null> {
  if (note.totalCents <= 0) return null;
  const rates = await loadTaxRates(tx, actor.workspaceId);
  return postEntry(tx, actor, {
    entryDate: dayOf(note.sentAt),
    memo: `Credit note ${note.number ?? note.id}${note.creditNoteOfId ? ` against invoice ${note.creditNoteOfId}` : ""}`,
    sourceType: "credit_note",
    sourceId: note.id,
    sourceKey: `credit_note:${note.id}:issue`,
    lines: creditNoteLines({ totalCents: note.totalCents, taxCents: note.taxCents, lineItems: lines(note.lineItems) }, rates),
  });
}

export async function postInvoicePayment(
  tx: Tx,
  actor: OpsActor,
  payment: { id: string; amountCents: number; invoiceId: string; createdAt?: Date | string | null },
  invoiceLabel?: string,
): Promise<PostResult> {
  return postEntry(tx, actor, {
    entryDate: dayOf(payment.createdAt),
    memo: `Payment received for invoice ${invoiceLabel ?? payment.invoiceId}`,
    sourceType: "payment",
    sourceId: payment.id,
    sourceKey: `payment:${payment.id}`,
    lines: paymentReceivedLines(payment.amountCents),
  });
}

export interface BillForPosting {
  id: string;
  number?: string | null;
  totalCents: number;
  taxCents: number;
  lineItems: unknown;
  billDate?: Date | string | null;
}

export async function postVendorBill(tx: Tx, actor: OpsActor, bill: BillForPosting, vendorDefaultAccountId?: string | null): Promise<PostResult | null> {
  if (bill.totalCents <= 0) return null;
  const rates = await loadTaxRates(tx, actor.workspaceId);
  return postEntry(tx, actor, {
    entryDate: dayOf(bill.billDate),
    memo: `Vendor bill ${bill.number ?? bill.id}`,
    sourceType: "bill",
    sourceId: bill.id,
    sourceKey: `bill:${bill.id}:post`,
    lines: billPostLines(
      { totalCents: bill.totalCents, taxCents: bill.taxCents, lineItems: lines(bill.lineItems) },
      rates,
      vendorDefaultAccountId ? { id: vendorDefaultAccountId } : { key: "expense_general" },
    ),
  });
}

export async function postBillPayment(
  tx: Tx,
  actor: OpsActor,
  payment: { id: string; amountCents: number; billId: string; createdAt?: Date | string | null },
  billLabel?: string,
): Promise<PostResult> {
  return postEntry(tx, actor, {
    entryDate: dayOf(payment.createdAt),
    memo: `Payment of vendor bill ${billLabel ?? payment.billId}`,
    sourceType: "bill_payment",
    sourceId: payment.id,
    sourceKey: `bill_payment:${payment.id}`,
    lines: billPaymentLines(payment.amountCents),
  });
}

export async function postExpenseApproved(
  tx: Tx,
  actor: OpsActor,
  claim: { id: string; number?: string | null; title: string },
  claimLines: Array<{ category: string; accountId?: string | null; amountCents: number; taxCents?: number | null }>,
): Promise<PostResult | null> {
  if (claimLines.reduce((s, l) => s + l.amountCents, 0) <= 0) return null;
  return postEntry(tx, actor, {
    memo: `Expense claim ${claim.number ?? claim.id}: ${claim.title}`,
    sourceType: "expense",
    sourceId: claim.id,
    sourceKey: `expense:${claim.id}:approve`,
    lines: expenseApproveLines(claimLines),
  });
}

export async function postExpenseReimbursed(
  tx: Tx,
  actor: OpsActor,
  claim: { id: string; number?: string | null; totalCents: number },
): Promise<PostResult | null> {
  if (claim.totalCents <= 0) return null;
  return postEntry(tx, actor, {
    memo: `Reimbursement of expense claim ${claim.number ?? claim.id}`,
    sourceType: "expense",
    sourceId: claim.id,
    sourceKey: `expense:${claim.id}:reimburse`,
    lines: expenseReimburseLines(claim.totalCents),
  });
}

// Phase 10 (store): a paid storefront order (cash sale, net of discount).
export async function postWebOrderSale(
  tx: Tx,
  actor: OpsActor,
  order: { id: string; totalCents: number; taxCents: number; paidAt?: Date | string | null },
  opts: { taxRateId?: string | null; label?: string } = {},
): Promise<PostResult | null> {
  if (order.totalCents <= 0) return null;
  let taxAccount: AccountRef = { key: "tax_payable" };
  if (order.taxCents > 0 && opts.taxRateId) {
    const rate = (await loadTaxRates(tx, actor.workspaceId)).get(opts.taxRateId);
    if (rate?.salesAccountId) taxAccount = { id: rate.salesAccountId };
  }
  return postEntry(tx, actor, {
    entryDate: dayOf(order.paidAt),
    memo: `Storefront order ${opts.label ?? order.id} paid`,
    sourceType: "web_order",
    sourceId: order.id,
    sourceKey: `web_order:${order.id}:paid`,
    lines: webOrderSaleLines(order, taxAccount),
  });
}
