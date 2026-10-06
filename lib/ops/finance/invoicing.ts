// ShapesOS — Phase 10 (finance): invoicing upgrades on top of
// lib/ops/invoices.ts (overdue sweep + reminders stay there).
//
//   applyInvoicePayment  a payment against an invoice (partial payments):
//                        payment row + paidCents (guarded) + status paid at a
//                        zero balance + Dr Cash / Cr AR — one transaction.
//   issueCreditNote      a credit note (kind credit_note, CN-0001) linked to
//                        the invoice: reduces its balance and posts the
//                        mirror of the invoice posting.
//   deliverInvoice       post-commit: render the PDF (lib/pdf engine) and
//                        email it over the deployment's mail channel; the
//                        outcome is recorded on the invoice.
//
// Gating stays where it was: the payment record is a gated payments create
// (OPS_PAYMENT_RECORD_CHARGE), mark-paid is gated (OPS_INVOICE_MARK_PAID),
// credit notes are gated (OPS_CREDIT_NOTE_ISSUE). The Stripe webhook is the
// one exception: a provider-signed payment event is the authority.

import { emitOpsEvent, invoicePaidEvent } from "@/lib/webhooks/ops-events";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OpsError, type OpsActor } from "../doctype";
import { getInvoice, resolveCustomerNames } from "../invoices";
import { postCreditNote, postInvoicePayment, activeRateBps } from "./posting";
import { assertApplicable, balanceDueCents, computeDocumentTotals, divRoundHalfUp, fmtMoney, MoneyError, settledStatus } from "./money";
import { nextDocumentNumber } from "./numbering";
import { deliverFinanceMail, renderFinanceEmail, type DeliveryDeps, type DeliveryResult } from "./delivery";
import { pdfFilename, renderFinancePdf, type FinanceDocInput, type FinanceDocLine } from "./pdf";

type Tx = Prisma.TransactionClient;

export interface InvoiceRecord {
  id: string;
  workspaceId: string;
  kind: string;
  number: string | null;
  customerId: string | null;
  customerEmail: string | null;
  lineItems: unknown;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  creditedCents: number;
  status: string;
  sentAt: Date | null;
  dueAt: Date | null;
  creditNoteOfId: string | null;
  paymentLinkUrl: string | null;
  createdAt: Date;
}

async function loadInvoice(tx: Tx, workspaceId: string, id: string): Promise<InvoiceRecord> {
  const row = await tx.opsInvoice.findFirst({ where: { id, workspaceId } });
  if (!row) throw new OpsError(404, `invoices "${id}" not found in workspace`);
  return row as unknown as InvoiceRecord;
}

const OPEN = ["sent", "overdue"];

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export interface ApplyPaymentInput {
  invoiceId: string;
  amountCents: number;
  provider?: string;
  providerRef?: string | null;
  note?: string | null;
}

/**
 * Record a succeeded customer payment against an open invoice and post it.
 * The invoice's paidCents moves with a guarded write (it must still be open
 * and unchanged since read), so two racing payments can't overpay; the DB
 * CHECK (paid + credited ≤ total) is the backstop.
 */
