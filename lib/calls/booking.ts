// Marketr — appointment booking (R5): booking pages + slots.
//
// Public token-gated pages (same pattern as CRM capture forms): the
// unguessable token `mkbook_<32 hex>` (stored as sha256) IS the capability.
// Availability is computed from the page's working hours (in its IANA
// timezone) minus existing scheduled bookings plus the buffer. A booking
// creates or attaches to a lead (email first, then phone) and logs an
// attribution touch (channel "booking") so C2 sees it.
//
// TCPA posture: `consentGiven` is REQUIRED on the booking POST (unchecked =
// 400, no reminders ever sent); `remindersOptedOut` suppresses all future
// sends; quiet hours (21:00–08:00 in the page's timezone) are enforced by
// lib/calls/reminders.ts when reminders are actually sent.

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { InMemoryRateLimiter } from "@/lib/mcp/rateLimit";
import { createLeadRecord } from "@/lib/crm/leads";
import { channelFor, logTouch } from "@/lib/attribution/touches";
import { logActivity } from "@/lib/crm/dedup";
import { queueBookingReminders } from "./reminders";
import { isValidTimeZone, zonedParts as zonedWallParts, zonedTimeToUtc } from "@/lib/time/zoned";

/** sha256 hex of a booking-page token (the token itself is never stored). */
export function hashBookingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Public token format: mkbook_<32 hex>. */
export function newBookingToken(): { token: string; prefix: string } {
  const token = `mkbook_${randomBytes(16).toString("hex")}`;
  return { token, prefix: token.slice(0, 12) + "…" };
}

export const BOOKING_LIMIT = 10; // submissions per window
export const BOOKING_WINDOW_MS = 60_000;
export const BOOKING_BODY_LIMIT = 4096;

const limiter = new InMemoryRateLimiter();

/** Test seam: reset the booking rate limiter between battery runs. */
export function resetBookingLimiter(): void {
  limiter.reset();
}

export const DaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
// Partial record: a page may define hours for only some days (closed days
// are simply omitted, not zeroed).
export const WorkingHoursSchema = z
  .record(DaySchema, z.tuple([z.number().int().min(0).max(1440), z.number().int().min(0).max(1440)]).optional())
  .optional();

export const BookingSettingsSchema = z.object({
  durationMin: z.number().int().min(5).max(480).default(30),
  bufferMin: z.number().int().min(0).max(120).default(10),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isValidTimeZone, { message: "timezone must be an IANA name such as America/New_York" })
    .default("America/New_York"),
  workingHours: WorkingHoursSchema,
});

export type BookingSettings = z.infer<typeof BookingSettingsSchema>;

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Local parts of an instant in an IANA timezone. */
export function zonedParts(d: Date, tz: string): { weekday: string; minutes: number; ymd: string } {
  const p = zonedWallParts(d, tz);
  return { weekday: DAYS[p.weekday], minutes: p.minutes, ymd: p.ymd };
}

/**
 * Compute open slots between `from` and `to` (defaults: now → +14 days).
 * Slots start on durationMin boundaries inside working hours; a slot is open
 * when it doesn't overlap any scheduled booking's busy window
 * (start-buffer … end+buffer). Returned as UTC ISO strings.
 */
export interface AvailabilitySlot {
  startAt: string;
  endAt: string;
}

