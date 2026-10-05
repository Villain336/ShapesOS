// Marketr — Wave 2 WFH mode slice 5 (SPEC-WFH-MODE.md): team rituals.
//
// Rituals are the remote culture layer: wins, kudos, virtual coffee, demo
// Friday. All rituals are OPT-IN (subscriptions), run on a cadence engine,
// keep participation history, and surface dead rituals for retirement instead
// of letting them rot silently.
//
// A ritual is workspace-level; participation is per-user. Nothing here gates
// anything — rituals are invitations, never obligations.

import {
  addMonthsClamped,
  DEFAULT_TIME_ZONE,
  isValidTimeZone,
  resolveTimeZone,
  zonedParts,
  zonedTimeToUtc,
} from "@/lib/time/zoned";

export type RitualType = "wins" | "kudos" | "virtual-coffee" | "demo-friday";
export type RitualCadence = "daily" | "weekly" | "biweekly" | "monthly";

export const RITUAL_TYPES = ["wins", "kudos", "virtual-coffee", "demo-friday"] as const;
export const RITUAL_CADENCES = ["daily", "weekly", "biweekly", "monthly"] as const;

export interface RitualTypeMeta {
  type: RitualType;
  name: string;
  description: string;
  defaultCadence: RitualCadence;
  prompt: string;
}

export const RITUAL_TYPE_META: Record<RitualType, RitualTypeMeta> = {
  wins: {
    type: "wins",
    name: "Wins",
    description: "Share a win from the week — big or small. Momentum is a team sport.",
    defaultCadence: "weekly",
    prompt: "What did you win this week?",
  },
  kudos: {
    type: "kudos",
    name: "Kudos",
    description: "Thank a teammate publicly. Recognition compounds.",
    defaultCadence: "weekly",
    prompt: "Who deserves kudos this week, and for what?",
  },
  "virtual-coffee": {
    type: "virtual-coffee",
    name: "Virtual coffee",
    description: "Random pairing for a 15-minute no-agenda chat. Cameras optional, humans required.",
    defaultCadence: "weekly",
    prompt: "Grab a coffee with your pair — no agenda, just talk.",
  },
  "demo-friday": {
    type: "demo-friday",
    name: "Demo Friday",
    description: "Show what you shipped. Working software only — slides optional.",
    defaultCadence: "weekly",
    prompt: "What did you ship this week? Show us.",
  },
};

export class WfhRitualError extends Error {
  code: string;
  details: string[];
  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "WfhRitualError";
    this.code = code;
    this.details = details;
  }
}

export interface RitualDraft {
  type: RitualType;
  title?: string | null;
  description?: string | null;
  cadence?: RitualCadence;
  anchorDate?: Date | null; // first occurrence; defaults to next Monday 12:00 local
  /** IANA timezone the cadence steps in (default UTC). */
  timezone?: string | null;
}

export interface ValidatedRitual {
  type: RitualType;
  title: string;
  description: string;
  cadence: RitualCadence;
  anchorDate: Date;
  timezone: string;
}

function nextMondayNoon(now: Date, tz: string): Date {
  const p = zonedParts(now, tz);
  const delta = (8 - p.weekday) % 7 || 7;
  return zonedTimeToUtc(p.year, p.month, p.day + delta, 12 * 60, tz).date;
}

export function validateRitual(draft: Partial<RitualDraft>, now = new Date()): {
  ok: boolean;
  errors: string[];
  normalized?: ValidatedRitual;
} {
  const errors: string[] = [];
  const meta = draft.type ? RITUAL_TYPE_META[draft.type as RitualType] : null;
  if (!meta) errors.push(`type: must be one of ${RITUAL_TYPES.join(", ")}`);

  const cadence = (draft.cadence ?? meta?.defaultCadence ?? "weekly") as RitualCadence;
  if (!(RITUAL_CADENCES as readonly string[]).includes(cadence)) {
    errors.push(`cadence: must be one of ${RITUAL_CADENCES.join(", ")}`);
  }

  const title = (draft.title ?? "").trim() || meta?.name || "";
  const description = (draft.description ?? "").trim() || meta?.description || "";
  if (title.length > 120) errors.push("title: max 120 characters");
  if (description.length > 500) errors.push("description: max 500 characters");

  let timezone = DEFAULT_TIME_ZONE;
  if (draft.timezone != null && draft.timezone !== "") {
    if (isValidTimeZone(draft.timezone)) timezone = draft.timezone;
    else errors.push("timezone: must be an IANA name such as America/New_York");
  }

  let anchorDate: Date | null = null;
  if (draft.anchorDate instanceof Date && !isNaN(draft.anchorDate.getTime())) {
    anchorDate = draft.anchorDate;
  } else if (typeof draft.anchorDate === "string" && draft.anchorDate) {
    const d = new Date(draft.anchorDate);
    if (!isNaN(d.getTime())) anchorDate = d;
  }
  if (anchorDate == null) anchorDate = nextMondayNoon(now, timezone);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    normalized: { type: draft.type as RitualType, title, description, cadence, anchorDate, timezone },
  };
}