export async function applyInvoicePayment(tx: Tx, actor: OpsActor, input: ApplyPaymentInput) {
  const inv = await loadInvoice(tx, actor.workspaceId, input.invoiceId);
  if (inv.kind !== "invoice") throw new OpsError(422, "Payments apply to invoices, not credit notes");
  if (!OPEN.includes(inv.status)) {
    throw new OpsError(422, `Only sent or overdue invoices take payments (invoice is ${inv.status})`);
  }
  const balance = balanceDueCents(inv);
  try {
    assertApplicable(input.amountCents, balance);
  } catch (err) {
    if (err instanceof MoneyError) throw new OpsError(422, err.message);
    throw err;
  }
  const payment = await tx.opsPayment.create({
    data: {
      workspaceId: actor.workspaceId,
      invoiceId: inv.id,
      kind: "charge",
      provider: input.provider ?? "manual",
      providerRef: input.providerRef ?? null,
      amountCents: input.amountCents,
      status: "succeeded",
      note: input.note ?? null,
    },
  });
  const paidCents = inv.paidCents + input.amountCents;
  const status = settledStatus({ ...inv, paidCents });
  const moved = await tx.opsInvoice.updateMany({
    where: { id: inv.id, workspaceId: actor.workspaceId, status: inv.status as never, paidCents: inv.paidCents },
    data: { paidCents, status: status as never },
  });
  if (moved.count !== 1) throw new OpsError(409, "The invoice changed while recording the payment — reload and retry");
  await postInvoicePayment(tx, actor, { id: payment.id, amountCents: payment.amountCents, invoiceId: inv.id, createdAt: payment.createdAt }, inv.number ?? undefined);
  await tx.opsAuditEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      entity: "invoices",
      entityId: inv.id,
      action: "payment_applied",
      actor: actor.userId,
      summary: `payment ${payment.id} of ${fmtMoney(input.amountCents)} applied (${input.provider ?? "manual"}); balance ${fmtMoney(balance - input.amountCents)}${status === "paid" ? " — paid in full" : ""}`,
    },
  });
  // Phase 11 (conncore): paid in full by a payment → invoice.paid (same
  // dedup key as a status patch, so it is delivered once), in this transaction.
  if (status === "paid") {
    await emitOpsEvent(tx, actor.workspaceId, invoicePaidEvent({ ...inv, paidCents, status, paidAt: new Date() } as unknown as Record<string, unknown>), actor.userId);
  }
  return { payment, invoice: { ...inv, paidCents, status }, balanceDueCents: balance - input.amountCents };
}

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

export interface CreditNoteInput {
  reason: string;
  /** Credit this amount (tax split pro rata), or … */
  amountCents?: number;
  /** … credit these lines (taxed like invoice lines). */
  lineItems?: Array<{ description: string; qty: number; priceCents: number; taxRateId?: string }>;
}

/** Pro-rata tax inside a credited amount, half up. */
export function proRataTax(amountCents: number, invoiceTotalCents: number, invoiceTaxCents: number): number {
  if (invoiceTotalCents <= 0 || invoiceTaxCents <= 0) return 0;
  return divRoundHalfUp(amountCents * invoiceTaxCents, invoiceTotalCents);
}

export async function issueCreditNote(tx: Tx, actor: OpsActor, invoiceId: string, input: CreditNoteInput) {
  const inv = await loadInvoice(tx, actor.workspaceId, invoiceId);
  if (inv.kind !== "invoice") throw new OpsError(422, "A credit note can only credit an invoice");
  if (!OPEN.includes(inv.status)) {
    throw new OpsError(422, `Only an open (sent or overdue) invoice can be credited (invoice is ${inv.status})`);
  }
  const reason = input.reason.trim().slice(0, 500);
  if (!reason) throw new OpsError(400, "A credit note needs a reason");
  let lineItems: FinanceDocLine[];
  let taxCents: number;
  let totalCents: number;
  if (input.lineItems && input.lineItems.length > 0) {
    const t = computeDocumentTotals(input.lineItems, await activeRateBps(tx, actor.workspaceId), 0);
    lineItems = t.lineItems;
    taxCents = t.taxCents;
    totalCents = t.totalCents;
  } else if (input.amountCents !== undefined) {
    totalCents = input.amountCents;
    taxCents = proRataTax(totalCents, inv.totalCents, inv.taxCents);
    lineItems = [{ description: `Credit: ${reason}`, qty: 1, priceCents: totalCents - taxCents }];
  } else {
    throw new OpsError(400, "Give either an amount or the lines to credit");
  }
  const balance = balanceDueCents(inv);
  try {
    assertApplicable(totalCents, balance, "Credit");
  } catch (err) {
    if (err instanceof MoneyError) throw new OpsError(422, err.message);
    throw err;
  }
  const number = await nextDocumentNumber(tx, actor.workspaceId, "credit_note");
  const now = new Date();
  const note = await tx.opsInvoice.create({
    data: {
      workspaceId: actor.workspaceId,
      kind: "credit_note",
      number,
      customerId: inv.customerId,
      customerEmail: inv.customerEmail,
      lineItems: lineItems as unknown as Prisma.InputJsonValue,
      taxCents,
      totalCents,
      // A credit note is applied the moment it's issued.
      status: "paid",
      sentAt: now,
      creditNoteOfId: inv.id,
    },
  });
  const creditedCents = inv.creditedCents + totalCents;
  const status = settledStatus({ ...inv, creditedCents });
  const moved = await tx.opsInvoice.updateMany({
    where: { id: inv.id, workspaceId: actor.workspaceId, status: inv.status as never, creditedCents: inv.creditedCents },
    data: { creditedCents, status: status as never },
  });
  if (moved.count !== 1) throw new OpsError(409, "The invoice changed while issuing the credit note — reload and retry");
  await postCreditNote(tx, actor, { id: note.id, number, totalCents, taxCents, lineItems, sentAt: now, creditNoteOfId: inv.id });
  await tx.opsAuditEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      entity: "invoices",
      entityId: inv.id,
      action: "credit_note_issued",
      actor: actor.userId,
      summary: `credit note ${number} (${fmtMoney(totalCents)}) issued against ${inv.number ?? inv.id}: ${reason}`,
    },
  });
  return { creditNote: note, invoice: { ...inv, creditedCents, status } };
}