export async function getAvailability(opts: {
  pageId: string;
  workspaceId: string;
  from?: Date;
  to?: Date;
}): Promise<{ slots: AvailabilitySlot[]; settings: BookingSettings }> {
  const page = await prisma.bookingPage.findFirst({
    where: { id: opts.pageId, workspaceId: opts.workspaceId, enabled: true },
    select: { id: true, settings: true },
  });
  if (!page) throw new Error("Booking page not found");
  const settings = BookingSettingsSchema.parse((page.settings as Record<string, unknown>) ?? {});
  const tz = settings.timezone;
  const wh = settings.workingHours ?? {
    mon: [540, 1020],
    tue: [540, 1020],
    wed: [540, 1020],
    thu: [540, 1020],
    fri: [540, 1020],
  };

  const from = opts.from ?? new Date();
  const to = opts.to ?? new Date(Date.now() + 14 * 24 * 3600 * 1000);
  const bookings = await prisma.booking.findMany({
    where: {
      pageId: page.id,
      status: "scheduled",
      startAt: { lt: to },
      endAt: { gt: from },
    },
    select: { startAt: true, endAt: true },
  });
  const busy = bookings.map((b) => ({
    s: b.startAt.getTime() - settings.bufferMin * 60_000,
    e: b.endAt.getTime() + settings.bufferMin * 60_000,
  }));

  const slots: AvailabilitySlot[] = [];
  // Walk LOCAL calendar dates in the page's timezone (step by date, never by
  // 24h of milliseconds) and convert each local slot start to an instant on
  // its own, so DST days produce exactly the offered local slots: a slot
  // whose local time doesn't exist (spring-forward gap) is skipped, and one
  // that occurs twice (fall-back) is offered once, at its first occurrence.
  const first = zonedWallParts(from, tz);
  for (let day = 0; day < 62; day++) {
    const date = new Date(Date.UTC(first.year, first.month - 1, first.day + day));
    const [y, mo, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (zonedTimeToUtc(y, mo, d, 0, tz).date.getTime() >= to.getTime()) break;
    const hours = wh[DAYS[date.getUTCDay()] as keyof typeof wh];
    if (!hours) continue;
    const [open, close] = hours;
    for (let m = open; m + settings.durationMin <= close; m += settings.durationMin) {
      const local = zonedTimeToUtc(y, mo, d, m, tz);
      if (local.resolution === "gap") continue;
      const s = local.date.getTime();
      const e = s + settings.durationMin * 60_000;
      if (s < from.getTime()) continue;
      if (s >= to.getTime()) break;
      const overlaps = busy.some((b) => s < b.e && e > b.s);
      if (!overlaps) slots.push({ startAt: new Date(s).toISOString(), endAt: new Date(e).toISOString() });
    }
  }
  return { slots, settings };
}

export const BookingSubmitSchema = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(2000).optional(),
  startAt: z.string().datetime({ offset: true }),
  // TCPA: explicit consent to receive booking reminders. Required.
  consent: z.boolean().refine((v) => v === true, { message: "Consent is required for reminders" }),
  // Optional UTM capture for the attribution touch.
  utm: z
    .object({
      utm_source: z.string().trim().max(160).optional(),
      utm_medium: z.string().trim().max(80).optional(),
      utm_campaign: z.string().trim().max(160).optional(),
    })
    .optional(),
});

export interface BookingSubmitResult {
  status: number;
  json: Record<string, unknown>;
  headers?: Record<string, string>;
}

export async function findBookingPageByToken(token: string) {
  if (!token.startsWith("mkbook_") || token.length > 80) return null;
  return prisma.bookingPage.findUnique({
    where: { tokenHash: hashBookingToken(token) },
  });
}

/**
 * True when `startAt` is one of the page's offered working-hours slots: the
 * local weekday has hours, the local start sits on the slot grid
 * (open + k·durationMin), and the slot fits inside [open, close].
 * Uses the same grid math as getAvailability so the two can never disagree.
 */
export function isOfferedSlot(
  settings: z.infer<typeof BookingSettingsSchema>,
  startAt: Date
): boolean {
  const wh = settings.workingHours ?? {
    mon: [540, 1020], tue: [540, 1020], wed: [540, 1020], thu: [540, 1020], fri: [540, 1020],
  };
  const lp = zonedWallParts(startAt, settings.timezone);
  const hours = wh[DAYS[lp.weekday] as keyof typeof wh];
  if (!hours) return false;
  const [open, close] = hours;
  const m = lp.minutes;
  if (!(m >= open && m + settings.durationMin <= close && (m - open) % settings.durationMin === 0)) return false;
  // Must be the exact instant getAvailability offers for that local slot
  // (whole minute; on a fall-back day, the first of the two 01:30s).
  return zonedTimeToUtc(lp.year, lp.month, lp.day, m, settings.timezone).date.getTime() === startAt.getTime();
}

/**
 * Handle one public booking submission. `rawBody` is the raw request text;
 * `ip` is used for rate limiting.
 */
