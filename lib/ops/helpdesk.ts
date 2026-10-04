// ShapesOS Phase 10 (ops-core) — helpdesk: tickets, SLA timers, inbound
// email → ticket threading, replies through the messaging email provider.
//
// Status flow: new → open → pending (waiting on the customer) → solved →
// closed; solved reopens on a customer reply, closed is terminal (a new
// message after close opens a new ticket). SLA targets come from the
// workspace's OpsSlaPolicy for the ticket's priority (calendar minutes from
// creation); breaches are COMPUTED (slaState) and recorded once by the SLA
// sweep, which notifies through the existing notification producers.
//
// Inbound email reaches here only through the existing signed inbound route
// (lib/messaging/inbound-email.ts handleInboundEmail) — the workspace comes
// from the signed address, never from the payload.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OpsError, OpsNotFoundError, auditOpsEvent, type OpsActor } from "./doctype";
import { OPS_ENTITY_MAP } from "./entities";
import { assertWorkspaceUser } from "./people";
import { normalizeEmail } from "./crm";

type Tx = Prisma.TransactionClient;
import type { TicketPriority } from "./helpdesk-sla";
export type { TicketPriority };
export type TicketStatus = "new" | "open" | "pending" | "solved" | "closed";

// Pure helpers live in ./helpdesk-sla (client-safe); re-exported here.
import { DEFAULT_SLA, slaDueDates, slaState, ticketNumberFromSubject, normalizeSubject, replySubject } from "./helpdesk-sla";
export { DEFAULT_SLA, slaDueDates, slaState, ticketNumberFromSubject, normalizeSubject, replySubject };
export type { SlaClock, SlaState } from "./helpdesk-sla";

export const TICKET_STATUS_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  new: ["open", "pending", "solved", "closed"],
  open: ["pending", "solved", "closed"],
  pending: ["open", "solved", "closed"],
  solved: ["open", "closed"],
  closed: [],
};

// ---------------------------------------------------------------------------
// Tickets (OPS_ENTITIES hooks)
// ---------------------------------------------------------------------------

async function policyFor(tx: Tx, workspaceId: string, priority: TicketPriority) {
  const p = await tx.opsSlaPolicy.findFirst({ where: { workspaceId, priority, active: true } });
  return p ?? DEFAULT_SLA[priority];
}