// ---------------------------------------------------------------------------
// Ledger view of one invoice (payments + credit notes + balance)
// ---------------------------------------------------------------------------

export async function invoiceAccount(tx: Tx, workspaceId: string, invoiceId: string) {
  const inv = await loadInvoice(tx, workspaceId, invoiceId);
  const [payments, creditNotes] = await Promise.all([
    tx.opsPayment.findMany({ where: { workspaceId, invoiceId }, orderBy: { createdAt: "asc" } }),
    tx.opsInvoice.findMany({ where: { workspaceId, creditNoteOfId: invoiceId }, orderBy: { createdAt: "asc" } }),
  ]);
  return { invoice: inv, payments, creditNotes, balanceDueCents: balanceDueCents(inv) };
}

// ---------------------------------------------------------------------------
// PDF + delivery
// ---------------------------------------------------------------------------

// Phase 12 (people): exported for payslip PDFs (employer name, currency).
export async function financeSettings(tx: Tx, workspaceId: string) {
  const [s, ws] = await Promise.all([
    tx.opsFinanceSettings.findUnique({ where: { workspaceId } }),
    tx.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
  ]);
  return { fromName: s?.invoiceFromName || ws?.name || "ShapesOS", footer: s?.invoiceFooter ?? null, currency: s?.currency ?? "USD" };
}

/** The customer's display name and email (document override, else the CRM lead). */
export async function customerContact(tx: Tx, workspaceId: string, customerId: string | null, override?: string | null) {
  if (!customerId) return { name: "Customer", email: override ?? null, company: null as string | null };
  const lead = await tx.lead.findFirst({ where: { id: customerId, workspaceId }, select: { name: true, email: true, company: true } });
  if (!lead) {
    const [ref] = await resolveCustomerNames(tx, workspaceId, [customerId]);
    return { name: ref?.name ?? "Customer", email: override ?? null, company: null };
  }
  return { name: lead.name, email: override ?? lead.email ?? null, company: lead.company };
}

export async function invoiceDocInput(tx: Tx, workspaceId: string, inv: InvoiceRecord): Promise<FinanceDocInput> {
  const [settings, who] = await Promise.all([financeSettings(tx, workspaceId), customerContact(tx, workspaceId, inv.customerId, inv.customerEmail)]);
  const lines = (Array.isArray(inv.lineItems) ? inv.lineItems : []) as FinanceDocLine[];
  const subtotalCents = lines.reduce((s, l) => s + l.qty * l.priceCents, 0);
  return {
    kind: inv.kind === "credit_note" ? "Credit note" : "Invoice",
    number: inv.number,
    issuedAt: inv.sentAt ?? inv.createdAt,
    dueAt: inv.kind === "invoice" ? inv.dueAt : null,
    fromName: settings.fromName,
    footer: settings.footer,
    currency: settings.currency,
    toName: who.company ? `${who.name} (${who.company})` : who.name,
    toDetail: who.email,
    lines,
    subtotalCents,
    taxCents: inv.taxCents,
    totalCents: inv.totalCents,
    paidCents: inv.paidCents,
    creditedCents: inv.creditedCents,
    balanceCents: balanceDueCents(inv),
    paymentLinkUrl: inv.paymentLinkUrl,
  };
}

