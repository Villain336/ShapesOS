// Marketr — R3 messaging core: timezone-aware quiet hours + workspace
// messaging settings.
//
// QUIET-HOURS POSTURE (mirrors lib/calls/reminders.ts): a message due inside
// the recipient-local quiet window is DEFERRED to the window's end
// (scheduledFor pushed, row stays "queued") — it is never sent in the dark
// and never dropped.
//
// TIMEZONE RESOLUTION (documented choice):
//   1. Lead.customFields.timezone — the recipient's own timezone when known
//      (e.g. captured on a form or from prior engagement). Most accurate.
//   2. Workspace messaging settings timezone — the business's home timezone
//      for recipients whose timezone is unknown.
//   3. "America/New_York" — the workspace default for Marketr's NC-first
//      user base; deterministic and explicit rather than server-local.
//
// SETTINGS STORAGE: Phase 3's schema migration is locked, so there is no
// dedicated `messaging` column on WorkspaceSettings. The messaging config
// lives at WorkspaceSettings.notificationDefaults.messaging (a JSON key, not
// a column) until a follow-up migration adds a real column — see the TODO
// in getMessagingSettings. Reads always merge over DEFAULTS so a missing
// key behaves like the documented default.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

// TODO(schema): add a dedicated `messaging Json?` column on
// WorkspaceSettings and move this key out of notificationDefaults once the
// Phase 3 migration window reopens.

export interface MessagingSettings {
  /** IANA timezone used when the lead's own timezone is unknown. */
  timezone: string;
  /** Quiet window start, local hour 0–23. Default 21 (9 PM). */
  quietStart: number;
  /** Quiet window end, local hour 0–23. Default 8 (8 AM). */
  quietEnd: number;
  /** Max sends per workspace per UTC day across all channels. */
  dailyCap: number;
  /** E.164 SMS sender (Twilio From). Falls back to MESSAGING_SMS_FROM. */
  smsFromNumber?: string | null;
  /** Email sender address. Falls back to MESSAGING_EMAIL_FROM. */
  emailFrom?: string | null;
  /** Display name for email From. */
  emailFromName?: string | null;
  /** Business name used in text-backs and email footers. */
  businessName?: string | null;
  /** CAN-SPAM postal address. A placeholder ships by default — the workspace
   * must set a real address before marketing email goes out. */
  physicalAddress?: string | null;
}

export const DEFAULT_MESSAGING_SETTINGS: Required<
  Pick<MessagingSettings, "timezone" | "quietStart" | "quietEnd" | "dailyCap">
> = {
  timezone: "America/New_York",
  quietStart: 21,
  quietEnd: 8,
  dailyCap: 500,
};

export const PHYSICAL_ADDRESS_PLACEHOLDER =
  "[Business mailing address — set in workspace messaging settings]";

function sanitize(raw: unknown): Partial<MessagingSettings> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<MessagingSettings> = {};
  if (typeof r.timezone === "string" && r.timezone) out.timezone = r.timezone;
  if (typeof r.quietStart === "number" && r.quietStart >= 0 && r.quietStart < 24) {
    out.quietStart = Math.floor(r.quietStart);
  }
  if (typeof r.quietEnd === "number" && r.quietEnd >= 0 && r.quietEnd < 24) {
    out.quietEnd = Math.floor(r.quietEnd);
  }
  if (typeof r.dailyCap === "number" && r.dailyCap > 0) {
    out.dailyCap = Math.floor(r.dailyCap);
  }
  for (const k of ["smsFromNumber", "emailFrom", "emailFromName", "businessName", "physicalAddress"] as const) {
    if (typeof r[k] === "string") out[k] = r[k];
    else if (r[k] === null) out[k] = null;
  }
  return out;
}

/** Workspace messaging settings merged over defaults. Never throws. */
export async function getMessagingSettings(workspaceId: string): Promise<MessagingSettings> {
  try {
    const row = await prisma.workspaceSettings.findUnique({
      where: { workspaceId },
      select: { notificationDefaults: true },
    });
    const stored = sanitize(
      (row?.notificationDefaults as Record<string, unknown> | null)?.messaging,
    );
    return { ...DEFAULT_MESSAGING_SETTINGS, ...stored };
  } catch {
    return { ...DEFAULT_MESSAGING_SETTINGS };
  }
}