// ── Cadence engine ──────────────────────────────────────────────────────────
// A ritual "fires" on each cadence step from its anchor date. nextOccurrence
// returns the next fire at-or-after `now`; isDue says whether one fired since
// the last recorded occurrence (i.e. the ritual is waiting on this round).

// Steps are CALENDAR steps in the ritual's IANA timezone: occurrence k is the
// anchor's local date + k days/weeks (same local time, so a Monday 09:00
// ritual stays 09:00 across DST), and "monthly" is the anchor's day-of-month
// in each following month, clamped (Jan 31 → Feb 28/29 → Mar 31). Each is
// computed from the anchor, never chained, so clamping can't drift.

const CADENCE_DAYS: Record<Exclude<RitualCadence, "monthly">, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
};
const DAY_MS = 24 * 3600 * 1000;

/** The k-th occurrence (k >= 0) of a ritual anchored at `anchorDate`. */
export function occurrenceAt(
  anchorDate: Date,
  cadence: RitualCadence,
  k: number,
  timeZone: string = DEFAULT_TIME_ZONE,
): Date {
  if (k <= 0) return new Date(anchorDate.getTime());
  const tz = resolveTimeZone(timeZone);
  const a = zonedParts(anchorDate, tz);
  const subMinuteMs = ((anchorDate.getTime() % 60_000) + 60_000) % 60_000;
  const local =
    cadence === "monthly"
      ? addMonthsClamped(a.year, a.month, a.day, k)
      : { year: a.year, month: a.month, day: a.day + k * CADENCE_DAYS[cadence] };
  return new Date(zonedTimeToUtc(local.year, local.month, local.day, a.minutes, tz).date.getTime() + subMinuteMs);
}

/** Index of the first occurrence at or after `t`. */
function firstIndexAtOrAfter(anchorDate: Date, cadence: RitualCadence, t: Date, tz: string): number {
  const elapsed = t.getTime() - anchorDate.getTime();
  if (elapsed <= 0) return 0;
  // Start from a lower bound (longest possible step, minus one) and walk up.
  const longestStep = cadence === "monthly" ? 31 * DAY_MS : CADENCE_DAYS[cadence] * DAY_MS + 3600_000;
  let k = Math.max(0, Math.floor(elapsed / longestStep) - 1);
  while (occurrenceAt(anchorDate, cadence, k, tz).getTime() < t.getTime()) k++;
  return k;
}

export function nextOccurrence(
  anchorDate: Date,
  cadence: RitualCadence,
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): Date {
  const tz = resolveTimeZone(timeZone);
  return occurrenceAt(anchorDate, cadence, firstIndexAtOrAfter(anchorDate, cadence, now, tz), tz);
}

export function occurrencesSince(
  anchorDate: Date,
  cadence: RitualCadence,
  from: Date,
  to: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): Date[] {
  const tz = resolveTimeZone(timeZone);
  const out: Date[] = [];
  const end = to.getTime();
  for (let k = firstIndexAtOrAfter(anchorDate, cadence, from, tz); ; k++) {
    const occ = occurrenceAt(anchorDate, cadence, k, tz);
    if (occ.getTime() > end) break;
    out.push(occ);
  }
  return out;
}

// ── Dead-ritual surfacing ───────────────────────────────────────────────────
// A ritual is "dead" when recent rounds had no participation: over the last
// `windowRounds` scheduled occurrences, fewer than `minParticipation` total
// participation events. The UI surfaces it with a retirement suggestion; the
// OS never auto-deletes a ritual — the team decides.

export interface DeadRitualInput {
  ritualId: string;
  anchorDate: Date;
  cadence: RitualCadence;
  active: boolean;
  recentOccurrences: Date[];
  participationCount: number; // participations across recentOccurrences
  subscriberCount: number;
}

export interface DeadRitualVerdict {
  dead: boolean;
  reason: string | null;
  suggestion: string | null;
}

export function assessRitualHealth(
  input: DeadRitualInput,
  windowRounds = 4,
  minParticipation = 1,
): DeadRitualVerdict {
  if (!input.active) {
    return { dead: false, reason: null, suggestion: null };
  }
  if (input.subscriberCount === 0) {
    return {
      dead: true,
      reason: "Nobody is subscribed — this ritual has no audience.",
      suggestion: "Retire it, or relaunch with a smaller, invited group.",
    };
  }
  const rounds = Math.min(windowRounds, input.recentOccurrences.length);
  if (rounds < windowRounds) {
    return { dead: false, reason: null, suggestion: null }; // too young to judge
  }
  if (input.participationCount < minParticipation) {
    return {
      dead: true,
      reason: `No participation in the last ${windowRounds} rounds.`,
      suggestion: "Retire it, or shrink the cadence and relaunch.",
    };
  }
  return { dead: false, reason: null, suggestion: null };
}
