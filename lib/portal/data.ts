// ShapesOS — Phase 10 (portal): what a signed-in client sees and does.
//
// Every function takes the PortalPrincipal from a live portal session and
// runs under that session's workspace RLS scope (withWorkspaceScope) with an
// explicit workspaceId filter, and every record is matched against the
// client's scope (lib/portal/core.ts portalScope): nothing is visible unless
// an admin linked it in Settings → Clients. Out-of-scope ids answer 404,
// exactly like ids that don't exist.
//
// Writes reuse the Ops services, so the existing rules apply unchanged:
//   - quote accept/decline → opsPatch on the quotes entity (its status
//     machine, the status-guarded write, the ops audit row) with actor
//     "client:<id>"
//   - tickets → the helpdesk service (createTicket, appendCustomerMessage)
//   - pay → the finance tenant Stripe Checkout (createInvoiceCheckout)
//   - PDFs → the finance PDF renderers (renderInvoicePdf / renderQuotePdf)

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "@/lib/ops/entities";
import { OpsError, auditOpsEvent, opsPatch, type OpsActor } from "@/lib/ops/doctype";
import { appendCustomerMessage, createTicket } from "@/lib/ops/helpdesk";
import { balanceDueCents } from "@/lib/ops/finance/money";
import { renderInvoicePdf } from "@/lib/ops/finance/invoicing";
import { renderQuotePdf } from "@/lib/ops/finance/quotes";
import { createInvoiceCheckout, getFinanceSettingsView, type StripeFactory } from "@/lib/ops/finance/stripe";
import {
  PORTAL_INVOICE_STATUSES,
  PORTAL_MESSAGE_DIRECTIONS,
  PORTAL_QUOTE_STATUSES,
  portalActorId,
  portalMilestones,
  portalScope,
  quoteDecisionError,
  type PortalScope,
  type QuoteDecision,
} from "./core";
import type { PortalPrincipal } from "./store";

type Tx = Prisma.TransactionClient;

export class PortalNotFoundError extends OpsError {
  constructor(what: string) {
    super(404, `${what} not found`);
    this.name = "PortalNotFoundError";
  }
}

function actorOf(p: PortalPrincipal): OpsActor {
  return { workspaceId: p.workspaceId, userId: portalActorId(p.clientId) };
}

const inScope = <T>(p: PortalPrincipal, fn: (tx: Tx, scope: PortalScope) => Promise<T>) =>
  withWorkspaceScope(p.workspaceId, async (tx) => fn(tx, await loadScope(tx, p)));

/** The client's scope: explicit links + the contacts they reach, workspace-scoped. */
export async function loadScope(tx: Tx, p: PortalPrincipal): Promise<PortalScope> {
  const contactIds = p.links.portalContactIds ?? [];
  const companyIds = p.links.portalCompanyIds ?? [];
  const reached =
    contactIds.length || companyIds.length
      ? await tx.opsContact.findMany({
          where: { workspaceId: p.workspaceId, OR: [{ id: { in: contactIds } }, { companyId: { in: companyIds } }] },
          select: { id: true, leadId: true, companyId: true, email: true },
          take: 500,
        })
      : [];
  return portalScope(p.links, reached, p.email);
}

async function currency(tx: Tx, workspaceId: string): Promise<string> {
  const s = await tx.opsFinanceSettings.findUnique({ where: { workspaceId }, select: { currency: true } });
  return s?.currency ?? "USD";
}

// ── Overview ────────────────────────────────────────────────────────────────

