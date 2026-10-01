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

export function validateStandup(draft: Partial<StandupDraft>): {
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
  if (draft.date instanceof Date && !isNaN(draft.date.getTime())) {
    date = draft.date;
  } else if (typeof draft.date === "string") {
    const d = new Date(draft.date);
    if (!isNaN(d.getTime())) date = d;
  }
  if (!date) errors.push("date: required (the workday this standup covers)");
  else {
    // Standups cover one workday: normalize to noon UTC to avoid tz edge drift.
    date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12, 0, 0));
  }

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

export function isStandupDue(
  cadence: StandupCadence,
  now: Date,
  hasSubmittedToday: boolean,
): boolean {
  if (hasSubmittedToday) return false;
  if (cadence === "none") return false;
  const day = now.getDay();
  if (cadence === "weekdays" && (day === 0 || day === 6)) return false;
  return true;
}

export function isStandupLate(now: Date, dueHourLocal = 10): boolean {
  return now.getHours() >= dueHourLocal;
}

export function nudgeCopy(due: boolean, late: boolean): string | null {
  if (!due) return null;
  return late
    ? "No standup yet today — drop a quick yesterday/today/blockers when you have a moment. No rush."
    : "Standup's due today — a quick yesterday/today/blockers keeps the team in sync.";
}
