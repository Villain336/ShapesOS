// ShapesOS — Phase 10 (finance): server-side behaviour for the finance
// entities on the generic Ops route (lib/ops/doctype.ts calls these).
//
//   prepare          normalize a create body / validated patch (line tax,
//                    account checks) before it is written
//   create           materialize a create (replaces the generic insert)
//   beforeTransition extra columns written WITH a status move (numbers)
//   afterTransition  side effects in the same transaction after the move
//                    lands (posting, payments, receipts) — throwing here rolls
//                    the move back
//
// Every hook runs inside the caller's withWorkspaceScope transaction.

import type { Prisma } from "@prisma/client";
import { OpsError, recordInventoryTxn, type OpsActor } from "../doctype";
import { findEntryBySource, postEntry, reverseEntry, type DraftLine } from "../accounting";
import { applyInvoicePayment } from "./invoicing";
import { balanceDueCents, computeDocumentTotals, MoneyError, type MoneyLine } from "./money";
import { hasFinanceLedger, nextDocumentNumber } from "./numbering";
import { activeRateBps, postInvoiceIssued, postInvoicePayment, postVendorBill } from "./posting";
import { receiveRemaining, type PoLine } from "./purchasing";
import { createExpenseClaim, replaceExpenseLines, type ExpenseLineInput } from "./expenses";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

export interface TransitionArgs {
  id: string;
  from: string;
  to: string;
  existing: Row;
  patch: Row;
}

export interface OpsEntityHooks {
  prepare?(tx: Tx, actor: OpsActor, body: Row, existing: Row | null): Promise<Row>;
  /** Return null to fall back to the generic insert. */
  create?(tx: Tx, actor: OpsActor, body: Row): Promise<Row[] | null>;
  beforeTransition?(tx: Tx, actor: OpsActor, args: TransitionArgs): Promise<Row | void>;
  afterTransition?(tx: Tx, actor: OpsActor, args: TransitionArgs & { row: Row }): Promise<Row | void>;
}

export function parseIsoDate(v: unknown, field: string): Date {
  const d = new Date(String(v ?? ""));
  if (Number.isNaN(d.getTime())) throw new OpsError(400, `Invalid ${field}: must be an ISO-8601 date`);
  return d;
}