/** Patch the workspace's messaging settings (sequences/settings UI). */
export async function updateMessagingSettings(
  workspaceId: string,
  patch: Partial<MessagingSettings>,
  updatedBy?: string,
): Promise<MessagingSettings> {
  const current = await getMessagingSettings(workspaceId);
  // Strip undefineds so the object is valid Prisma JSON input.
  const merged = JSON.parse(
    JSON.stringify({ ...current, ...sanitize(patch) }),
  ) as Prisma.InputJsonObject;
  const existing = await prisma.workspaceSettings.findUnique({
    where: { workspaceId },
    select: { notificationDefaults: true },
  });
  const defaults =
    existing?.notificationDefaults && typeof existing.notificationDefaults === "object"
      ? (existing.notificationDefaults as Prisma.InputJsonObject)
      : {};
  const notificationDefaults: Prisma.InputJsonValue = { ...defaults, messaging: merged };
  await prisma.workspaceSettings.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      notificationDefaults,
      agentAllowList: [], // non-null column; empty = default policy
      updatedBy: updatedBy ?? null,
    },
    update: {
      notificationDefaults,
      updatedBy: updatedBy ?? null,
    },
  });
  return getMessagingSettings(workspaceId);
}

export interface LeadTimezone {
  customFields?: unknown;
}

/**
 * Recipient-local timezone: lead.customFields.timezone → workspace messaging
 * timezone → "America/New_York". An invalid IANA name falls through to the
 * next source so a bad custom field can never break scheduling.
 */
export async function resolveRecipientTimezone(
  workspaceId: string,
  lead: LeadTimezone | null,
): Promise<string> {
  const settings = await getMessagingSettings(workspaceId);
  const candidates = [
    (lead?.customFields as Record<string, unknown> | null)?.timezone,
    settings.timezone,
    DEFAULT_MESSAGING_SETTINGS.timezone,
  ];
  for (const c of candidates) {
    if (typeof c !== "string" || !c) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: c }).format(new Date());
      return c;
    } catch {
      // invalid IANA name — try the next source
    }
  }
  return DEFAULT_MESSAGING_SETTINGS.timezone;
}

/** Local hour 0–23. `hour12:false` "2-digit" formats midnight as "24"
 * in some locales — normalize to 0. */
export function localHour(d: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  });
  return Number(fmt.format(d)) % 24;
}

/** True when `d` falls inside the quiet window (default 21:00–07:59 local). */
export function isQuietHour(
  d: Date,
  tz: string,
  quietStart = DEFAULT_MESSAGING_SETTINGS.quietStart,
  quietEnd = DEFAULT_MESSAGING_SETTINGS.quietEnd,
): boolean {
  const h = localHour(d, tz);
  if (quietStart === quietEnd) return false; // degenerate: no quiet window
  // Window wraps midnight (e.g. 21:00–08:00): quiet iff h >= start OR h < end.
  if (quietStart > quietEnd) return h >= quietStart || h < quietEnd;
  // Window inside one day (e.g. 02:00–03:00): quiet iff start <= h < end.
  return h >= quietStart && h < quietEnd;
}

/** Next quietEnd:00 local after `d`, as a UTC instant. Minute-steps up to 48h
 * so DST transitions are handled naturally (same approach as
 * lib/calls/reminders.ts nextQuietEnd). */
export function nextQuietEnd(
  d: Date,
  tz: string,
  quietEnd = DEFAULT_MESSAGING_SETTINGS.quietEnd,
): Date {
  const probe = new Date(d.getTime() + 60_000);
  for (let i = 0; i < 48 * 60; i++) {
    if (localHour(probe, tz) === quietEnd) return probe;
    probe.setTime(probe.getTime() + 60_000);
  }
  return new Date(d.getTime() + 12 * 3600 * 1000); // unreachable fallback
}