/** Next per-workspace ticket number (serialized by a tx-scoped advisory lock). */
async function nextTicketNumber(tx: Tx, workspaceId: string): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"ops_ticket_number:" + workspaceId}))`;
  const agg = await tx.opsTicket.aggregate({ where: { workspaceId }, _max: { number: true } });
  return (agg._max.number ?? 0) + 1;
}

async function contactForEmail(tx: Tx, workspaceId: string, email: string | null) {
  if (!email) return null;
  return tx.opsContact.findFirst({ where: { workspaceId, email }, select: { id: true, name: true } });
}

export interface NewTicketInput {
  subject: string;
  body?: string;
  priority?: TicketPriority;
  channel?: "email" | "web" | "phone" | "chat" | "agent";
  requesterEmail?: string | null;
  requesterName?: string | null;
  contactId?: string | null;
  assigneeId?: string | null;
  /** Inbound email id when the ticket comes from mail (idempotency). */
  providerSid?: string | null;
}

export async function createTicket(tx: Tx, actor: OpsActor, input: NewTicketInput) {
  const priority = input.priority ?? "normal";
  const email = normalizeEmail(input.requesterEmail ?? null);
  if (input.assigneeId) await assertWorkspaceUser(tx, actor.workspaceId, input.assigneeId);
  let contactId = input.contactId ?? null;
  if (contactId) {
    const c = await tx.opsContact.findFirst({ where: { id: contactId, workspaceId: actor.workspaceId } });
    if (!c) throw new OpsNotFoundError("contacts", contactId);
  } else {
    contactId = (await contactForEmail(tx, actor.workspaceId, email))?.id ?? null;
  }
  const now = new Date();
  const number = await nextTicketNumber(tx, actor.workspaceId);
  const ticket = await tx.opsTicket.create({
    data: {
      workspaceId: actor.workspaceId,
      number,
      subject: input.subject.trim().slice(0, 300) || "(no subject)",
      priority,
      channel: input.channel ?? "web",
      requesterEmail: email,
      requesterName: input.requesterName?.trim().slice(0, 200) || null,
      contactId,
      assigneeId: input.assigneeId ?? null,
      ...slaDueDates(now, await policyFor(tx, actor.workspaceId, priority)),
      lastMessageAt: now,
      createdBy: actor.userId,
    },
  });
  if (input.body?.trim()) {
    await tx.opsTicketMessage.create({
      data: {
        workspaceId: actor.workspaceId,
        ticketId: ticket.id,
        direction: input.channel === "email" ? "inbound" : "note",
        authorUserId: input.channel === "email" ? null : actor.userId,
        fromEmail: input.channel === "email" ? email : null,
        body: input.body.trim().slice(0, 50_000),
        providerSid: input.providerSid ?? null,
      },
    });
  }
  return ticket;
}

export async function createTicketRow(tx: Tx, actor: OpsActor, body: Record<string, unknown>) {
  return createTicket(tx, actor, {
    subject: String(body.subject),
    body: body.body as string | undefined,
    priority: body.priority as TicketPriority | undefined,
    channel: (body.channel as NewTicketInput["channel"]) ?? "web",
    requesterEmail: body.requesterEmail as string | undefined,
    requesterName: body.requesterName as string | undefined,
    contactId: body.contactId as string | undefined,
    assigneeId: body.assigneeId as string | undefined,
  }) as unknown as Promise<Record<string, unknown>>;
}

export async function patchTicketRow(tx: Tx, actor: OpsActor, id: string, patch: Record<string, unknown>, existing: Record<string, unknown>) {
  const data: Record<string, unknown> = { ...patch };
  if (typeof patch.assigneeId === "string") await assertWorkspaceUser(tx, actor.workspaceId, patch.assigneeId);
  if (typeof patch.priority === "string" && patch.priority !== existing.priority) {
    // Re-target the SLA from the original creation time; a recorded breach
    // stays recorded.
    Object.assign(data, slaDueDates(new Date(String(existing.createdAt)), await policyFor(tx, actor.workspaceId, patch.priority as TicketPriority)));
  }
  if (typeof patch.status === "string" && patch.status !== existing.status) {
    const now = new Date();
    if (patch.status === "solved") data.solvedAt = now;
    if (patch.status === "closed") data.closedAt = now;
    if (patch.status === "open" || patch.status === "pending") data.solvedAt = null;
  }
  const claimed = await tx.opsTicket.updateMany({ where: { id, workspaceId: actor.workspaceId, status: existing.status as TicketStatus }, data });
  if (claimed.count !== 1) throw new OpsError(409, "Ticket changed concurrently — reload and retry");
  return (await tx.opsTicket.findFirst({ where: { id, workspaceId: actor.workspaceId } })) as unknown as Record<string, unknown>;
}

export async function addTicketNote(tx: Tx, actor: OpsActor, ticketId: string, body: string) {
  const t = await tx.opsTicket.findFirst({ where: { id: ticketId, workspaceId: actor.workspaceId } });
  if (!t) throw new OpsNotFoundError("tickets", ticketId);
  const text = body.trim();
  if (!text) throw new OpsError(400, "Note is empty");
  const m = await tx.opsTicketMessage.create({
    data: { workspaceId: actor.workspaceId, ticketId, direction: "note", authorUserId: actor.userId, body: text.slice(0, 50_000) },
  });
  await auditOpsEvent(tx, OPS_ENTITY_MAP["tickets"]!, actor, "note", ticketId, `internal note on #${t.number}`);
  return m;
}

// ---------------------------------------------------------------------------
// Replies (out through the messaging email provider)
// ---------------------------------------------------------------------------