/** 400 unless every id is an account in this workspace's chart. */
export async function assertAccountsInWorkspace(tx: Tx, workspaceId: string, ids: Array<string | null | undefined>): Promise<void> {
  const want = [...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (want.length === 0) return;
  const found = await tx.opsAccount.count({ where: { workspaceId, id: { in: want } } });
  if (found !== want.length) throw new OpsError(400, "Unknown account: pick an account from this workspace's chart");
}

// ---------------------------------------------------------------------------
// Accounting entities
// ---------------------------------------------------------------------------

const accountHooks: OpsEntityHooks = {
  async prepare(tx, actor, body, existing) {
    const parentId = body.parentId as string | null | undefined;
    if (parentId) {
      if (existing && parentId === existing.id) throw new OpsError(400, "An account can't be its own parent");
      await assertAccountsInWorkspace(tx, actor.workspaceId, [parentId]);
    }
    if (existing && body.active === false && existing.systemKey) {
      throw new OpsError(422, `"${String(existing.name)}" is used by automatic posting (${String(existing.systemKey)}) and can't be deactivated`);
    }
    return body;
  },
};

const taxRateHooks: OpsEntityHooks = {
  async prepare(tx, actor, body) {
    await assertAccountsInWorkspace(tx, actor.workspaceId, [
      body.salesAccountId as string | undefined,
      body.purchaseAccountId as string | undefined,
    ]);
    return body;
  },
};

const journalEntryHooks: OpsEntityHooks = {
  async create(tx, actor, body) {
    const lines = (body.lines as Array<{ accountId: string; debitCents: number; creditCents: number; memo?: string }>).map(
      (l): DraftLine => ({ account: { id: l.accountId }, debitCents: l.debitCents, creditCents: l.creditCents, memo: l.memo }),
    );
    const { entry } = await postEntry(tx, actor, {
      entryDate: body.entryDate ? parseIsoDate(body.entryDate, "entryDate") : undefined,
      memo: (body.memo as string | undefined) ?? null,
      sourceType: "manual",
      lines,
    });
    return [entry as unknown as Row];
  },
};

// ---------------------------------------------------------------------------
// Line tax (invoices, quotes, bills, recurring templates)
// ---------------------------------------------------------------------------

/**
 * Recompute line tax when the lines carry tax rates: the patch's lines (or,
 * for a tax-only patch, the existing lines). Lines without rates keep the
 * legacy free-entry document tax.
 */
export async function withLineTax(tx: Tx, workspaceId: string, body: Row, existing: Row | null): Promise<Row> {
  const lines = (body.lineItems ?? (body.taxCents !== undefined ? existing?.lineItems : undefined)) as MoneyLine[] | undefined;
  if (!Array.isArray(lines) || !lines.some((l) => l.taxRateId)) return body;
  try {
    const t = computeDocumentTotals(lines, await activeRateBps(tx, workspaceId), 0);
    return { ...body, lineItems: t.lineItems, taxCents: t.taxCents };
  } catch (err) {
    if (err instanceof MoneyError) throw new OpsError(400, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Invoices: number on send, AR posting, mark-paid settles the balance, void
// reverses the posting.
// ---------------------------------------------------------------------------

const invoiceHooks: OpsEntityHooks = {
  async prepare(tx, actor, body, existing) {
    if (existing?.kind === "credit_note") throw new OpsError(409, "Credit notes are issued, not edited");
    return withLineTax(tx, actor.workspaceId, body, existing);
  },
  async beforeTransition(tx, actor, t) {
    if (t.existing.kind === "credit_note") throw new OpsError(409, "Credit notes are issued, not edited");
    if (t.to === "sent" && !t.existing.number && hasFinanceLedger(tx)) {
      return { number: await nextDocumentNumber(tx, actor.workspaceId, "invoice") };
    }
  },
  async afterTransition(tx, actor, t) {
    if (!hasFinanceLedger(tx)) return;
    const row = t.row;
    if (t.to === "sent") {
      await postInvoiceIssued(tx, actor, {
        id: t.id,
        number: row.number as string | null,
        totalCents: Number(row.totalCents),
        taxCents: Number(row.taxCents),
        lineItems: row.lineItems,
        sentAt: row.sentAt as Date | null,
      });
    } else if (t.to === "paid") {
      // "Mark paid" (gated OPS_INVOICE_MARK_PAID) settles whatever is still
      // due with one manual payment, so the ledger and balance agree.
      const due = balanceDueCents({ totalCents: Number(row.totalCents), paidCents: Number(row.paidCents ?? 0), creditedCents: Number(row.creditedCents ?? 0) });
      if (due > 0) {
        const payment = await tx.opsPayment.create({
          data: { workspaceId: actor.workspaceId, invoiceId: t.id, kind: "charge", provider: "manual", amountCents: due, status: "succeeded", note: "Marked paid" },
        });
        await tx.opsInvoice.updateMany({ where: { id: t.id, workspaceId: actor.workspaceId }, data: { paidCents: { increment: due } } });
        await postInvoicePayment(tx, actor, { id: payment.id, amountCents: due, invoiceId: t.id, createdAt: payment.createdAt }, (row.number as string) ?? undefined);
        return { settledCents: due, paymentId: payment.id };
      }
    } else if (t.to === "cancelled" && (t.from === "sent" || t.from === "overdue")) {
      if (Number(t.existing.paidCents ?? 0) > 0 || Number(t.existing.creditedCents ?? 0) > 0) {
        throw new OpsError(409, "This invoice has payments or credits — issue a credit note for the rest instead of voiding it");
      }
      const issued = await findEntryBySource(tx, actor.workspaceId, `invoice:${t.id}:issue`);
      if (issued) {
        const { entry } = await reverseEntry(tx, actor, issued.id, { memo: `Void of invoice ${(row.number as string) ?? t.id}` });
        return { reversalEntryId: entry.id };
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Payments: a payment with an invoiceId is applied to that invoice (partial
// payments) and posted. Other payments keep the generic record-only insert.
// ---------------------------------------------------------------------------

const paymentHooks: OpsEntityHooks = {
  async create(tx, actor, body) {
    if (typeof body.invoiceId !== "string" || Array.isArray(body.items)) return null;
    if ((body.kind ?? "charge") !== "charge") throw new OpsError(422, "Refunds against invoices go through a credit note");
    if (body.status !== "succeeded") throw new OpsError(422, "Only a succeeded payment can be applied to an invoice (status: succeeded)");
    const r = await applyInvoicePayment(tx, actor, {
      invoiceId: body.invoiceId,
      amountCents: Number(body.amountCents),
      provider: (body.provider as string) ?? "manual",
      providerRef: (body.providerRef as string) ?? null,
      note: (body.note as string) ?? null,
    });
    return [{ ...r.payment, balanceDueCents: r.balanceDueCents, invoiceStatus: r.invoice.status } as unknown as Row];
  },
};

// ---------------------------------------------------------------------------
// Recurring invoice schedules
// ---------------------------------------------------------------------------

const recurringHooks: OpsEntityHooks = {
  async prepare(tx, actor, body, existing) {
    const out = await withLineTax(tx, actor.workspaceId, body, existing);
    if (out.endAt !== undefined && out.endAt !== null) out.endAt = parseIsoDate(out.endAt, "endAt");
    if (out.nextRunAt !== undefined) out.nextRunAt = parseIsoDate(out.nextRunAt, "nextRunAt");
    return out;
  },
  async create(tx, actor, body) {
    const start = body.startAt ? parseIsoDate(body.startAt, "startAt") : new Date();
    const { startAt: _s, ...rest } = body;
    const row = await tx.opsRecurringInvoice.create({
      data: {
        ...(rest as Prisma.OpsRecurringInvoiceUncheckedCreateInput),
        workspaceId: actor.workspaceId,
        lineItems: rest.lineItems as Prisma.InputJsonValue,
        nextRunAt: start,
        anchorDay: start.getUTCDate(),
      },
    });
    return [row as unknown as Row];
  },
};

// ---------------------------------------------------------------------------
// Quotes: server totals (line tax), number + sentAt on send, decidedAt.
// ---------------------------------------------------------------------------

const quoteHooks: OpsEntityHooks = {
  async prepare(tx, actor, body, existing) {
    const out = await withLineTax(tx, actor.workspaceId, body, existing);
    if (out.validUntil !== undefined && out.validUntil !== null) out.validUntil = parseIsoDate(out.validUntil, "validUntil");
    return out;
  },
  async create(tx, actor, body) {
    const lines = body.lineItems as MoneyLine[];
    const subtotalCents = lines.reduce((s, l) => s + l.qty * l.priceCents, 0);
    const taxCents = Number(body.taxCents ?? 0);
    const totalCents = subtotalCents + taxCents;
    if (totalCents > 2_147_483_647) throw new OpsError(400, "Total exceeds the maximum of 2147483647 cents");
    const row = await tx.opsQuote.create({
      data: {
        workspaceId: actor.workspaceId,
        customerId: (body.customerId as string) ?? null,
        customerEmail: (body.customerEmail as string) ?? null,
        lineItems: lines as unknown as Prisma.InputJsonValue,
        subtotalCents,
        taxCents,
        totalCents,
        status: "draft",
        validUntil: (body.validUntil as Date) ?? null,
        notes: (body.notes as string) ?? null,
      },
    });
    return [row as unknown as Row];
  },
  async beforeTransition(tx, actor, t) {
    if (t.to === "sent") {
      return {
        sentAt: new Date(),
        ...(!t.existing.number && hasFinanceLedger(tx) ? { number: await nextDocumentNumber(tx, actor.workspaceId, "quote") } : {}),
      };
    }
    if (t.to === "accepted" || t.to === "declined") return { decidedAt: new Date() };
  },
};

// ---------------------------------------------------------------------------
// Purchasing: vendors, purchase orders (RFQ + receiving), vendor bills.
// ---------------------------------------------------------------------------

async function assertVendor(tx: Tx, workspaceId: string, vendorId: unknown) {
  if (typeof vendorId !== "string" || !vendorId) return null;
  const v = await tx.opsVendor.findFirst({ where: { id: vendorId, workspaceId } });
  if (!v) throw new OpsError(400, "Unknown vendor: pick a vendor from this workspace");
  return v;
}

const vendorHooks: OpsEntityHooks = {
  async prepare(tx, actor, body) {
    await assertAccountsInWorkspace(tx, actor.workspaceId, [body.defaultAccountId as string | undefined]);
    return body;
  },
};

const purchaseOrderHooks: OpsEntityHooks = {
  async prepare(tx, actor, body) {
    const v = await assertVendor(tx, actor.workspaceId, body.vendorId);
    // Keep the legacy supplier name readable on new POs too.
    if (v && !body.supplierName) return { ...body, supplierName: v.name };
    return body;
  },
  async beforeTransition(_tx, _actor, t) {
    if (t.to === "rfq_sent") return { rfqSentAt: new Date() };
  },
  async afterTransition(tx, actor, t) {
    if (t.to !== "received") return;
    const before = (Array.isArray(t.existing.lineItems) ? t.existing.lineItems : []) as PoLine[];
    if (hasFinanceLedger(tx)) return receiveRemaining(tx, actor, t.id, before);
    // Pre-Phase-10 stub transactions (unit tests): the original restock of
    // every product line, without receipt records.
    let restocked = 0;
    for (const it of before) {
      if (!it.productId) continue;
      await recordInventoryTxn(tx, actor, { productId: it.productId, delta: it.qty, reason: "restock", note: `purchase order ${t.id}` });
      restocked += 1;
    }
    return { restocked };
  },
};

const vendorBillHooks: OpsEntityHooks = {
  async prepare(tx, actor, body, existing) {
    const out = await withLineTax(tx, actor.workspaceId, body, existing);
    await assertVendor(tx, actor.workspaceId, out.vendorId);
    const lines = (out.lineItems ?? []) as Array<{ accountId?: string }>;
    await assertAccountsInWorkspace(tx, actor.workspaceId, lines.map((l) => l.accountId));
    for (const f of ["billDate", "dueAt"]) {
      if (out[f] !== undefined && out[f] !== null) out[f] = parseIsoDate(out[f], f);
    }
    return out;
  },
  async create(tx, actor, body) {
    const lines = body.lineItems as MoneyLine[];
    const subtotalCents = lines.reduce((s, l) => s + l.qty * l.priceCents, 0);
    const taxCents = Number(body.taxCents ?? 0);
    const totalCents = subtotalCents + taxCents;
    if (totalCents > 2_147_483_647) throw new OpsError(400, "Total exceeds the maximum of 2147483647 cents");
    const vendor = await assertVendor(tx, actor.workspaceId, body.vendorId);
    if (typeof body.purchaseOrderId === "string") {
      const po = await tx.opsPurchaseOrder.count({ where: { id: body.purchaseOrderId, workspaceId: actor.workspaceId } });
      if (!po) throw new OpsError(400, "Unknown purchase order");
    }
    const billDate = (body.billDate as Date | undefined) ?? new Date();
    const row = await tx.opsVendorBill.create({
      data: {
        workspaceId: actor.workspaceId,
        vendorId: vendor?.id ?? null,
        purchaseOrderId: (body.purchaseOrderId as string) ?? null,
        vendorRef: (body.vendorRef as string) ?? null,
        lineItems: lines as unknown as Prisma.InputJsonValue,
        subtotalCents,
        taxCents,
        totalCents,
        billDate,
        dueAt: (body.dueAt as Date | undefined) ?? new Date(billDate.getTime() + (vendor?.paymentTermsDays ?? 30) * 86_400_000),
        notes: (body.notes as string) ?? null,
        status: "draft",
      },
    });
    return [row as unknown as Row];
  },
  async beforeTransition(tx, actor, t) {
    if (t.to === "open") {
      return {
        postedAt: new Date(),
        ...(!t.existing.number && hasFinanceLedger(tx) ? { number: await nextDocumentNumber(tx, actor.workspaceId, "bill") } : {}),
      };
    }
  },
  async afterTransition(tx, actor, t) {
    if (!hasFinanceLedger(tx)) return;
    if (t.to === "open") {
      const vendor = t.row.vendorId ? await tx.opsVendor.findFirst({ where: { id: String(t.row.vendorId), workspaceId: actor.workspaceId } }) : null;
      await postVendorBill(
        tx,
        actor,
        {
          id: t.id,
          number: t.row.number as string | null,
          totalCents: Number(t.row.totalCents),
          taxCents: Number(t.row.taxCents),
          lineItems: t.row.lineItems,
          billDate: t.row.billDate as Date,
        },
        vendor?.defaultAccountId,
      );
    } else if (t.to === "cancelled" && t.from === "open") {
      if (Number(t.existing.paidCents ?? 0) > 0) throw new OpsError(409, "This bill has payments recorded and can't be cancelled");
      const posted = await findEntryBySource(tx, actor.workspaceId, `bill:${t.id}:post`);
      if (posted) {
        const { entry } = await reverseEntry(tx, actor, posted.id, { memo: `Cancel of vendor bill ${(t.row.number as string) ?? t.id}` });
        return { reversalEntryId: entry.id };
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Expense claims: created with their lines; draft-only edits by the claimant.
// ---------------------------------------------------------------------------

const expenseClaimHooks: OpsEntityHooks = {
  async prepare(tx, actor, body, existing) {
    if (!existing) return body;
    if (existing.claimantId !== actor.userId) throw new OpsError(403, "Only the claimant can edit their claim");
    if (existing.status !== "draft") throw new OpsError(409, `Only a draft claim can be edited (it is ${String(existing.status)})`);
    const { lines, ...rest } = body;
    if (Array.isArray(lines)) {
      return { ...rest, totalCents: await replaceExpenseLines(tx, actor, String(existing.id), lines as ExpenseLineInput[]) };
    }
    return rest;
  },
  async create(tx, actor, body) {
    const claim = await createExpenseClaim(tx, actor, {
      title: String(body.title),
      notes: (body.notes as string) ?? null,
      lines: body.lines as ExpenseLineInput[],
    });
    return [claim as unknown as Row];
  },
};

export const FINANCE_ENTITY_HOOKS: Record<string, OpsEntityHooks> = {
  "expense-claims": expenseClaimHooks,
  quotes: quoteHooks,
  vendors: vendorHooks,
  "purchase-orders": purchaseOrderHooks,
  "vendor-bills": vendorBillHooks,
  accounts: accountHooks,
  "tax-rates": taxRateHooks,
  "journal-entries": journalEntryHooks,
  invoices: invoiceHooks,
  payments: paymentHooks,
  "recurring-invoices": recurringHooks,
};
