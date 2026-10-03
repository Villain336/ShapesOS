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
//       never suppress — mirrors lib/calls/reminders.ts). Direct mail
//       (postcard|letter) skips this: timing is the date-based in-home
//       window (mailDate + USPS transit) — see ./mail-channel.ts.
//   (c) per-workspace daily cap → suppress "cap". Pre-checked when queueing;
//       enforced atomically when a row is claimed for sending (advisory lock
//       per workspace-day, then count + conditional claim in one transaction
//       — see claimWithinDailyCap). Mail pieces keep their own count check
//       in ./mail-channel.ts (shared counter).
//   (d) approval → Phase 3 is MANUAL-ONLY: without a valid approved
//       ApprovalItem the message stays "queued" (a pending ApprovalItem is
//       created when none was supplied). Nothing sends autonomously. Direct
//       mail instead uses T1's MailApproval (binds creativeHash + pieceCount
//       + maxSpendCents) via queueMailPiece — it is not an OutboundMessage.
//   (e) claim → meter → provider send → "sent". The row is claimed first
//       (queued → sending, one winner — overlapping cron runs / approve
//       clicks never double-send), credits are metered BEFORE the provider
//       call (a cap_exceeded result suppresses "credit_cap"), and the
//       provider gets the message id as its idempotency key. Every send is
//       audit-logged. A "sending" claim older than SENDING_STALE_MS is
//       recovered by dispatchDue (see recoverStaleSends).
//       Mail provider calls are owned by T1's lib/mail/service.ts
//       (executeCampaign = the money gate); dispatchDue sweeps due+approved
//       nurture MailCampaigns through it.
//
// Voice: accepted in the input type for forward-compat but NOT implemented
// in R3 — queueMessage throws an explicit error rather than silently
// dropping it. Mail channels likewise throw in queueMessage: use
// queueMailPiece (lib/messaging/mail-channel.ts).

import { prisma } from "@/lib/prisma";
import { meter } from "@/lib/metering/service";
import { auditEvent } from "@/lib/auditlog";
import type { OutboundMessage, Prisma } from "@prisma/client";
import { getConsent, type ConsentChannel } from "./consent";
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
import { isMailChannel, dispatchDueNurtureMail } from "./mail-channel";

import {
  requestApproval,
  decideApproval,
  approvalKindFor,
  type MessageKind,
} from "./approvals";
// Approval primitives live in ./approvals.ts (re-exported here so the
// dispatcher contract is unchanged); the mail channel imports them from
// there directly to avoid an import cycle.
export { requestApproval, decideApproval, approvalKindFor, type MessageKind };

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type MessageChannel = "sms" | "email" | "voice" | "postcard" | "letter";

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
  /** Mail-only: Studio creative id + USPS transit assumption (days). */
  mail?: { creativeId?: string; inHomeTransitDays?: [number, number] };
  /** Sequence context for mail-step approvals (kind "sequence_send"). */
  sequence?: { sequenceId: string; enrollmentId: string; stepIndex: number };
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
  const biz = settings.businessName?.trim() || "ShapesOS workspace";
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

type SuppressionReason =
  | "opt_out"
  | "no_consent"
  | "cap"
  | "credit_cap"
  | "invalid_contact"
  | "invalid_address";

/** Consent ledger channel for a dispatch channel (mail → "mail"). */
function consentChannelFor(channel: MessageChannel): ConsentChannel {
  return isMailChannel(channel) ? "mail" : (channel as ConsentChannel);
}

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

/**
 * Sends this UTC day — the daily-cap counter: rows sent/delivered today plus
 * rows claimed today and still "sending" (in flight to the provider). A
 * failed or requeued send drops out of the count by itself, so the counter
 * can never drift from the rows.
 */