export interface TicketReplyDeps {
  sendEmail?: (input: { to: string; subject: string; text: string; html: string; replyTo?: string; idempotencyKey: string; workspaceId: string }) => Promise<{ providerSid: string }>;
  meterSend?: (workspaceId: string, messageId: string) => Promise<{ ok: boolean; message?: string }>;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Production deps: metering + the configured email provider (Resend or fake). */
export const defaultTicketReplyDeps: Required<TicketReplyDeps> = {
  async meterSend(workspaceId, messageId) {
    const { meter } = await import("@/lib/metering/service");
    const r = await meter({ workspaceId, action: "email_send", credits: 1, idempotencyKey: `ticket-message:${messageId}`, evidenceRef: `ticket-message:${messageId}` });
    return r.ok ? { ok: true } : { ok: false, message: r.message };
  },
  async sendEmail(input) {
    const { getEmailProvider, ProviderNotConfiguredError } = await import("@/lib/messaging/provider");
    const { getMessagingSettings } = await import("@/lib/messaging/quiet-hours");
    const provider = getEmailProvider();
    const settings = await getMessagingSettings(input.workspaceId);
    const from =
      settings.emailFrom?.trim() ||
      (process.env.MESSAGING_EMAIL_FROM ?? "").trim() ||
      (provider.name === "fake" ? "no-reply@example.com" : "");
    if (!from) throw new ProviderNotConfiguredError("resend", "MESSAGING_EMAIL_FROM");
    const res = await provider.sendEmail({
      to: input.to,
      from,
      fromName: settings.emailFromName?.trim() || settings.businessName?.trim() || undefined,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo: input.replyTo,
      idempotencyKey: input.idempotencyKey,
    });
    return { providerSid: res.providerSid };
  },
};

/**
 * Send a reply to the ticket's requester. Three steps so no provider call
 * runs inside a DB transaction: (1) record the outbound message as queued,
 * (2) meter + send (Reply-To = the workspace support address, subject token
 * [#n] threads the answer back), (3) mark sent/failed and stamp the first
 * response. A failed send is recorded, never silently dropped.
 */
export async function sendTicketReply(
  actor: OpsActor,
  ticketId: string,
  input: { body: string; status?: "pending" | "solved" | "open" },
  deps: TicketReplyDeps = {},
) {
  const d = { ...defaultTicketReplyDeps, ...deps };
  const text = input.body.trim();
  if (!text) throw new OpsError(400, "Reply is empty");
  const { ticket, message } = await withWorkspaceScope(actor.workspaceId, async (tx) => {
    const ticket = await tx.opsTicket.findFirst({ where: { id: ticketId, workspaceId: actor.workspaceId } });
    if (!ticket) throw new OpsNotFoundError("tickets", ticketId);
    if (ticket.status === "closed") throw new OpsError(409, "Ticket is closed — open a new ticket to write again");
    if (!ticket.requesterEmail) throw new OpsError(422, "This ticket has no requester email to reply to");
    const message = await tx.opsTicketMessage.create({
      data: {
        workspaceId: actor.workspaceId,
        ticketId,
        direction: "outbound",
        authorUserId: actor.userId,
        toEmail: ticket.requesterEmail,
        body: text.slice(0, 50_000),
        deliveryStatus: "queued",
      },
    });
    return { ticket, message };
  });

  let providerSid: string | null = null;
  let error: string | null = null;
  try {
    const metered = await d.meterSend(actor.workspaceId, message.id);
    if (!metered.ok) throw new Error(`metering blocked: ${metered.message ?? "cap"}`);
    const { supportAddressForSend } = await import("@/lib/messaging/inbound-email");
    const res = await d.sendEmail({
      workspaceId: actor.workspaceId,
      to: ticket.requesterEmail!,
      subject: replySubject(ticket.subject, ticket.number),
      text,
      html: `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`,
      replyTo: supportAddressForSend(actor.workspaceId),
      idempotencyKey: message.id,
    });
    providerSid = res.providerSid;
  } catch (e) {
    error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  }

  return withWorkspaceScope(actor.workspaceId, async (tx) => {
    const now = new Date();
    const sent = await tx.opsTicketMessage.update({
      where: { id: message.id, workspaceId: actor.workspaceId },
      data: error ? { deliveryStatus: "failed", error } : { deliveryStatus: "sent", providerSid },
    });
    let updated = ticket;
    if (!error) {
      const nextStatus = input.status ?? "pending";
      const data: Prisma.OpsTicketUpdateInput = { lastMessageAt: now, status: nextStatus };
      if (!ticket.firstRespondedAt) data.firstRespondedAt = now;
      if (nextStatus === "solved") data.solvedAt = now;
      updated = await tx.opsTicket.update({ where: { id: ticketId, workspaceId: actor.workspaceId }, data });
    }
    await auditOpsEvent(tx, OPS_ENTITY_MAP["tickets"]!, actor, error ? "reply_failed" : "reply_sent", ticketId, `reply on #${ticket.number} to ${ticket.requesterEmail}${error ? ` failed: ${error}` : ""}`);
    return { ticket: updated, message: sent, sent: !error, error };
  });
}

// ---------------------------------------------------------------------------
// Inbound email → ticket (called by lib/messaging/inbound-email.ts)
// ---------------------------------------------------------------------------

export interface InboundTicketMail {
  emailId: string;
  from: string | null;
  fromName?: string | null;
  subject: string | null;
  text: string;
}

export type InboundTicketResult =
  | { action: "ticket_created"; ticketId: string; number: number }
  | { action: "ticket_threaded"; ticketId: string; number: number }
  | { action: "duplicate"; ticketId: string };

/**
 * Open or thread a ticket for one verified inbound email. Threads when the
 * subject carries [#n] of a ticket whose requester is this sender, or when
 * the sender has a not-closed ticket with the same normalized subject;
 * otherwise opens a new ticket. Idempotent per email id.
 */
export async function routeInboundEmailToTicket(workspaceId: string, mail: InboundTicketMail): Promise<InboundTicketResult> {
  const actor: OpsActor = { workspaceId, userId: "system:inbound-email" };
  return withWorkspaceScope(workspaceId, async (tx) => {
    const dupe = await tx.opsTicketMessage.findFirst({ where: { workspaceId, providerSid: mail.emailId }, select: { ticketId: true } });
    if (dupe) return { action: "duplicate", ticketId: dupe.ticketId } as const;
    const from = normalizeEmail(mail.from);
    const now = new Date();
    let target = null as Awaited<ReturnType<typeof tx.opsTicket.findFirst>>;
    const n = ticketNumberFromSubject(mail.subject);
    if (n != null && from) {
      target = await tx.opsTicket.findFirst({ where: { workspaceId, number: n, requesterEmail: from, status: { not: "closed" } } });
    }
    if (!target && from) {
      const subjectKey = normalizeSubject(mail.subject);
      const candidates = await tx.opsTicket.findMany({
        where: { workspaceId, requesterEmail: from, status: { not: "closed" } },
        orderBy: { lastMessageAt: "desc" },
        take: 20,
      });
      target = candidates.find((c) => subjectKey && normalizeSubject(c.subject) === subjectKey) ?? null;
    }
    if (target) {
      await tx.opsTicketMessage.create({
        data: { workspaceId, ticketId: target.id, direction: "inbound", fromEmail: from, body: (mail.text || "(no text)").slice(0, 50_000), providerSid: mail.emailId },
      });
      await tx.opsTicket.update({
        where: { id: target.id, workspaceId },
        data: {
          lastMessageAt: now,
          // A customer reply re-opens a pending/solved ticket.
          ...(target.status === "pending" || target.status === "solved" ? { status: "open", solvedAt: null } : {}),
        },
      });
      await auditOpsEvent(tx, OPS_ENTITY_MAP["tickets"]!, actor, "inbound_threaded", target.id, `email from ${from} threaded onto #${target.number}`);
      return { action: "ticket_threaded", ticketId: target.id, number: target.number } as const;
    }
    const ticket = await createTicket(tx, actor, {
      subject: (mail.subject ?? "").replace(/\[#\d+\]/g, "").trim() || "(no subject)",
      body: mail.text || "(no text)",
      channel: "email",
      requesterEmail: from,
      requesterName: mail.fromName ?? null,
      providerSid: mail.emailId,
    });
    await auditOpsEvent(tx, OPS_ENTITY_MAP["tickets"]!, actor, "inbound_created", ticket.id, `email from ${from ?? "unknown sender"} opened #${ticket.number}`);
    return { action: "ticket_created", ticketId: ticket.id, number: ticket.number } as const;
  });
}

// ---------------------------------------------------------------------------
// SLA sweep (cron) — record + notify breaches once
// ---------------------------------------------------------------------------

export interface SlaBreach {
  ticketId: string;
  number: number;
  subject: string;
  kind: "first_response" | "resolution";
  assigneeId: string | null;
}

/** Record newly breached open tickets (slaBreachedAt set once, guarded). */
export async function runSlaSweep(tx: Tx, workspaceId: string, now = new Date()): Promise<SlaBreach[]> {
  const open = await tx.opsTicket.findMany({
    where: {
      workspaceId,
      slaBreachedAt: null,
      status: { in: ["new", "open", "pending"] },
      OR: [{ firstResponseDueAt: { lt: now } }, { resolutionDueAt: { lt: now } }],
    },
    take: 1000,
  });
  const out: SlaBreach[] = [];
  for (const t of open) {
    const s = slaState(t, now);
    if (!s.breach) continue;
    const claimed = await tx.opsTicket.updateMany({ where: { id: t.id, workspaceId, slaBreachedAt: null }, data: { slaBreachedAt: now, slaBreachKind: s.breach } });
    if (claimed.count === 1) out.push({ ticketId: t.id, number: t.number, subject: t.subject, kind: s.breach, assigneeId: t.assigneeId });
  }
  return out;
}

/** Cron entry: sweep each workspace, then notify after the scoped tx commits. */
export async function sweepAllSla(workspaceIds: string[], notify: (workspaceId: string, b: SlaBreach) => Promise<unknown>, now = new Date()) {
  const results: Array<{ workspaceId: string; breached: number; error?: string }> = [];
  for (const ws of workspaceIds) {
    try {
      const breaches = await withWorkspaceScope(ws, (tx) => runSlaSweep(tx, ws, now));
      for (const b of breaches) await notify(ws, b);
      if (breaches.length) results.push({ workspaceId: ws, breached: breaches.length });
    } catch (e) {
      results.push({ workspaceId: ws, breached: 0, error: e instanceof Error ? e.message.slice(0, 200) : "sweep failed" });
    }
  }
  return results;
}

/** Every workspace id (the cron sweeps each under its own GUC). */
export async function allWorkspaceIds(): Promise<string[]> {
  return (await prisma.workspace.findMany({ select: { id: true }, take: 10_000 })).map((w) => w.id);
}