export async function portalOverview(p: PortalPrincipal) {
  return inScope(p, async (tx, scope) => {
    const ws = p.workspaceId;
    const [openInvoices, quotesWaiting, activeProjects, openTickets] = await Promise.all([
      tx.opsInvoice.findMany({
        where: { workspaceId: ws, customerId: { in: scope.leadIds }, kind: "invoice", status: { in: ["sent", "overdue"] } },
        select: { totalCents: true, paidCents: true, creditedCents: true },
        take: 500,
      }),
      tx.opsQuote.count({ where: { workspaceId: ws, customerId: { in: scope.leadIds }, status: "sent" } }),
      tx.opsProject.count({
        where: { workspaceId: ws, status: { in: ["planning", "active", "on_hold"] }, OR: [{ customerId: { in: scope.leadIds } }, { leadId: { in: scope.leadIds } }] },
      }),
      tx.opsTicket.count({ where: { workspaceId: ws, contactId: { in: scope.contactIds }, status: { notIn: ["solved", "closed"] } } }),
    ]);
    return {
      linked: scope.leadIds.length + scope.contactIds.length > 0,
      currency: await currency(tx, ws),
      openInvoiceCount: openInvoices.length,
      balanceDueCents: openInvoices.reduce((s, i) => s + balanceDueCents(i), 0),
      quotesWaiting,
      activeProjects,
      openTickets,
    };
  });
}

// ── Invoices ────────────────────────────────────────────────────────────────

export interface PortalInvoice {
  id: string;
  number: string | null;
  kind: "invoice" | "credit_note";
  status: string;
  totalCents: number;
  balanceCents: number;
  sentAt: string | null;
  dueAt: string | null;
  payable: boolean;
}

async function invoiceInScope(tx: Tx, p: PortalPrincipal, scope: PortalScope, id: string) {
  const inv = await tx.opsInvoice.findFirst({
    where: { id, workspaceId: p.workspaceId, customerId: { in: scope.leadIds }, status: { in: [...PORTAL_INVOICE_STATUSES] } },
  });
  if (!inv) throw new PortalNotFoundError("Invoice");
  return inv;
}