function sentTodayWhere(workspaceId: string, now: Date): Prisma.OutboundMessageWhereInput {
  const dayStart = utcDayStart(now);
  return {
    workspaceId,
    OR: [
      { status: { in: ["sent", "delivered"] }, sentAt: { gte: dayStart } },
      { status: "sending", claimedAt: { gte: dayStart } },
    ],
  };
}

/** Pre-check only (queue time). The authority is claimWithinDailyCap. */
async function sentTodayCount(workspaceId: string, now: Date): Promise<number> {
  return prisma.outboundMessage.count({ where: sentTodayWhere(workspaceId, now) });
}

/**
 * Claim one queued message for sending, atomically against the workspace's
 * daily cap. A transaction-scoped advisory lock keyed on (workspace, UTC day)
 * serializes every claim for that workspace-day; inside it the count and the
 * conditional claim (queued → sending) run as one unit, so N concurrent
 * claims can never all see headroom and overshoot the cap (the Phase 2
 * check-then-act gap). Over the cap the row is suppressed "cap" instead.
 */
async function claimWithinDailyCap(
  messageId: string,
  workspaceId: string,
  dailyCap: number,
  now: Date = new Date(),
): Promise<"claimed" | "cap" | "lost"> {
  const lockKey = `outbound-daily-cap:${workspaceId}:${now.toISOString().slice(0, 10)}`;
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const sentToday = await tx.outboundMessage.count({ where: sentTodayWhere(workspaceId, now) });
      if (sentToday >= dailyCap) {
        const res = await tx.outboundMessage.updateMany({
          where: { id: messageId, status: "queued" },
          data: { status: "suppressed", suppressionReason: "cap" },
        });
        return res.count === 1 ? "cap" : "lost";
      }
      const claim = await tx.outboundMessage.updateMany({
        where: { id: messageId, status: "queued" },
        data: { status: "sending", claimedAt: now },
      });
      return claim.count === 1 ? "claimed" : "lost";
    },
    { maxWait: 15_000, timeout: 15_000 },
  );
}

