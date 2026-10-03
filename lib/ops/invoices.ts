// Marketr — Phase 17 slice 2: invoice-specific service layer.
//
// Built ON TOP of the slice-1 DocType convention (lib/ops/doctype.ts):
//   - overdue sweep: sent invoices past their due date flip to "overdue"
//     (a free write — overdue is not a money transition, it just reflects
//     the calendar). Runs explicitly via POST /api/ops/invoices/sweep-overdue.
//   - payment reminders: agent- or human-drafted reminder text goes through
//     the Phase 14 gate as OPS_INVOICE_REMIND (money comms are a red lane).
//     Dispatch is recorded in the ops audit trail with the text; actual
//     email/SMS delivery wiring is a later slice.
//
// customerId on OpsInvoice is a crm_leads.id (the lead-turned-customer) —
// no parallel customer table. resolveCustomerNames() maps ids to display
// names for the UI.

import type { Prisma } from "@prisma/client";
import {
  OpsError,
  OpsNotFoundError,
  type OpsActor,
} from "./doctype";
import {
  OpsGateError,
  requestOpsApproval,
  verifyAndConsumeOpsApproval,
  type OpsGatePort,
  type OpsGateProposal,
  phase14GatePort,
} from "./gate";

type Tx = Prisma.TransactionClient;

export interface OpsInvoiceRow {
  id: string;
  workspaceId: string;
  customerId: string | null;
  lineItems: unknown;
  taxCents: number;
  totalCents: number;
  status: string;
  sentAt: Date | string | null;
  dueAt: Date | string | null;
  createdAt: Date | string;
  [key: string]: unknown;
}

export interface CustomerRef {
  id: string;
  name: string;
  company: string | null;
}

/** Server-side money formatting (client has its own copy in components/crm/types.ts). */
export function fmtCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function asDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(v: Date | string | null | undefined): string {
  const d = asDate(v);
  return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
}

/** Map invoice customerIds to lead display names (workspace-scoped). */
export async function resolveCustomerNames(
  tx: Tx,
  workspaceId: string,
  ids: string[],
): Promise<CustomerRef[]> {
  const unique = [...new Set(ids.filter(Boolean))].slice(0, 200);
  if (unique.length === 0) return [];
  const leads = (await (
    tx as unknown as {
      lead: {
        findMany(a: unknown): Promise<Array<{ id: string; name: string; company: string | null }>>;
      };
    }
  ).lead.findMany({
    where: { id: { in: unique }, workspaceId },
    select: { id: true, name: true, company: true },
  })) as Array<{ id: string; name: string; company: string | null }>;
  const byId = new Map(leads.map((l) => [l.id, l]));
  return unique.map((id) => {
    const l = byId.get(id);
    return l ? { id, name: l.name, company: l.company } : { id, name: shortId(id), company: null };
  });
}

/** Load one invoice, workspace-scoped (404 for other workspaces' rows). */
export async function getInvoice(tx: Tx, actor: OpsActor, id: string): Promise<OpsInvoiceRow> {
  const row = (await (
    tx as unknown as {
      opsInvoice: { findFirst(a: unknown): Promise<OpsInvoiceRow | null> };
    }
  ).opsInvoice.findFirst({ where: { id, workspaceId: actor.workspaceId } })) as OpsInvoiceRow | null;
  if (!row) throw new OpsNotFoundError("invoices", id);
  return row;
}

async function audit(
  tx: Tx,
  actor: OpsActor,
  action: string,
  entityId: string,
  summary: string,
): Promise<void> {
  await (
    tx as unknown as { opsAuditEvent: { create(a: unknown): Promise<unknown> } }
  ).opsAuditEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      entity: "invoices",
      entityId,
      action,
      actor: actor.userId,
      summary: summary.slice(0, 2000),
    },
  });
}

// ---------------------------------------------------------------------------
// Overdue sweep — sent invoices whose due date has passed flip to overdue.
// ---------------------------------------------------------------------------

export interface OverdueSweepResult {
  swept: number;
  ids: string[];
}