export async function renderInvoicePdf(workspaceId: string, invoiceId: string): Promise<{ pdf: Buffer; filename: string }> {
  const doc = await withWorkspaceScope(workspaceId, async (tx) => invoiceDocInput(tx, workspaceId, await loadInvoice(tx, workspaceId, invoiceId)));
  return { pdf: await renderFinancePdf(doc), filename: pdfFilename(doc.kind, doc.number, invoiceId) };
}

/**
 * Email an invoice (or credit note) with its PDF. Runs AFTER the send has
 * committed — delivery is never inside the money transaction; the outcome is
 * written back to the invoice (deliveryStatus / deliveredAt) and audited.
 */
export async function deliverInvoice(
  actor: OpsActor,
  invoiceId: string,
  opts: { reminderText?: string; deps?: DeliveryDeps } = {},
): Promise<DeliveryResult> {
  const { doc, to } = await withWorkspaceScope(actor.workspaceId, async (tx) => {
    const inv = await loadInvoice(tx, actor.workspaceId, invoiceId);
    const d = await invoiceDocInput(tx, actor.workspaceId, inv);
    const who = await customerContact(tx, actor.workspaceId, inv.customerId, inv.customerEmail);
    return { doc: d, to: who.email };
  });
  const label = `${doc.kind.toLowerCase()} ${doc.number ?? ""}`.trim();
  const reminder = opts.reminderText?.trim();
  const body = renderFinanceEmail({
    heading: reminder ? `Payment reminder: ${label}` : `${doc.kind} ${doc.number ?? ""} from ${doc.fromName}`,
    paragraphs: reminder
      ? [reminder, `Balance due: ${fmtMoney(doc.balanceCents ?? doc.totalCents, doc.currency)}.`]
      : [
          `Hi ${doc.toName.split(" (")[0]},`,
          `Please find ${label} for ${fmtMoney(doc.totalCents, doc.currency)} attached.${doc.dueAt ? ` It is due ${doc.dueAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}.` : ""}`,
        ],
    buttonLabel: doc.paymentLinkUrl && (doc.balanceCents ?? 0) > 0 ? "Pay online" : undefined,
    buttonUrl: doc.paymentLinkUrl && (doc.balanceCents ?? 0) > 0 ? doc.paymentLinkUrl : null,
    footer: doc.footer,
  });
  let pdf: Buffer | undefined;
  try {
    pdf = await renderFinancePdf(doc);
  } catch (err) {
    console.error(`[finance-mail] PDF render failed for ${invoiceId}: ${(err as Error)?.name ?? "error"}`);
  }
  const result = await deliverFinanceMail(
    {
      to,
      subject: reminder ? `Reminder: ${label} — ${fmtMoney(doc.balanceCents ?? doc.totalCents, doc.currency)} due` : `${doc.kind} ${doc.number ?? ""} from ${doc.fromName}`,
      text: body.text,
      html: body.html,
      fromName: doc.fromName,
      ...(pdf ? { attachment: { filename: pdfFilename(doc.kind, doc.number, invoiceId), content: pdf } } : {}),
    },
    opts.deps,
  );
  await withWorkspaceScope(actor.workspaceId, async (tx) => {
    await tx.opsInvoice.updateMany({
      where: { id: invoiceId, workspaceId: actor.workspaceId },
      data: { deliveryStatus: result.status, ...(result.status === "sent" ? { deliveredAt: new Date() } : {}) },
    });
    await tx.opsAuditEvent.create({
      data: {
        workspaceId: actor.workspaceId,
        entity: "invoices",
        entityId: invoiceId,
        action: reminder ? "reminder_delivery" : "delivery",
        actor: actor.userId,
        summary: `${reminder ? "reminder" : label} email: ${result.status}${result.channel ? ` via ${result.channel}` : ""} — ${result.message}`,
      },
    });
  });
  return result;
}

export { getInvoice };