export async function queueMessage(input: QueueMessageInput): Promise<OutboundMessage> {
  if (input.channel === "voice") {
    throw new Error("voice channel is not implemented in R3 messaging core");
  }
  // Direct mail is queued through queueMailPiece (./mail-channel.ts), which
  // creates a T1 MailCampaign + MailPiece per step-run and routes approval
  // through T1's MailApproval. It is not an OutboundMessage row.
  if (isMailChannel(input.channel)) {
    throw new Error(
      "postcard/letter queue via queueMailPiece (lib/messaging/mail-channel.ts), not queueMessage",
    );
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

/** A claim older than this is presumed abandoned (worker died mid-send). */
export const SENDING_STALE_MS = 10 * 60 * 1000;

/** Providers whose sends dedupe on the idempotency key (safe to retry). */
function providerDedupes(provider: string): boolean {
  return provider === "resend" || provider === "fake";
}

/** Update a row only while it is still queued (another run may own it now). */
async function updateIfQueued(id: string, data: Prisma.OutboundMessageUpdateManyMutationInput) {
  return prisma.outboundMessage.updateMany({ where: { id, status: "queued" }, data });
}

async function attemptSend(messageId: string): Promise<OutboundMessage> {
  return (await claimAndSend(messageId)).row;
}

async function claimAndSend(messageId: string): Promise<{ row: OutboundMessage; claimed: boolean }> {
  // Claim first: queued → sending, atomically within the daily cap. Exactly
  // one concurrent caller flips the row; everyone else returns it untouched.
  // Nothing below runs unclaimed.
  const target = await prisma.outboundMessage.findUnique({
    where: { id: messageId },
    select: { workspaceId: true },
  });
  if (!target) throw new Error("message not found");
  const settings = await getMessagingSettings(target.workspaceId);
  const outcome = await claimWithinDailyCap(messageId, target.workspaceId, settings.dailyCap);
  const msg = await prisma.outboundMessage.findUnique({
    where: { id: messageId },
    include: { lead: { select: { id: true, phone: true, email: true } } },
  });
  if (!msg) throw new Error("message not found");
  // "cap": this caller suppressed the row (it reports it, like a send).
  if (outcome === "cap") return { row: msg, claimed: true };
  if (outcome !== "claimed") return { row: msg, claimed: false };
  return { row: await sendClaimed(msg), claimed: true };
}

/** The provider leg for a row this caller has claimed (status "sending"). */
async function sendClaimed(
  msg: OutboundMessage & { lead: { id: string; phone: string | null; email: string | null } | null },
): Promise<OutboundMessage> {
  const channel = msg.channel as "sms" | "email";
  const lead = msg.lead;
  const to = channel === "sms" ? lead?.phone : lead?.email;
  if (!to) {
    return prisma.outboundMessage.update({
      where: { id: msg.id },
      data: { status: "suppressed", suppressionReason: "invalid_contact", claimedAt: null },
    });
  }

  // Meter BEFORE the provider call so the credit hard cap actually stops the
  // send. Idempotency key = message id: a recovered/retried claim is never
  // charged twice. (The ledger is append-only, so a send the provider then
  // rejects keeps its one charge.)
  let metered: Awaited<ReturnType<typeof meter>>;
  try {
    metered = await meter({
      workspaceId: msg.workspaceId,
      action: meterAction(channel),
      credits: messageCredits(channel, msg.body),
      idempotencyKey: `outbound-message:${msg.id}`,
      evidenceRef: `outbound-message:${msg.id}`,
    });
  } catch (e) {
    // Credits could not be confirmed — do not send; release the claim so the
    // next sweep retries.
    return prisma.outboundMessage.update({
      where: { id: msg.id },
      data: {
        status: "queued",
        claimedAt: null,
        error: `metering error: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
      },
    });
  }
  if (!metered.ok) {
    const suppressed = await prisma.outboundMessage.update({
      where: { id: msg.id },
      data:
        metered.reason === "cap_exceeded"
          ? { status: "suppressed", suppressionReason: "credit_cap", claimedAt: null, error: metered.message.slice(0, 500) }
          : { status: "failed", claimedAt: null, error: `metering blocked: ${metered.reason} — ${metered.message}`.slice(0, 500) },
    });
    await auditEvent({
      projectId: null,
      workspaceId: msg.workspaceId,
      action: "alert_failed",
      summary: `R3 messaging: ${channel} ${msg.kind} NOT sent to lead ${msg.leadId} — metering ${metered.reason}`,
      actor: "ai",
    });
    return suppressed;
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
      const res = await provider.sendSms({ to, from, body: msg.body, idempotencyKey: msg.id });
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
        idempotencyKey: msg.id,
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
        claimedAt: null,
      },
    });

    await auditEvent({
      projectId: null,
      workspaceId: msg.workspaceId,
      action: "alert_sent",
      summary:
        `R3 messaging: ${channel} ${msg.kind} sent to lead ${msg.leadId} ` +
        `(sid ${providerSid}, ${costCents}¢, ${metered.charged}cr)`,
      actor: "ai",
    });
    return updated;
  } catch (e) {
    const message = e instanceof Error ? e.message : "provider send failed";
    const failed = await prisma.outboundMessage.update({
      where: { id: msg.id },
      data: { status: "failed", claimedAt: null, error: message.slice(0, 500) },
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
 * Recover "sending" claims older than SENDING_STALE_MS (the claiming worker
 * died between claim and final write). When the provider dedupes on the
 * idempotency key (Resend, fake) the row is requeued — a retry re-uses the
 * same key, so at most one message reaches the lead, and metering is keyed
 * the same way. Otherwise (Twilio) the outcome is unknown and a retry could
 * double-text the lead, so the row is failed loudly instead.
 */
export async function recoverStaleSends(
  workspaceId?: string,
  now: Date = new Date(),
): Promise<{ requeued: number; failed: number }> {
  const cutoff = new Date(now.getTime() - SENDING_STALE_MS);
  const stale = await prisma.outboundMessage.findMany({
    where: {
      status: "sending",
      claimedAt: { lt: cutoff },
      ...(workspaceId ? { workspaceId } : {}),
    },
    select: { id: true, provider: true },
    take: 500,
  });
  const out = { requeued: 0, failed: 0 };
  for (const row of stale) {
    const retry = providerDedupes(row.provider);
    const res = await prisma.outboundMessage.updateMany({
      where: { id: row.id, status: "sending", claimedAt: { lt: cutoff } },
      data: retry
        ? { status: "queued", claimedAt: null, error: "stale send claim recovered; retried with the same idempotency key" }
        : {
            status: "failed",
            claimedAt: null,
            error:
              `send outcome unknown: the send stalled after claiming and ${row.provider} has no ` +
              `idempotency key, so it is not retried automatically (avoids a duplicate)`,
          },
    });
    if (res.count === 1) out[retry ? "requeued" : "failed"] += 1;
  }
  return out;
}

/**
 * Send every queued message that is due and approved. Re-checks consent,
 * quiet hours, the daily cap, and approval status per row — an opt-out or a
 * rejection that landed after queueing is honored here. Safe to run
 * concurrently (cron + approve clicks): every write is guarded on
 * status "queued" and attemptSend claims before sending.
 */
export async function dispatchDue(workspaceId?: string): Promise<DispatchResult> {
  const now = new Date();
  const out: DispatchResult = { sent: 0, suppressed: 0, failed: 0 };
  const recovered = await recoverStaleSends(workspaceId, now);
  out.failed += recovered.failed;
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
    const channel = msg.channel as MessageChannel;
    if (channel === "voice" || !msg.leadId) {
      const res = await updateIfQueued(msg.id, { status: "suppressed", suppressionReason: "invalid_contact" });
      out.suppressed += res.count;
      continue;
    }

    // (a) consent re-check.
    const consent = await getConsent(msg.workspaceId, msg.leadId, consentChannelFor(channel));
    if (consent !== "opted_in") {
      const res = await updateIfQueued(msg.id, {
        status: "suppressed",
        suppressionReason: consent === "opted_out" ? "opt_out" : "no_consent",
      });
      out.suppressed += res.count;
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
        const res = await updateIfQueued(msg.id, { status: "failed", error: `approval ${item.status}` });
        out.failed += res.count;
        continue;
      }
    }

    // (b) quiet hours re-check — defer, keep queued.
    const settings = await getMessagingSettings(msg.workspaceId);
    const tz = await resolveRecipientTimezone(msg.workspaceId, msg.lead);
    if (isQuietHour(now, tz, settings.quietStart, settings.quietEnd)) {
      await updateIfQueued(msg.id, { scheduledFor: nextQuietEnd(now, tz, settings.quietEnd) });
      continue;
    }

    // (c) daily cap: enforced atomically by the claim (claimWithinDailyCap);
    // an over-cap row comes back suppressed "cap".
    const { row: sent, claimed } = await claimAndSend(msg.id);
    // Another run claimed it first: that run sends and counts it.
    if (!claimed) continue;
    if (sent.status === "sent" || sent.status === "delivered") out.sent += 1;
    else if (sent.status === "failed") out.failed += 1;
    else if (sent.status === "suppressed") out.suppressed += 1;
  }

  // Direct mail: due + approved nurture MailCampaigns → T1 executeCampaign
  // (the money gate). Mail pieces are not OutboundMessage rows.
  const mailWorkspaces = workspaceId
    ? [workspaceId]
    : (await prisma.workspace.findMany({ select: { id: true } })).map((w) => w.id);
  for (const wsId of mailWorkspaces) {
    const mail = await dispatchDueNurtureMail(wsId, now);
    out.sent += mail.sent;
    out.suppressed += mail.suppressed;
    out.failed += mail.failed;
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
