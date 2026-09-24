// Marketr — R3 messaging core: dispatcher.
//
// THE CONTRACT other agents code against. Three exports:
//   queueMessage(input)      — enqueue one message through every gate
//   requestApproval(input)   — open a human approval item
//   dispatchDue(workspaceId?) — send everything queued, due, and approved
//
// (Replaces the temporary stub the sequences agent carried while this
// module was being built; signatures are unchanged so no caller changes
// were needed.)
//
// Gate order — enforced in queueMessage AND re-checked in dispatchDue:
//   (a) consent  → opted_out → suppress "opt_out"; anything but opted_in →
//       suppress "no_consent". NEVER sends without explicit opt-in.
//   (b) quiet hours → DEFER scheduledFor to the window's end (reschedule,
//       never suppress — mirrors lib/calls/reminders.ts).
//   (c) per-workspace daily cap → suppress "cap".
//   (d) approval → Phase 3 is MANUAL-ONLY: without a valid approved
//       ApprovalItem the message stays "queued" (a pending ApprovalItem is
//       created when none was supplied). Nothing sends autonomously.
//   (e) provider send → "sent"; every send is meter()ed and audit-logged.
//
// Voice: accepted in the input type for forward-compat but NOT implemented
// in R3 — queueMessage throws an explicit error rather than silently
// dropping it.

import { prisma } from "@/lib/prisma";
import { meter } from "@/lib/metering/service";
import { auditEvent } from "@/lib/auditlog";
import type { ApprovalItem, OutboundMessage } from "@prisma/client";
import { getConsent } from "./consent";
import {
  getMessagingSettings,
  resolveRecipientTimezone,
  isQuietHour,
  nextQuietEnd,
  PHYSICAL_ADDRESS_PLACEHOLDER,
} from "./quiet-hours";
import {
  getSmsProvider,
  getEmailProvider,
  smsSegments,
  ProviderNotConfiguredError,
} from "./provider";
import { signUnsubscribeToken } from "./consent";

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type MessageChannel = "sms" | "email" | "voice";
export type MessageKind =
  | "sequence"
  | "speed_to_lead"
  | "missed_call_textback"
  | "review_request"
  | "broadcast"
  | "manual";

export interface QueueMessageInput {
  workspaceId: string;
  leadId?: string;
  channel: MessageChannel;
  kind: MessageKind;
  subject?: string;
  body: string;
  approvalId?: string;
  scheduledFor?: Date;
  requestedBy?: string;
}