export async function listPortalInvoices(p: PortalPrincipal): Promise<{ invoices: PortalInvoice[]; currency: string; canPayOnline: boolean }> {
  return inScope(p, async (tx, scope) => {
    const rows = await tx.opsInvoice.findMany({
      where: { workspaceId: p.workspaceId, customerId: { in: scope.leadIds }, status: { in: [...PORTAL_INVOICE_STATUSES] } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const settings = await getFinanceSettingsView(tx, p.workspaceId);
    return {
      currency: settings.currency,
      canPayOnline: settings.stripeConnected,
      invoices: rows.map((i) => {
        const balanceCents = i.kind === "invoice" ? balanceDueCents(i) : 0;
        return {
          id: i.id,
          number: i.number,
          kind: i.kind,
          status: i.status,
          totalCents: i.totalCents,
          balanceCents,
          sentAt: i.sentAt?.toISOString() ?? null,
          dueAt: i.dueAt?.toISOString() ?? null,
          payable: settings.stripeConnected && i.kind === "invoice" && (i.status === "sent" || i.status === "overdue") && balanceCents > 0,
        };
      }),
    };
  });
}

/** The invoice PDF from the finance renderer, after the scope check. */
export async function portalInvoicePdf(p: PortalPrincipal, id: string) {
  await inScope(p, (tx, scope) => invoiceInScope(tx, p, scope, id));
  return renderInvoicePdf(p.workspaceId, id);
}

/** A Stripe Checkout link for the invoice's balance (the workspace's own Stripe). */
export async function portalPayInvoice(p: PortalPrincipal, id: string, opts: { baseUrl: string; stripe?: StripeFactory }) {
  await inScope(p, (tx, scope) => invoiceInScope(tx, p, scope, id));
  return createInvoiceCheckout(actorOf(p), id, { baseUrl: `${opts.baseUrl}/portal/invoices`, stripe: opts.stripe });
}

// ── Quotes ──────────────────────────────────────────────────────────────────

export interface PortalQuote {
  id: string;
  number: string | null;
  status: string;
  totalCents: number;
  validUntil: string | null;
  sentAt: string | null;
  decidedAt: string | null;
  decidable: boolean;
}

async function quoteInScope(tx: Tx, p: PortalPrincipal, scope: PortalScope, id: string) {
  const q = await tx.opsQuote.findFirst({
    where: { id, workspaceId: p.workspaceId, customerId: { in: scope.leadIds }, status: { in: [...PORTAL_QUOTE_STATUSES] } },
  });
  if (!q) throw new PortalNotFoundError("Quote");
  return q;
}

export async function listPortalQuotes(p: PortalPrincipal, now: Date = new Date()): Promise<{ quotes: PortalQuote[]; currency: string }> {
  return inScope(p, async (tx, scope) => {
    const rows = await tx.opsQuote.findMany({
      where: { workspaceId: p.workspaceId, customerId: { in: scope.leadIds }, status: { in: [...PORTAL_QUOTE_STATUSES] } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return {
      currency: await currency(tx, p.workspaceId),
      quotes: rows.map((q) => ({
        id: q.id,
        number: q.number,
        status: q.status,
        totalCents: q.totalCents,
        validUntil: q.validUntil?.toISOString() ?? null,
        sentAt: q.sentAt?.toISOString() ?? null,
        decidedAt: q.decidedAt?.toISOString() ?? null,
        decidable: quoteDecisionError(q, now) === null,
      })),
    };
  });
}

export async function portalQuotePdf(p: PortalPrincipal, id: string) {
  await inScope(p, (tx, scope) => quoteInScope(tx, p, scope, id));
  return renderQuotePdf(p.workspaceId, id);
}

/**
 * Accept or decline a sent quote. Goes through the quotes entity's status
 * machine (sent → accepted | declined) with a status-guarded write, so of
 * two concurrent decisions exactly one lands (the other gets 409), and the
 * ops audit row records actor client:<id>.
 */
export async function decidePortalQuote(p: PortalPrincipal, id: string, decision: QuoteDecision, now: Date = new Date()) {
  return inScope(p, async (tx, scope) => {
    const q = await quoteInScope(tx, p, scope, id);
    const err = quoteDecisionError(q, now);
    if (err) throw new OpsError(409, err);
    const status = decision === "accept" ? "accepted" : "declined";
    const r = await opsPatch(tx, OPS_ENTITY_MAP["quotes"]!, actorOf(p), { id, status });
    if (r.outcome !== "done") throw new OpsError(409, "This quote can't be decided here. Contact us.");
    await auditOpsEvent(tx, OPS_ENTITY_MAP["quotes"]!, actorOf(p), `portal_${status}`, id, `quote ${q.number ?? id} ${status} by ${p.clientName} in the client portal`);
    return { id, status };
  });
}

// ── Projects ────────────────────────────────────────────────────────────────

export async function listPortalProjects(p: PortalPrincipal) {
  return inScope(p, async (tx, scope) => {
    const rows = await tx.opsProject.findMany({
      where: { workspaceId: p.workspaceId, OR: [{ customerId: { in: scope.leadIds } }, { leadId: { in: scope.leadIds } }] },
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: { _count: { select: { tasks: { where: { clientVisible: true, stage: { not: "cancelled" } } } } } },
    });
    return rows.map((r) => {
      const milestones = portalMilestones(r.milestones);
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        milestones: milestones.length,
        milestonesDone: milestones.filter((m) => m.status === "done" || m.status === "completed").length,
        tasks: r._count.tasks,
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  });
}

export async function getPortalProject(p: PortalPrincipal, id: string) {
  return inScope(p, async (tx, scope) => {
    const r = await tx.opsProject.findFirst({
      where: { id, workspaceId: p.workspaceId, OR: [{ customerId: { in: scope.leadIds } }, { leadId: { in: scope.leadIds } }] },
    });
    if (!r) throw new PortalNotFoundError("Project");
    // Only tasks marked client-visible; never assignees, estimates or notes.
    const tasks = await tx.opsTask.findMany({
      where: { workspaceId: p.workspaceId, projectId: r.id, clientVisible: true, stage: { not: "cancelled" } },
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
      select: { id: true, title: true, stage: true, dueAt: true, completedAt: true },
      take: 300,
    });
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      milestones: portalMilestones(r.milestones),
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, stage: t.stage, dueAt: t.dueAt?.toISOString() ?? null, completedAt: t.completedAt?.toISOString() ?? null })),
    };
  });
}

// ── Tickets ─────────────────────────────────────────────────────────────────

async function ticketInScope(tx: Tx, p: PortalPrincipal, scope: PortalScope, id: string) {
  const t = await tx.opsTicket.findFirst({ where: { id, workspaceId: p.workspaceId, contactId: { in: scope.contactIds } } });
  if (!t) throw new PortalNotFoundError("Ticket");
  return t;
}

export async function listPortalTickets(p: PortalPrincipal) {
  return inScope(p, async (tx, scope) => {
    const rows = await tx.opsTicket.findMany({
      where: { workspaceId: p.workspaceId, contactId: { in: scope.contactIds } },
      orderBy: { lastMessageAt: "desc" },
      take: 200,
      select: { id: true, number: true, subject: true, status: true, lastMessageAt: true, createdAt: true },
    });
    return {
      canOpen: scope.contactIds.length > 0,
      tickets: rows.map((t) => ({ ...t, lastMessageAt: t.lastMessageAt.toISOString(), createdAt: t.createdAt.toISOString() })),
    };
  });
}

export async function getPortalTicket(p: PortalPrincipal, id: string) {
  return inScope(p, async (tx, scope) => {
    const t = await ticketInScope(tx, p, scope, id);
    // The client sees their own messages and the team's replies — never
    // internal notes, and never a reply that failed to go out.
    const messages = await tx.opsTicketMessage.findMany({
      where: {
        workspaceId: p.workspaceId,
        ticketId: t.id,
        direction: { in: [...PORTAL_MESSAGE_DIRECTIONS] },
        OR: [{ deliveryStatus: null }, { deliveryStatus: { not: "failed" } }],
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, direction: true, body: true, createdAt: true },
      take: 500,
    });
    return {
      id: t.id,
      number: t.number,
      subject: t.subject,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      messages: messages.map((m) => ({ id: m.id, fromClient: m.direction === "inbound", body: m.body, createdAt: m.createdAt.toISOString() })),
    };
  });
}

function cleanText(raw: unknown, what: string, max: number): string {
  const s = typeof raw === "string" ? raw.replace(/\r\n/g, "\n").trim() : "";
  if (!s) throw new OpsError(400, `Write a ${what}.`);
  if (s.length > max) throw new OpsError(400, `Keep the ${what} under ${max} characters.`);
  return s;
}

/** Open a ticket as the client: requester = sign-in email, contact = a linked contact. */
export async function createPortalTicket(p: PortalPrincipal, input: { subject: unknown; body: unknown }) {
  const subject = cleanText(input.subject, "subject", 300);
  const body = cleanText(input.body, "message", 20_000);
  return inScope(p, async (tx, scope) => {
    if (scope.contactIds.length === 0) {
      throw new OpsError(422, "Your account isn't linked to a contact yet, so tickets can't be opened here. Email us instead.");
    }
    // The contact with the sign-in email, else the first explicitly linked
    // contact, else the first reached contact (always one of the scope's).
    const contacts = await tx.opsContact.findMany({ where: { workspaceId: p.workspaceId, id: { in: scope.contactIds } }, select: { id: true, email: true } });
    const own = contacts.find((c) => c.email?.toLowerCase() === p.email.toLowerCase());
    const firstLinked = (p.links.portalContactIds ?? []).find((id) => contacts.some((c) => c.id === id));
    const contactId = own?.id ?? firstLinked ?? contacts[0]!.id;
    const actor = actorOf(p);
    const ticket = await createTicket(tx, actor, {
      subject,
      body,
      channel: "web",
      requesterEmail: p.email,
      requesterName: p.clientName,
      contactId,
      fromCustomer: true,
    });
    await auditOpsEvent(tx, OPS_ENTITY_MAP["tickets"]!, actor, "portal_create", ticket.id, `client portal: ${p.clientName} opened #${ticket.number}`);
    return { id: ticket.id, number: ticket.number };
  });
}

/** Reply as the client: an inbound message, re-opening a pending/solved ticket. */
export async function replyPortalTicket(p: PortalPrincipal, id: string, input: { body: unknown }) {
  const body = cleanText(input.body, "reply", 20_000);
  return inScope(p, async (tx, scope) => {
    const t = await ticketInScope(tx, p, scope, id);
    if (t.status === "closed") throw new OpsError(409, "This ticket is closed. Open a new ticket to write again.");
    const m = await appendCustomerMessage(tx, p.workspaceId, t, { fromEmail: p.email, body });
    await auditOpsEvent(tx, OPS_ENTITY_MAP["tickets"]!, actorOf(p), "portal_reply", t.id, `client portal: ${p.clientName} replied on #${t.number}`);
    return { id: m.id, ticketId: t.id };
  });
}

// ── Documents (already shared with this client) ─────────────────────────────

export async function listPortalDocuments(p: PortalPrincipal, now: Date = new Date()) {
  return inScope(p, async (tx, scope) => {
    const [reports, envelopes, rooms] = await Promise.all([
      tx.report.findMany({
        where: { clientId: p.clientId, client: { workspaceId: p.workspaceId }, status: { in: ["ready", "sent"] }, pdfPath: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { id: true, period: true, status: true, sentAt: true, createdAt: true, template: { select: { name: true } } },
      }),
      tx.esignEnvelope.findMany({
        where: {
          workspaceId: p.workspaceId,
          status: { not: "draft" },
          signers: { some: { email: { in: scope.emails, mode: "insensitive" } } },
        },
        orderBy: { updatedAt: "desc" },
        take: 100,
        select: { id: true, title: true, status: true, updatedAt: true, sealedPdfHash: true },
      }),
      tx.fundingShareLink.findMany({
        where: {
          workspaceId: p.workspaceId,
          revoked: false,
          viewerEmails: { hasSome: scope.emails },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { token: true, createdAt: true, expiresAt: true, doc: { select: { title: true } } },
      }),
    ]);
    return {
      reports: reports.map((r) => ({
        id: r.id,
        title: r.template?.name ? `${r.template.name}, ${r.period}` : `Report, ${r.period}`,
        sentAt: (r.sentAt ?? r.createdAt).toISOString(),
      })),
      signatures: envelopes.map((e) => ({ id: e.id, title: e.title, status: e.status, updatedAt: e.updatedAt.toISOString(), downloadable: e.status === "completed" && !!e.sealedPdfHash })),
      // Data rooms keep their own access control (/r/funding verifies the
      // viewer's email); the portal only links to them.
      dataRooms: rooms.map((l) => ({
        href: `/r/funding/${encodeURIComponent(l.token)}`,
        title: l.doc?.title ?? "Data room",
        sharedAt: l.createdAt.toISOString(),
        expiresAt: l.expiresAt?.toISOString() ?? null,
      })),
    };
  });
}

/** A report PDF assigned to this client (bytes from report storage). */
export async function portalReportPdf(p: PortalPrincipal, id: string): Promise<{ pdf: Buffer; filename: string }> {
  const r = await withWorkspaceScope(p.workspaceId, (tx) =>
    tx.report.findFirst({
      where: { id, clientId: p.clientId, client: { workspaceId: p.workspaceId }, status: { in: ["ready", "sent"] }, pdfPath: { not: null } },
      include: { template: { select: { name: true } } },
    }),
  );
  if (!r?.pdfPath) throw new PortalNotFoundError("Report");
  const abs = path.isAbsolute(r.pdfPath) ? r.pdfPath : path.join(process.cwd(), r.pdfPath);
  let pdf: Buffer;
  try {
    pdf = await fs.readFile(abs);
  } catch {
    throw new OpsError(410, "This report's file is no longer available. Ask us to send it again.");
  }
  const filename = `${(r.template?.name ?? "report").replace(/[^a-z0-9-_]+/gi, "-")}-${r.period.replace(/[^a-z0-9-_]+/gi, "-")}.pdf`;
  return { pdf, filename };
}

/** The sealed (completed) e-sign PDF for an envelope this client signed. */
export async function portalSignedPdf(p: PortalPrincipal, id: string): Promise<{ pdf: Buffer; filename: string }> {
  return inScope(p, async (tx, scope) => {
    const e = await tx.esignEnvelope.findFirst({
      where: { id, workspaceId: p.workspaceId, status: "completed", signers: { some: { email: { in: scope.emails, mode: "insensitive" } } } },
      select: { title: true, sealedPdf: true },
    });
    if (!e?.sealedPdf) throw new PortalNotFoundError("Signed document");
    return { pdf: Buffer.from(e.sealedPdf), filename: `${e.title.replace(/[^a-z0-9-_]+/gi, "-").slice(0, 80) || "signed"}.pdf` };
  });
}