export async function markOverdueInvoices(tx: Tx, actor: OpsActor): Promise<OverdueSweepResult> {
  const now = new Date();
  const delegate = (
    tx as unknown as {
      opsInvoice: {
        findMany(a: unknown): Promise<OpsInvoiceRow[]>;
        updateMany(a: unknown): Promise<{ count: number }>;
      };
    }
  ).opsInvoice;
  const pastDue = await delegate.findMany({
    where: {
      workspaceId: actor.workspaceId,
      status: "sent",
      dueAt: { lt: now },
    },
    select: { id: true, totalCents: true, dueAt: true },
  });
  const ids: string[] = [];
  for (const inv of pastDue) {
    // Guarded on status "sent": an invoice marked paid (or cancelled)
    // between the read above and this write is left alone.
    const moved = await delegate.updateMany({
      where: { id: inv.id, workspaceId: actor.workspaceId, status: "sent" },
      data: { status: "overdue" },
    });
    if (moved.count !== 1) continue;
    await audit(
      tx,
      actor,
      "overdue_sweep",
      inv.id,
      `invoice ${shortId(inv.id)} marked overdue (due ${fmtDate(inv.dueAt)}, ${fmtCents(inv.totalCents)})`,
    );
    ids.push(inv.id);
  }
  return { swept: ids.length, ids };
}

// ---------------------------------------------------------------------------
// Payment reminders — gated money comms (OPS_INVOICE_REMIND).
// ---------------------------------------------------------------------------

export type ReminderResult =
  | { outcome: "approval_required"; approval: OpsGateProposal }
  | { outcome: "done"; invoiceId: string };

function reminderBinding(invoiceId: string, text: string): Record<string, unknown> {
  return { id: invoiceId, reminderText: text };
}

export async function proposeInvoiceReminder(
  tx: Tx,
  actor: OpsActor,
  invoiceId: string,
  text: string,
  opts: { gatePort?: OpsGatePort } = {},
): Promise<ReminderResult> {
  const clean = text.trim();
  if (clean.length < 1 || clean.length > 2000) {
    throw new OpsError(400, "Reminder text must be 1–2000 characters");
  }
  const inv = await getInvoice(tx, actor, invoiceId);
  if (inv.status !== "sent" && inv.status !== "overdue") {
    throw new OpsError(422, `Only sent or overdue invoices can be reminded (invoice is ${inv.status})`);
  }
  const port = opts.gatePort ?? phase14GatePort;
  const [customer] = await resolveCustomerNames(tx, actor.workspaceId, inv.customerId ? [inv.customerId] : []);
  const who = customer ? `${customer.name}${customer.company ? ` (${customer.company})` : ""}` : "customer";
  const approval = await requestOpsApproval(port, {
    workspaceId: actor.workspaceId,
    slug: "OPS_INVOICE_REMIND",
    entity: "invoices",
    entityId: invoiceId,
    mutation: reminderBinding(invoiceId, clean),
    actor: actor.userId,
    summary: `Send payment reminder to ${who} for invoice ${shortId(invoiceId)} — ${fmtCents(inv.totalCents)} due ${fmtDate(inv.dueAt)}. Text: "${clean.length > 160 ? `${clean.slice(0, 160)}…` : clean}"`,
  });
  await audit(tx, actor, "gate_proposed", invoiceId, `Payment reminder proposed (approval ${approval.id})`);
  return { outcome: "approval_required", approval };
}

export async function executeInvoiceReminder(
  tx: Tx,
  actor: OpsActor,
  invoiceId: string,
  text: string,
  approvalId: string | null | undefined,
  opts: { gatePort?: OpsGatePort } = {},
): Promise<ReminderResult> {
  const clean = text.trim();
  if (!clean) throw new OpsError(400, "Reminder text is required");
  const inv = await getInvoice(tx, actor, invoiceId);
  if (inv.status !== "sent" && inv.status !== "overdue") {
    throw new OpsError(422, `Only sent or overdue invoices can be reminded (invoice is ${inv.status})`);
  }
  const port = opts.gatePort ?? phase14GatePort;
  // One approval = one reminder: claimed approved → executed in this tx.
  await verifyAndConsumeOpsApproval(port, tx, {
    workspaceId: actor.workspaceId,
    slug: "OPS_INVOICE_REMIND",
    entity: "invoices",
    entityId: invoiceId,
    mutation: reminderBinding(invoiceId, clean),
    approvalId,
    actor: actor.userId,
  });
  // Dispatch record: the reminder text is logged in the audit trail with
  // the approving approval id. Actual email/SMS delivery is a later slice —
  // this record is the send of record for v1.
  await audit(
    tx,
    actor,
    "reminder_sent",
    invoiceId,
    `Payment reminder sent (approval ${approvalId}): "${clean.length > 400 ? `${clean.slice(0, 400)}…` : clean}"`,
  );
  return { outcome: "done", invoiceId };
}

export { OpsGateError };