export interface DispatchResult {
  sent: number;
  suppressed: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Costs & metering
// ---------------------------------------------------------------------------

/** Raw vendor-cost ledger: SMS 1¢/segment; email 0.1¢ → rounds to 0¢ in the
 * integer-cent ledger (metering still charges 1 credit per email). */
export function messageCostCents(channel: "sms" | "email", body: string): number {
  if (channel === "sms") return smsSegments(body); // 1¢ per segment
  return 0;
}

/** Metering credits per send: cost-plus ≈4× raw vendor cost (1¢ → 4cr);
 * email floors at 1 credit (integer credits, 1 credit = $0.01). */
export function messageCredits(channel: "sms" | "email", body: string): number {
  if (channel === "sms") return 4 * smsSegments(body);
  return 1;
}

function meterAction(channel: "sms" | "email"): string {
  return channel === "sms" ? "sms_send" : "email_send";
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** QueueMessageInput.kind → ApprovalItem.kind for auto-created approvals.
 * ApprovalItem.kind is a free-form string in the schema; requestApproval
 * accepts any non-empty kind so sibling agents (reviews: "review_request")
 * can use their own vocabulary. */
export function approvalKindFor(kind: MessageKind): string {
  switch (kind) {
    case "review_request":
      return "review_response";
    case "broadcast":
      return "broadcast";
    default:
      return "sequence_send";
  }
}

export async function requestApproval(input: {
  workspaceId: string;
  kind: string;
  payload: unknown;
  requestedBy?: string;
}): Promise<ApprovalItem> {
  const kind = (input.kind ?? "").trim();
  if (!kind) throw new Error("approval kind is required");
  return prisma.approvalItem.create({
    data: {
      workspaceId: input.workspaceId,
      kind,
      payload: (input.payload ?? {}) as object,
      status: "pending",
      requestedBy: input.requestedBy ?? null,
    },
  });
}

export async function decideApproval(
  id: string,
  workspaceId: string,
  decision: "approve" | "reject",
  decidedBy?: string,
  note?: string,
): Promise<ApprovalItem> {
  const item = await prisma.approvalItem.findFirst({ where: { id, workspaceId } });
  if (!item) throw new Error("Approval item not found");
  if (item.status !== "pending") {
    throw new Error(`Approval item is already ${item.status}`);
  }
  return prisma.approvalItem.update({
    where: { id },
    data: {
      status: decision === "approve" ? "approved" : "rejected",
      decidedBy: decidedBy ?? null,
      decidedAt: new Date(),
      note: note ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Email composition (CAN-SPAM)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function publicOrigin(): string {
  return (
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

/**
 * Every marketing email carries: RFC 2369 / RFC 8058 List-Unsubscribe headers
 * plus a footer with the one-click unsubscribe link and the workspace's
 * physical address (CAN-SPAM). The unsubscribe token is per-message.
 */
async function composeMarketingEmail(
  workspaceId: string,
  messageId: string,
  body: string,
  leadId: string | null,
): Promise<{ html: string; text: string; headers: Record<string, string> }> {
  const settings = await getMessagingSettings(workspaceId);
  const token = signUnsubscribeToken({ workspaceId, messageId, leadId: leadId ?? undefined });
  const unsubUrl = `${publicOrigin()}/api/messaging/unsubscribe?token=${token}`;
  const host = unsubUrl.split("://")[1]?.split("/")[0] ?? "localhost";
  const biz = settings.businessName?.trim() || "Marketr workspace";
  const addr = settings.physicalAddress?.trim() || PHYSICAL_ADDRESS_PLACEHOLDER;
  const html =
    `<div>${escapeHtml(body).replace(/\n/g, "<br>")}</div>` +
    `<br><hr>` +
    `<p style="font-size:12px;color:#666">${escapeHtml(biz)}<br>${escapeHtml(addr)}<br>` +
    `<a href="${escapeHtml(unsubUrl)}">Unsubscribe</a></p>`;
  const text = `${body}\n\n--\n${biz}\n${addr}\nUnsubscribe: ${unsubUrl}`;
  return {
    html,
    text,
    headers: {
      "List-Unsubscribe": `<${unsubUrl}>, <mailto:unsubscribe@${host}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

// ---------------------------------------------------------------------------
// queueMessage
// ---------------------------------------------------------------------------

type SuppressionReason = "opt_out" | "no_consent" | "cap" | "invalid_contact";

async function createSuppressed(
  workspaceId: string,
  input: QueueMessageInput,
  reason: SuppressionReason,
  provider: string,
): Promise<OutboundMessage> {
  return prisma.outboundMessage.create({
    data: {
      workspaceId,
      leadId: input.leadId ?? null,
      channel: input.channel,
      direction: "outbound",
      kind: input.kind,
      subject: input.subject ?? null,
      body: input.body,
      status: "suppressed",
      suppressionReason: reason,
      provider,
      approvalId: input.approvalId ?? null,
      scheduledFor: input.scheduledFor ?? null,
      costCents: 0,
    },
  });
}

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Sends (status sent/delivered) this UTC day — the daily-cap counter. */
async function sentTodayCount(workspaceId: string, now: Date): Promise<number> {
  return prisma.outboundMessage.count({
    where: {
      workspaceId,
      status: { in: ["sent", "delivered"] },
      sentAt: { gte: utcDayStart(now) },
    },
  });
}

export async function queueMessage(input: QueueMessageInput): Promise<OutboundMessage> {
  if (input.channel === "voice") {
    throw new Error("voice channel is not implemented in R3 messaging core");
  }
  const channel = input.channel as "sms" | "email";
  const body = (input.body ?? "").trim();
  if (!body) throw new Error("message body is required");
  if (!input.leadId) throw new Error("leadId is required to queue a message");
  if (channel === "email" && !(input.subject ?? "").trim()) {
    throw new Error("email subject is required");
  }

  const providerName =
    channel === "sms"
      ? (process.env.MESSAGING_SMS_PROVIDER ?? "fake").trim().toLowerCase()
      : (process.env.MESSAGING_EMAIL_PROVIDER ?? "fake").trim().toLowerCase();

  const lead = await prisma.lead.findFirst({
    where: { id: input.leadId, workspaceId: input.workspaceId },
    select: { id: true, phone: true, email: true, customFields: true },
  });
  if (!lead) throw new Error("lead not found in workspace");
  const to = channel === "sms" ? lead.phone : lead.email;
  if (!to) {
    return createSuppressed(input.workspaceId, input, "invalid_contact", providerName);
  }

  // (a) consent — never send without explicit opt-in.
  const consent = await getConsent(input.workspaceId, input.leadId, channel);
  if (consent === "opted_out") {
    return createSuppressed(input.workspaceId, input, "opt_out", providerName);
  }
  if (consent !== "opted_in") {
    return createSuppressed(input.workspaceId, input, "no_consent", providerName);
  }

  // (b) quiet hours — defer, never drop.
  const settings = await getMessagingSettings(input.workspaceId);
  const tz = await resolveRecipientTimezone(input.workspaceId, lead);
  const now = new Date();
  let scheduledFor = input.scheduledFor ?? now;
  if (isQuietHour(scheduledFor, tz, settings.quietStart, settings.quietEnd)) {
    scheduledFor = nextQuietEnd(scheduledFor, tz, settings.quietEnd);
  }

  // (c) daily cap.
  if ((await sentTodayCount(input.workspaceId, now)) >= settings.dailyCap) {
    return createSuppressed(input.workspaceId, input, "cap", providerName);
  }

  // (d) approval — Phase 3 is manual-only.
  let approvalId = input.approvalId ?? null;
  let approved = false;
  if (approvalId) {
    const item = await prisma.approvalItem.findFirst({
      where: { id: approvalId, workspaceId: input.workspaceId },
    });
    if (!item) throw new Error("approval item not found");
    if (item.status === "rejected" || item.status === "expired") {
      throw new Error(`approval item is ${item.status}`);
    }
    approved = item.status === "approved";
  } else {
    const item = await requestApproval({
      workspaceId: input.workspaceId,
      kind: approvalKindFor(input.kind),
      payload: {
        messageKind: input.kind,
        channel,
        leadId: input.leadId,
        subject: input.subject ?? null,
        body,
        scheduledFor: scheduledFor.toISOString(),
      },
      requestedBy: input.requestedBy,
    });
    approvalId = item.id;
  }

  const row = await prisma.outboundMessage.create({
    data: {
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      channel,
      direction: "outbound",
      kind: input.kind,
      subject: input.subject ?? null,
      body,
      status: "queued",
      provider: providerName,
      approvalId,
      scheduledFor,
      costCents: 0,
    },
  });

  // (e) eligible + due → send inline; otherwise the cron / approval-approve
  // path picks it up via dispatchDue().
  if (approved && scheduledFor.getTime() <= Date.now()) {
    return attemptSend(row.id);
  }
  return row;
}

// ---------------------------------------------------------------------------
// attemptSend — one row through the provider, metered + audit-logged
// ---------------------------------------------------------------------------

async function attemptSend(messageId: string): Promise<OutboundMessage> {
  const msg = await prisma.outboundMessage.findUnique({
    where: { id: messageId },
    include: { lead: { select: { id: true, phone: true, email: true } } },
  });
  if (!msg) throw new Error("message not found");
  if (msg.status !== "queued") return msg;
  const channel = msg.channel as "sms" | "email";
  const lead = msg.lead;
  const to = channel === "sms" ? lead?.phone : lead?.email;
  if (!to) {
    return prisma.outboundMessage.update({
      where: { id: msg.id },
      data: { status: "suppressed", suppressionReason: "invalid_contact" },
    });
  }

  const settings = await getMessagingSettings(msg.workspaceId);
  try {
    let providerSid: string;
    let delivered = false;
    if (channel === "sms") {
      const provider = getSmsProvider();
      const from =
        settings.smsFromNumber?.trim() ||
        (process.env.MESSAGING_SMS_FROM ?? "").trim() ||
        undefined;
      const res = await provider.sendSms({ to, from, body: msg.body });
      providerSid = res.providerSid;
      delivered = res.delivered ?? false;
    } else {
      const provider = getEmailProvider();
      // A real provider must never send from a blank address; the fake
      // provider gets a dev-only fallback so tests don't need env config.
      const from =
        settings.emailFrom?.trim() ||
        (process.env.MESSAGING_EMAIL_FROM ?? "").trim() ||
        (process.env.BOOKING_MAIL_FROM ?? "").trim() ||
        (provider.name === "fake" ? "no-reply@example.com" : "");
      if (!from) throw new ProviderNotConfiguredError("resend", "MESSAGING_EMAIL_FROM");
      const composed = await composeMarketingEmail(msg.workspaceId, msg.id, msg.body, msg.leadId);
      const res = await provider.sendEmail({
        to,
        from,
        fromName: settings.emailFromName?.trim() || settings.businessName?.trim() || undefined,
        subject: msg.subject ?? "",
        html: composed.html,
        text: composed.text,
        headers: composed.headers,
      });
      providerSid = res.providerSid;
      delivered = res.delivered ?? false;
    }

    const costCents = messageCostCents(channel, msg.body);
    const finalStatus = delivered ? "delivered" : "sent";
    const updated = await prisma.outboundMessage.update({
      where: { id: msg.id },
      data: {
        status: finalStatus,
        sentAt: new Date(),
        deliveredAt: delivered ? new Date() : null,
        providerSid,
        costCents,
      },
    });

    // Meter every send. Idempotency key = message id: a retried dispatch
    // never double-charges. Meter failure is audit-loud but does not unsend.
    let meterNote = "";
    try {
      const metered = await meter({
        workspaceId: msg.workspaceId,
        action: meterAction(channel),
        credits: messageCredits(channel, msg.body),
        idempotencyKey: `outbound-message:${msg.id}`,
        evidenceRef: providerSid,
      });
      if (!metered.ok) {
        meterNote = ` [metering ${metered.reason}]`;
        await prisma.outboundMessage.update({
          where: { id: msg.id },
          data: { error: `metering blocked: ${metered.reason} — ${metered.message}` },
        });
      }
    } catch (e) {
      meterNote = " [metering error]";
      await prisma.outboundMessage.update({
        where: { id: msg.id },
        data: {
          error: `metering error: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
        },
      });
    }

    await auditEvent({
      projectId: null,
      workspaceId: msg.workspaceId,
      action: "alert_sent",
      summary:
        `R3 messaging: ${channel} ${msg.kind} sent to lead ${msg.leadId} ` +
        `(sid ${providerSid}, ${costCents}¢)${meterNote}`,
      actor: "ai",
    });
    return updated;
  } catch (e) {
    const message = e instanceof Error ? e.message : "provider send failed";
    const failed = await prisma.outboundMessage.update({
      where: { id: msg.id },
      data: { status: "failed", error: message.slice(0, 500) },
    });
    await auditEvent({
      projectId: null,
      workspaceId: msg.workspaceId,
      action: "alert_failed",
      summary: `R3 messaging: ${channel} ${msg.kind} failed for lead ${msg.leadId}: ${message.slice(0, 200)}`,
      actor: "ai",
    });
    return failed;
  }
}

// ---------------------------------------------------------------------------
// dispatchDue — the cron / post-approval sweep
// ---------------------------------------------------------------------------

/**
 * Send every queued message that is due and approved. Re-checks consent,
 * quiet hours, the daily cap, and approval status per row — an opt-out or a
 * rejection that landed after queueing is honored here.
 */
export async function dispatchDue(workspaceId?: string): Promise<DispatchResult> {
  const now = new Date();
  const out: DispatchResult = { sent: 0, suppressed: 0, failed: 0 };
  const due = await prisma.outboundMessage.findMany({
    where: {
      status: "queued",
      direction: "outbound",
      ...(workspaceId ? { workspaceId } : {}),
      OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
    },
    include: { lead: { select: { id: true, customFields: true } } },
    orderBy: { createdAt: "asc" },
    take: 500,
  });

  for (const msg of due) {
    const channel = msg.channel as "sms" | "email" | "voice";
    if (channel === "voice" || !msg.leadId) {
      await prisma.outboundMessage.update({
        where: { id: msg.id },
        data: { status: "suppressed", suppressionReason: "invalid_contact" },
      });
      out.suppressed += 1;
      continue;
    }

    // (a) consent re-check.
    const consent = await getConsent(msg.workspaceId, msg.leadId, channel);
    if (consent !== "opted_in") {
      await prisma.outboundMessage.update({
        where: { id: msg.id },
        data: {
          status: "suppressed",
          suppressionReason: consent === "opted_out" ? "opt_out" : "no_consent",
        },
      });
      out.suppressed += 1;
      continue;
    }

    // (d) approval re-check — pending waits for the human.
    if (msg.approvalId) {
      const item = await prisma.approvalItem.findUnique({
        where: { id: msg.approvalId },
        select: { status: true },
      });
      if (!item || item.status === "pending") continue;
      if (item.status !== "approved") {
        await prisma.outboundMessage.update({
          where: { id: msg.id },
          data: { status: "failed", error: `approval ${item.status}` },
        });
        out.failed += 1;
        continue;
      }
    }

    // (b) quiet hours re-check — defer, keep queued.
    const settings = await getMessagingSettings(msg.workspaceId);
    const tz = await resolveRecipientTimezone(msg.workspaceId, msg.lead);
    if (isQuietHour(now, tz, settings.quietStart, settings.quietEnd)) {
      await prisma.outboundMessage.update({
        where: { id: msg.id },
        data: { scheduledFor: nextQuietEnd(now, tz, settings.quietEnd) },
      });
      continue;
    }

    // (c) daily cap re-check.
    if ((await sentTodayCount(msg.workspaceId, now)) >= settings.dailyCap) {
      await prisma.outboundMessage.update({
        where: { id: msg.id },
        data: { status: "suppressed", suppressionReason: "cap" },
      });
      out.suppressed += 1;
      continue;
    }

    const sent = await attemptSend(msg.id);
    if (sent.status === "sent" || sent.status === "delivered") out.sent += 1;
    else if (sent.status === "failed") out.failed += 1;
    else out.suppressed += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Missed-call text-back (called from lib/calls/inbound.ts — best-effort)
// ---------------------------------------------------------------------------

/**
 * Queue a text-back for a missed call. Only fires when the caller matches a
 * lead with explicit SMS opt-in. Under the manual-only approval policy the
 * message stays queued behind a pending ApprovalItem until a human approves.
 */
export async function queueMissedCallTextback(input: {
  workspaceId: string;
  leadId: string;
  requestedBy?: string;
}): Promise<OutboundMessage | null> {
  const consent = await getConsent(input.workspaceId, input.leadId, "sms");
  if (consent !== "opted_in") return null;
  const [lead, settings] = await Promise.all([
    prisma.lead.findFirst({
      where: { id: input.leadId, workspaceId: input.workspaceId },
      select: { name: true },
    }),
    getMessagingSettings(input.workspaceId),
  ]);
  if (!lead) return null;
  const firstName = (lead.name ?? "").split(/\s+/)[0] || "there";
  const biz = settings.businessName?.trim() ? ` from ${settings.businessName.trim()}` : "";
  return queueMessage({
    workspaceId: input.workspaceId,
    leadId: input.leadId,
    channel: "sms",
    kind: "missed_call_textback",
    body:
      `Hi ${firstName}, sorry we missed your call${biz}. ` +
      `Reply to this text and we'll get right back to you. Reply STOP to opt out.`,
    requestedBy: input.requestedBy ?? "missed-call-textback",
  });
}
