// ShapesOS — Phase 10 (finance): quotes / estimates.
//
// OpsQuote: draft → sent (gated OPS_QUOTE_SEND; number QUO-0001 on send;
// emailed with its PDF after commit) → accepted | declined | expired (the
// finance cron expires sent quotes past validUntil).
// convertQuote copies the lines into a DRAFT OpsInvoice or OpsOrder through
// the generic opsCreate (idempotent per quote + target) and links both ways.

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { OpsError, opsCreate, type OpsActor } from "../doctype";
import { customerContact } from "./invoicing";
import { deliverFinanceMail, renderFinanceEmail, type DeliveryDeps, type DeliveryResult } from "./delivery";
import { fmtMoney } from "./money";
import { pdfFilename, renderFinancePdf, type FinanceDocInput, type FinanceDocLine } from "./pdf";

type Tx = Prisma.TransactionClient;

export interface QuoteLine {
  description: string;
  qty: number;
  priceCents: number;
  taxRateId?: string;
  taxCents?: number;
  sku?: string;
}

async function loadQuote(tx: Tx, workspaceId: string, id: string) {
  const q = await tx.opsQuote.findFirst({ where: { id, workspaceId } });
  if (!q) throw new OpsError(404, `quotes "${id}" not found in workspace`);
  return q;
}

/** Quote lines → invoice lines (tax rates carry over; the invoice recomputes tax). */
export function quoteLinesToInvoice(lines: QuoteLine[]) {
  return lines.map((l) => ({
    description: l.description,
    qty: l.qty,
    priceCents: l.priceCents,
    ...(l.taxRateId ? { taxRateId: l.taxRateId } : {}),
  }));
}

/** Quote lines → order lines ({ name, sku?, qty, priceCents }). */
export function quoteLinesToOrder(lines: QuoteLine[]) {
  return lines.map((l) => ({ name: l.description.slice(0, 200), ...(l.sku ? { sku: l.sku } : {}), qty: l.qty, priceCents: l.priceCents }));
}

export type ConvertTarget = "invoice" | "order";

export async function convertQuote(tx: Tx, actor: OpsActor, quoteId: string, target: ConvertTarget) {
  const q = await loadQuote(tx, actor.workspaceId, quoteId);
  const already = target === "invoice" ? q.convertedInvoiceId : q.convertedOrderId;
  if (already) return { quote: q, target, id: already, created: false };
  if (q.status !== "sent" && q.status !== "accepted") {
    throw new OpsError(422, `Only a sent or accepted quote can be converted (quote is ${q.status})`);
  }
  const lines = (Array.isArray(q.lineItems) ? q.lineItems : []) as unknown as QuoteLine[];
  const hasRates = lines.some((l) => l.taxRateId);
  let newId: string;
  if (target === "invoice") {
    const r = await opsCreate(tx, OPS_ENTITY_MAP["invoices"]!, actor, {
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.customerEmail ? { customerEmail: q.customerEmail } : {}),
      lineItems: quoteLinesToInvoice(lines),
      taxCents: hasRates ? 0 : q.taxCents,
      idempotencyKey: `quote:${q.id}:invoice`,
    });
    if (r.outcome !== "done") throw new OpsError(500, "Invoice draft was not created");
    newId = String(r.row.id);
    await tx.opsInvoice.updateMany({ where: { id: newId, workspaceId: actor.workspaceId }, data: { quoteId: q.id } });
  } else {
    const r = await opsCreate(tx, OPS_ENTITY_MAP["orders"]!, actor, {
      ...(q.customerId ? { customerId: q.customerId } : {}),
      lineItems: quoteLinesToOrder(lines),
      taxCents: q.taxCents,
    });
    if (r.outcome !== "done") throw new OpsError(500, "Order draft was not created");
    newId = String(r.row.id);
    await tx.opsOrder.updateMany({ where: { id: newId, workspaceId: actor.workspaceId }, data: { quoteId: q.id } });
  }
  // Guarded on the link still being empty: a racing conversion loses here
  // and its draft rolls back with the transaction.
  const linked = await tx.opsQuote.updateMany({
    where: {
      id: q.id,
      workspaceId: actor.workspaceId,
      ...(target === "invoice" ? { convertedInvoiceId: null } : { convertedOrderId: null }),
    },
    data: {
      ...(target === "invoice" ? { convertedInvoiceId: newId } : { convertedOrderId: newId }),
      ...(q.status === "sent" ? { status: "accepted", decidedAt: new Date() } : {}),
    },
  });
  if (linked.count !== 1) throw new OpsError(409, "This quote was converted concurrently — reload");
  await tx.opsAuditEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      entity: "quotes",
      entityId: q.id,
      action: "convert",
      actor: actor.userId,
      summary: `quote ${q.number ?? q.id} converted to draft ${target} ${newId}`,
    },
  });
  return { quote: { ...q, status: q.status === "sent" ? "accepted" : q.status }, target, id: newId, created: true };
}

