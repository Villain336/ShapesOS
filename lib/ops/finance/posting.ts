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
  eventTicketSaleLines,
  payRunPostLines,
  payRunNetPayPaidLines,
  creditNoteLines,
  expenseApproveLines,
  expenseReimburseLines,
  invoiceIssueLines,
  moFinishLines,
  moWipLines,
  paymentReceivedLines,
  posSessionCloseLines,
  postEntry,
  scrapLines,
  webOrderSaleLines,
  type MoCosting,
  type PosCloseTotals,
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

// ---------------------------------------------------------------------------
// Phase 12 (mfgpos): manufacturing costing, scrap and till sessions. Each is
// idempotent per source (a retried completion / close re-posts nothing).
// ---------------------------------------------------------------------------

/** MO completion: the WIP entry (components + labour in) and the finish entry (finished goods + scrap out). */
export async function postMoCompletion(
  tx: Tx,
  actor: OpsActor,
  mo: { id: string; number?: string | null; doneAt?: Date | string | null },
  costing: MoCosting,
): Promise<{ wip: PostResult | null; finish: PostResult | null }> {
  const label = mo.number ?? mo.id;
  const total = costing.componentCostCents + costing.labourCostCents;
  if (total <= 0) return { wip: null, finish: null };
  const entryDate = dayOf(mo.doneAt);
  const wip = await postEntry(tx, actor, {
    entryDate,
    memo: `Manufacturing order ${label}: components and labour into work in progress`,
    sourceType: "manufacturing_order",
    sourceId: mo.id,
    sourceKey: `mo:${mo.id}:wip`,
    lines: moWipLines(costing, label),
  });
  const finish = await postEntry(tx, actor, {
    entryDate,
    memo: `Manufacturing order ${label}: finished goods${costing.scrapCostCents ? " and scrap" : ""} out of work in progress`,
    sourceType: "manufacturing_order",
    sourceId: mo.id,
    sourceKey: `mo:${mo.id}:finish`,
    lines: moFinishLines(costing, label),
  });
  return { wip, finish };
}

/** Scrap of stock on hand (not inside an MO completion): Dr Scrap loss / Cr Inventory. */
export async function postScrap(
  tx: Tx,
  actor: OpsActor,
  scrap: { id: string; totalCostCents: number; createdAt?: Date | string | null; label: string; from?: "inventory" | "finished_goods" },
): Promise<PostResult | null> {
  if (scrap.totalCostCents <= 0) return null;
  return postEntry(tx, actor, {
    entryDate: dayOf(scrap.createdAt),
    memo: `Scrap: ${scrap.label}`,
    sourceType: "scrap",
    sourceId: scrap.id,
    sourceKey: `scrap:${scrap.id}`,
    lines: scrapLines(scrap.totalCostCents, scrap.from ?? "inventory", scrap.label),
  });
}

/** Till session close: ONE balanced entry for the session's takings. */
export async function postPosSessionClose(
  tx: Tx,
  actor: OpsActor,
  session: { id: string; number?: string | null; closedAt?: Date | string | null },
  totals: PosCloseTotals,
  opts: { taxRateId?: string | null } = {},
): Promise<PostResult | null> {
  const moves = totals.netSalesCents + totals.taxCents + Math.abs(totals.cashDifferenceCents);
  if (moves <= 0) return null;
  let taxAccount: AccountRef = { key: "tax_payable" };
  if (totals.taxCents > 0 && opts.taxRateId) {
    const rate = (await loadTaxRates(tx, actor.workspaceId)).get(opts.taxRateId);
    if (rate?.salesAccountId) taxAccount = { id: rate.salesAccountId };
  }
  const label = session.number ?? session.id;
  return postEntry(tx, actor, {
    entryDate: dayOf(session.closedAt),
    memo: `Till session ${label} closed`,
    sourceType: "pos_session",
    sourceId: session.id,
    sourceKey: `pos_session:${session.id}:close`,
    lines: posSessionCloseLines(totals, label, taxAccount),
  });
}

// Phase 12 (people): a posted pay run — ONE balanced entry for the whole run
// (wages, employer taxes and contributions vs. the liabilities they create),
// keyed pay_run:<id>:post so a retried post is a no-op.
export async function postPayRunEntry(
  tx: Tx,
  actor: OpsActor,
  run: {
    id: string;
    number?: string | null;
    payDate: Date;
    periodStart: Date;
    periodEnd: Date;
    grossCents: number;
    preTaxDeductionCents: number;
    employeeTaxCents: number;
    postTaxDeductionCents: number;
    netCents: number;
    employerTaxCents: number;
    employerContribCents: number;
  },
): Promise<PostResult> {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return postEntry(tx, actor, {
    entryDate: run.payDate,
    memo: `Pay run ${run.number ?? run.id} (${day(run.periodStart)} to ${day(run.periodEnd)})`,
    sourceType: "pay_run",
    sourceId: run.id,
    sourceKey: `pay_run:${run.id}:post`,
    lines: payRunPostLines(run),
  });
}

// Phase 14 (connectors): the payroll provider (Gusto) reported the run paid —
// ONE balanced payment entry clears Net pay payable, keyed
// pay_run:<id>:net_pay_paid so a repeated sync is a no-op.
export async function postPayRunNetPayPaid(
  tx: Tx,
  actor: OpsActor,
  run: { id: string; number?: string | null; netCents: number },
  paidOn: Date,
  providerLabel: string,
): Promise<PostResult | null> {
  if (run.netCents <= 0) return null;
  return postEntry(tx, actor, {
    entryDate: paidOn,
    memo: `Pay run ${run.number ?? run.id}: net pay paid by ${providerLabel}`,
    sourceType: "pay_run",
    sourceId: run.id,
    sourceKey: `pay_run:${run.id}:net_pay_paid`,
    lines: payRunNetPayPaidLines(run.netCents),
  });
}

// Phase 12 (people): a paid event registration (tenant Stripe Checkout).
export async function postEventTicketSale(
  tx: Tx,
  actor: OpsActor,
  reg: { id: string; amountCents: number; paidAt?: Date | string | null },
  label?: string,
): Promise<PostResult | null> {
  if (reg.amountCents <= 0) return null;
  return postEntry(tx, actor, {
    entryDate: dayOf(reg.paidAt),
    memo: `Event registration ${label ?? reg.id} paid`,
    sourceType: "event_registration",
    sourceId: reg.id,
    sourceKey: `event_registration:${reg.id}:paid`,
    lines: eventTicketSaleLines(reg.amountCents),
  });
}
