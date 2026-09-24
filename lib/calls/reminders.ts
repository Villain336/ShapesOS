// Marketr — appointment booking (R5): reminder queue + sending.
//
// A booking queues three reminders (confirmation, 24h, 1h). Sending goes
// through the MailPort interface: production injects a Resend-backed port
// (lib/newsletter/resend.ts); without email credentials the LogMailPort
// records the send on the Reminder row and logs the content server-side.
// The Reminder row is the audit trail either way.
//
// TCPA / quiet-hours posture:
// - Reminders only exist when the booking captured explicit consent
//   (consentGiven); handleBookingSubmit rejects consent:false.
// - A booking that opted out (remindersOptedOut) or is cancelled gets every
//   pending reminder marked skipped_opt_out — never sent.
// - Quiet hours are 21:00–07:59 in the booking page's timezone. A reminder
//   due inside quiet hours is DEFERRED to 08:00 local (dueAt pushed, row
//   stays "scheduled") — it is never sent in the dark.

import { prisma } from "@/lib/prisma";

/** Quiet hours: 21:00–07:59 local. */
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 8;

export function localHour(d: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  });
  return Number(fmt.format(d));
}

export function isQuietHour(d: Date, tz: string): boolean {
  const h = localHour(d, tz);
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/** Next 08:00 local after `d`, as a UTC instant. Minute-steps up to 48h so
 * DST transitions are handled naturally; the fallback is unreachable. */
export function nextQuietEnd(d: Date, tz: string): Date {
  const probe = new Date(d.getTime() + 60_000);
  for (let i = 0; i < 48 * 60; i++) {
    if (localHour(probe, tz) === QUIET_END_HOUR) return probe;
    probe.setTime(probe.getTime() + 60_000);
  }
  return new Date(d.getTime() + 12 * 3600 * 1000);
}

export interface MailPort {
  send(opts: { to: string; subject: string; body: string }): Promise<{ ok: boolean; error?: string }>;
}

/** Dev/test port: marks sent and logs server-side. Not a real send. */
export class LogMailPort implements MailPort {
  readonly sent: Array<{ to: string; subject: string; body: string }> = [];
  async send(opts: { to: string; subject: string; body: string }): Promise<{ ok: boolean; error?: string }> {
    this.sent.push(opts);
    // eslint-disable-next-line no-console
    console.log(`[calls:mail:stub] to=${opts.to} subject=${opts.subject}`);
    return { ok: true };
  }
}

export async function queueBookingReminders(opts: {
  bookingId: string;
  workspaceId: string;
  pageTitle: string;
  timezone: string;
  toEmail: string | null;
}): Promise<void> {
  if (!opts.toEmail) return; // no email on file — nothing to queue
  const booking = await prisma.booking.findFirst({
    where: { id: opts.bookingId, workspaceId: opts.workspaceId },
    select: { startAt: true, name: true },
  });
  if (!booking) return;
  const now = new Date();
  const rows: Array<{ kind: string; dueAt: Date; subject: string; body: string }> = [
    {
      kind: "confirmation",
      dueAt: now,
      subject: `Confirmed: ${opts.pageTitle}`,
      body: `Hi ${booking.name},\n\nYour appointment "${opts.pageTitle}" is confirmed for ${booking.startAt.toISOString()}.\n\nReply STOP to opt out of reminders.`,
    },
  ];
  const r24 = new Date(booking.startAt.getTime() - 24 * 3600 * 1000);
  if (r24.getTime() > now.getTime()) {
    rows.push({
      kind: "reminder_24h",
      dueAt: r24,
      subject: `Reminder: ${opts.pageTitle} tomorrow`,
      body: `Hi ${booking.name},\n\nReminder: your appointment "${opts.pageTitle}" is tomorrow at ${booking.startAt.toISOString()}.\n\nReply STOP to opt out of reminders.`,
    });
  }
  const r1 = new Date(booking.startAt.getTime() - 3600 * 1000);
  if (r1.getTime() > now.getTime()) {
    rows.push({
      kind: "reminder_1h",
      dueAt: r1,
      subject: `Reminder: ${opts.pageTitle} in one hour`,
      body: `Hi ${booking.name},\n\nReminder: your appointment "${opts.pageTitle}" starts in one hour (${booking.startAt.toISOString()}).\n\nReply STOP to opt out of reminders.`,
    });
  }
  for (const r of rows) {
    await prisma.reminder.create({
      data: {
        workspaceId: opts.workspaceId,
        bookingId: opts.bookingId,
        kind: r.kind,
        channel: "email",
        to: opts.toEmail,
        subject: r.subject,
        body: r.body,
        status: "scheduled",
        dueAt: r.dueAt,
      },
    });
  }
}

export interface SendDueResult {
  sent: number;
  deferredQuietHours: number;
  skippedOptOut: number;
}

/**
 * Send all due reminders. Idempotent per row: a row already "sent" is never
 * re-sent. Quiet-hour deferral pushes dueAt to 08:00 local and keeps the
 * row scheduled.
 */
export async function sendDueReminders(opts: {
  now?: Date;
  mail?: MailPort;
}): Promise<SendDueResult> {
  const now = opts.now ?? new Date();
  const mail = opts.mail ?? new LogMailPort();
  const due = await prisma.reminder.findMany({
    where: { status: "scheduled", dueAt: { lte: now } },
    include: { booking: { select: { status: true, remindersOptedOut: true, consentGiven: true, pageId: true } } },
    take: 500,
  });
  // Batch page settings lookups: group by booking page.
  const pageIds = [...new Set(due.map((r) => r.booking.pageId))];
  const pages = await prisma.bookingPage.findMany({
    where: { id: { in: pageIds } },
    select: { id: true, settings: true },
  });
  const tzByPage = new Map(pages.map((p) => [p.id, String((p.settings as Record<string, unknown> | null)?.timezone ?? "America/New_York")]));
  const out: SendDueResult = { sent: 0, deferredQuietHours: 0, skippedOptOut: 0 };
  for (const r of due) {
    const booking = r.booking;
    if (booking.status === "cancelled" || booking.remindersOptedOut || !booking.consentGiven) {
      await prisma.reminder.update({
        where: { id: r.id },
        data: { status: "skipped_opt_out", failReason: "opted out, cancelled, or no consent" },
      });
      out.skippedOptOut += 1;
      continue;
    }
    const tz = tzByPage.get(r.booking.pageId) ?? "America/New_York";
    if (isQuietHour(now, tz)) {
      await prisma.reminder.update({
        where: { id: r.id },
        data: { dueAt: nextQuietEnd(now, tz) },
      });
      out.deferredQuietHours += 1;
      continue;
    }
    const res = await mail.send({ to: r.to, subject: r.subject, body: r.body });
    if (res.ok) {
      await prisma.reminder.update({
        where: { id: r.id },
        data: { status: "sent", sentAt: new Date() },
      });
      await prisma.booking.update({
        where: { id: r.bookingId },
        data: { remindersSent: { increment: 1 } },
      });
      out.sent += 1;
    } else {
      await prisma.reminder.update({
        where: { id: r.id },
        data: { status: "failed", failReason: res.error ?? "mail port failed" },
      });
    }
  }
  return out;
}

/** Opt a booking out of all reminders (STOP handling, settings UI). */
export async function recordOptOut(bookingId: string, workspaceId: string): Promise<void> {
  await prisma.booking.updateMany({
    where: { id: bookingId, workspaceId },
    data: { remindersOptedOut: true },
  });
  await prisma.reminder.updateMany({
    where: { bookingId, workspaceId, status: "scheduled" },
    data: { status: "skipped_opt_out", failReason: "recipient opted out" },
  });
}