export async function expireQuotes(tx: Tx, actor: OpsActor, now = new Date()): Promise<string[]> {
  const due = await tx.opsQuote.findMany({
    where: { workspaceId: actor.workspaceId, status: "sent", validUntil: { lt: now } },
    select: { id: true, number: true },
    take: 500,
  });
  const out: string[] = [];
  for (const q of due) {
    const moved = await tx.opsQuote.updateMany({ where: { id: q.id, workspaceId: actor.workspaceId, status: "sent" }, data: { status: "expired", decidedAt: now } });
    if (moved.count !== 1) continue;
    await tx.opsAuditEvent.create({
      data: { workspaceId: actor.workspaceId, entity: "quotes", entityId: q.id, action: "expired", actor: actor.userId, summary: `quote ${q.number ?? q.id} expired` },
    });
    out.push(q.id);
  }
  return out;
}

async function quoteDocInput(tx: Tx, workspaceId: string, quoteId: string): Promise<{ doc: FinanceDocInput; to: string | null }> {
  const q = await loadQuote(tx, workspaceId, quoteId);
  const [s, ws, who] = await Promise.all([
    tx.opsFinanceSettings.findUnique({ where: { workspaceId } }),
    tx.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
    customerContact(tx, workspaceId, q.customerId, q.customerEmail),
  ]);
  return {
    to: who.email,
    doc: {
      kind: "Quote",
      number: q.number,
      issuedAt: q.sentAt ?? q.createdAt,
      validUntil: q.validUntil,
      fromName: s?.invoiceFromName || ws?.name || "ShapesOS",
      footer: s?.invoiceFooter ?? null,
      currency: s?.currency ?? "USD",
      toName: who.company ? `${who.name} (${who.company})` : who.name,
      toDetail: who.email,
      lines: (Array.isArray(q.lineItems) ? q.lineItems : []) as unknown as FinanceDocLine[],
      subtotalCents: q.subtotalCents,
      taxCents: q.taxCents,
      totalCents: q.totalCents,
      notes: q.notes,
    },
  };
}

export async function renderQuotePdf(workspaceId: string, quoteId: string) {
  const { doc } = await withWorkspaceScope(workspaceId, (tx) => quoteDocInput(tx, workspaceId, quoteId));
  return { pdf: await renderFinancePdf(doc), filename: pdfFilename("Quote", doc.number, quoteId) };
}

/** Post-commit: email a sent quote with its PDF and record the outcome. */
export async function deliverQuote(actor: OpsActor, quoteId: string, deps?: DeliveryDeps): Promise<DeliveryResult> {
  const { doc, to } = await withWorkspaceScope(actor.workspaceId, (tx) => quoteDocInput(tx, actor.workspaceId, quoteId));
  const body = renderFinanceEmail({
    heading: `Quote ${doc.number ?? ""} from ${doc.fromName}`,
    paragraphs: [
      `Hi ${doc.toName.split(" (")[0]},`,
      `Please find our quote for ${fmtMoney(doc.totalCents, doc.currency)} attached.${doc.validUntil ? ` It is valid until ${doc.validUntil.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}.` : ""} Reply to this email to accept it.`,
    ],
    footer: doc.footer,
  });
  let pdf: Buffer | undefined;
  try {
    pdf = await renderFinancePdf(doc);
  } catch (err) {
    console.error(`[finance-mail] quote PDF render failed for ${quoteId}: ${(err as Error)?.name ?? "error"}`);
  }
  const result = await deliverFinanceMail(
    {
      to,
      subject: `Quote ${doc.number ?? ""} from ${doc.fromName}`,
      text: body.text,
      html: body.html,
      fromName: doc.fromName,
      ...(pdf ? { attachment: { filename: pdfFilename("Quote", doc.number, quoteId), content: pdf } } : {}),
    },
    deps,
  );
  await withWorkspaceScope(actor.workspaceId, async (tx) => {
    await tx.opsQuote.updateMany({ where: { id: quoteId, workspaceId: actor.workspaceId }, data: { deliveryStatus: result.status } });
    await tx.opsAuditEvent.create({
      data: {
        workspaceId: actor.workspaceId,
        entity: "quotes",
        entityId: quoteId,
        action: "delivery",
        actor: actor.userId,
        summary: `quote email: ${result.status}${result.channel ? ` via ${result.channel}` : ""} — ${result.message}`,
      },
    });
  });
  return result;
}
