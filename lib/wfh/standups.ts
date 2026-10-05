// Marketr — Wave 2 WFH mode slice 4 (SPEC-WFH-MODE.md): async standups.
//
// Replaces the synchronous morning standup with written updates (yesterday /
// today / blockers), optional video, a comment/reaction thread, and team
// visibility — with a missed-standup NUDGE (nudge, not mandate). Nothing here
// ever fails closed: a standup is optional friction, and enforcement would
// destroy the async-first trust the mode depends on.
//
// Calendar-lite rule (integration wave parked): the standup itself is pure
// database + API. Video is an optional URL field (the OS does not host
// video); team visibility is workspace-scoped through the existing
// membership roles.

import { DEFAULT_TIME_ZONE, resolveTimeZone, zonedParts } from "@/lib/time/zoned";

export type StandupVisibility = "team" | "private";
export type StandupCadence = "daily" | "weekdays" | "none";

export const STANDUP_VISIBILITIES = ["team", "private"] as const;
export const STANDUP_CADENCES = ["daily", "weekdays", "none"] as const;

export class WfhStandupError extends Error {
  code: string;
  details: string[];
  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "WfhStandupError";
    this.code = code;
    this.details = details;
  }
}

export interface StandupDraft {
  date: Date | string;
  yesterday: string;
  today: string;
  blockers?: string | null;
  videoUrl?: string | null;
  visibility: StandupVisibility;
}

export interface ValidatedStandup {
  date: Date;
  yesterday: string;
  today: string;
  blockers: string | null;
  videoUrl: string | null;
  visibility: StandupVisibility;
}

export function validateStandup(draft: Partial<StandupDraft>, timeZone: string = DEFAULT_TIME_ZONE): {
  ok: boolean;
  errors: string[];
  normalized?: ValidatedStandup;
} {
  const errors: string[] = [];
  const yesterday = (draft.yesterday ?? "").trim();
  const today = (draft.today ?? "").trim();
  const blockers = (draft.blockers ?? "").trim() || null;

  if (!yesterday) errors.push("yesterday: required — what did you finish?");
  if (!today) errors.push("today: required — what are you working on?");
  if (yesterday.length > 2000) errors.push("yesterday: max 2000 characters");
  if (today.length > 2000) errors.push("today: max 2000 characters");
  if (blockers && blockers.length > 2000) errors.push("blockers: max 2000 characters");

  let date: Date | null = null;
  const ymd = typeof draft.date === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(draft.date) : null;
  if (ymd) {
    // A plain calendar date is the workday itself (must round-trip: no Feb 30).
    const d = new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), 12, 0, 0));
    if (d.toISOString().slice(0, 10) === draft.date) date = d;
  } else {
    let instant: Date | null = null;
    if (draft.date instanceof Date && !isNaN(draft.date.getTime())) {
      instant = draft.date;
    } else if (typeof draft.date === "string") {
      const d = new Date(draft.date);
      if (!isNaN(d.getTime())) instant = d;
    }
    // Standups cover one workday: the user's local date, stored at noon UTC
    // to avoid tz edge drift.
    if (instant) date = standupDateFor(instant, timeZone);
  }
  if (!date) errors.push("date: required (the workday this standup covers)");

  const visibility = (draft.visibility ?? "team") as StandupVisibility;
  if (!(STANDUP_VISIBILITIES as readonly string[]).includes(visibility)) {
    errors.push(`visibility: must be one of ${STANDUP_VISIBILITIES.join(", ")}`);
  }

  let videoUrl: string | null = null;
  if (draft.videoUrl != null && String(draft.videoUrl).trim() !== "") {
    const raw = String(draft.videoUrl).trim();
    if (!/^https?:\/\//i.test(raw)) {
      errors.push("videoUrl: must be an http(s) URL");
    } else if (raw.length > 2048) {
      errors.push("videoUrl: max 2048 characters");
    } else {
      videoUrl = raw;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    normalized: { date: date as Date, yesterday, today, blockers, videoUrl, visibility },
  };
}

export function validateComment(body: unknown): { ok: boolean; error?: string; text?: string } {
  const text = String(body ?? "").trim();
  if (!text) return { ok: false, error: "comment body is required" };
  if (text.length > 1000) return { ok: false, error: "comment body max 1000 characters" };
  return { ok: true, text };
}

export function validateReaction(emoji: unknown): { ok: boolean; error?: string; normalized?: string } {
  const e = String(emoji ?? "").trim();
  if (!e) return { ok: false, error: "emoji is required" };
  // Single emoji cluster — surrogate-pair aware length check.
  if ([...e].length > 4) return { ok: false, error: "one emoji at a time" };
  return { ok: true, normalized: e };
}

// ── Nudge logic ─────────────────────────────────────────────────────────────
// A standup is due when: the user's standup cadence is on (daily/weekdays),
// today is a workday under that cadence, and no standup exists for today.
// The result is a NUDGE suggestion, never a gate — missing one is fine.

// "Today", weekdays and the due hour are read in the user's IANA timezone
// (WfhWorkMode.timezone, default UTC) — never the server's.

export function isStandupDue(
  cadence: StandupCadence,
  now: Date,
  hasSubmittedToday: boolean,
  timeZone: string = DEFAULT_TIME_ZONE,
): boolean {
  if (hasSubmittedToday) return false;
  if (cadence === "none") return false;
  const day = zonedParts(now, resolveTimeZone(timeZone)).weekday;
  if (cadence === "weekdays" && (day === 0 || day === 6)) return false;
  return true;
}

export function isStandupLate(now: Date, dueHourLocal = 10, timeZone: string = DEFAULT_TIME_ZONE): boolean {
  return zonedParts(now, resolveTimeZone(timeZone)).hour >= dueHourLocal;
}

/** The stored standup date (noon UTC) for the user's local workday containing `now`. */
export function standupDateFor(now: Date, timeZone: string = DEFAULT_TIME_ZONE): Date {
  const p = zonedParts(now, resolveTimeZone(timeZone));
  return new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
}

export function nudgeCopy(due: boolean, late: boolean): string | null {
  if (!due) return null;
  return late
    ? "No standup yet today — drop a quick yesterday/today/blockers when you have a moment. No rush."
    : "Standup's due today — a quick yesterday/today/blockers keeps the team in sync.";
}