export async function handleBookingSubmit(opts: {
  token: string;
  rawBody: string;
  ip: string;
}): Promise<BookingSubmitResult> {
  const { token, rawBody, ip } = opts;
  const page = await findBookingPageByToken(token);
  if (!page || !page.enabled) {
    return { status: 404, json: { error: "Not found" } };
  }

  const rl = await limiter.check(`booking:${page.id}:${ip}`, BOOKING_LIMIT, BOOKING_WINDOW_MS);
  if (!rl.allowed) {
    return {
      status: 429,
      json: { error: "Too many requests, please try again shortly" },
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
    };
  }
  if (rawBody.length > BOOKING_BODY_LIMIT) {
    return { status: 413, json: { error: "Request too large" } };
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, json: { error: "Invalid JSON" } };
  }
  const parsed = BookingSubmitSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, json: { error: "Invalid booking", issues: parsed.error.issues } };
  }
  const b = parsed.data;
  if (!b.email && !b.phone) {
    return { status: 400, json: { error: "An email or phone number is required" } };
  }

  const startAt = new Date(b.startAt);
  if (Number.isNaN(startAt.getTime()) || startAt.getTime() < Date.now() - 60_000) {
    return { status: 400, json: { error: "startAt must be a future ISO timestamp" } };
  }

  const settings = BookingSettingsSchema.parse((page.settings as Record<string, unknown>) ?? {});
  // Offered-slot check: the requested start must be one of the page's real
  // working-hours slots (same grid getAvailability uses). Without this, an
  // attacker could book arbitrary off-hours times the page never offered.
  if (!isOfferedSlot(settings, startAt)) {
    return { status: 400, json: { error: "That time isn't offered on this booking page" } };
  }

  // Availability re-check at booking time (race-safe: DB unique slot guard
  // is the backstop — see the overlap transaction below).
  const endAt = new Date(startAt.getTime() + settings.durationMin * 60_000);
  const clash = await prisma.booking.findFirst({
    where: {
      pageId: page.id,
      status: "scheduled",
      startAt: { lt: new Date(endAt.getTime() + settings.bufferMin * 60_000) },
      endAt: { gt: new Date(startAt.getTime() - settings.bufferMin * 60_000) },
    },
    select: { id: true },
  });
  if (clash) {
    return { status: 409, json: { error: "That time was just taken — please pick another slot" } };
  }

  // Lead match-or-create: email first, then phone.
  let leadId: string | null = null;
  let createdNewLead = false;
  if (b.email) {
    const hit = await prisma.lead.findFirst({
      where: { workspaceId: page.workspaceId, email: b.email.trim().toLowerCase() },
      select: { id: true },
    });
    if (hit) leadId = hit.id;
  }
  if (!leadId && b.phone) {
    const digits = b.phone.replace(/\D/g, "").slice(-10);
    if (digits) {
      const leads = await prisma.lead.findMany({
        where: { workspaceId: page.workspaceId, phone: { not: null } },
        select: { id: true, phone: true },
        take: 200,
      });
      const hit = leads.find((l) => (l.phone ?? "").replace(/\D/g, "").slice(-10) === digits);
      if (hit) leadId = hit.id;
    }
  }
  if (!leadId) {
    const pipeline = await prisma.pipeline.findFirst({
      where: { workspaceId: page.workspaceId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!pipeline) return { status: 500, json: { error: "No pipeline in workspace" } };
    const res = await createLeadRecord(
      page.workspaceId,
      "booking",
      {
        pipelineId: pipeline.id,
        name: b.name,
        email: b.email?.trim().toLowerCase() || undefined,
        phone: b.phone || undefined,
        source: "booking",
        sourceDetail: `page:${page.title}`,
        campaignFallback: b.utm?.utm_campaign ?? page.title,
        utm: b.utm ?? null,
      },
    );
    if (!res.ok) return { status: res.status, json: { error: res.error } };
    leadId = res.lead.id;
    createdNewLead = true;
  }

  // Booking row. The partial unique index on (pageId, startAt) for scheduled
  // bookings is the race-safe backstop when two submissions pass the clash
  // check above at the same instant — P2002 becomes a 409.
  let bookingId: string;
  try {
    const booking = await prisma.booking.create({
      data: {
        workspaceId: page.workspaceId,
        pageId: page.id,
        leadId,
        name: b.name,
        email: b.email?.trim().toLowerCase() || null,
        phone: b.phone || null,
        startAt,
        endAt,
        status: "scheduled",
        consentGiven: true,
        notes: b.notes || null,
      },
      select: { id: true },
    });
    bookingId = booking.id;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { status: 409, json: { error: "That time was just taken — please pick another slot" } };
    }
    throw e;
  }

  // Attribution touch, UTM-aware. One touch per booking, never two: a NEW lead
  // already carries the booking capture touch from createLeadRecord (with the
  // UTMs), so the explicit touch below is only logged when the lead already
  // existed. Channel follows the same normalization as every other capture
  // path (google/cpc → paid_search; no UTMs → "booking").
  if (!createdNewLead) {
    await logTouch({
      workspaceId: page.workspaceId,
      leadId,
      channel: channelFor("booking", b.utm ?? null),
      source: b.utm?.utm_source?.trim() || "booking-page",
      medium: b.utm?.utm_medium?.trim() || null,
      campaign: b.utm?.utm_campaign?.trim() || page.title,
      touchType: "form",
      occurredAt: new Date(),
      meta: { booking_id: bookingId, page: page.title },
    });
  }

  await logActivity({
    workspaceId: page.workspaceId,
    leadId,
    type: "meeting",
    body: `Appointment booked: ${startAt.toISOString()} (${settings.durationMin} min) via "${page.title}"`,
    actor: "booking",
  });

  // Queue reminders (confirmation + 24h + 1h) — sending is done by the
  // reminder runner (lib/calls/reminders.ts) with quiet-hours enforcement.
  await queueBookingReminders({
    bookingId,
    workspaceId: page.workspaceId,
    pageTitle: page.title,
    timezone: settings.timezone,
    toEmail: b.email?.trim().toLowerCase() || null,
  });

  return { status: 201, json: { ok: true, bookingId, startAt: startAt.toISOString() } };
}
