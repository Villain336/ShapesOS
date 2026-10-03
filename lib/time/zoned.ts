// ShapesOS — IANA timezone helpers (Intl only, no dependencies).
//
// Everything that means "local time" (booking slots, WFH standups/digests/
// focus/rituals, workflow cron) goes through these instead of the server's
// own timezone. Local wall times are converted to instants one at a time, so
// DST transitions can't shift or duplicate a slot, and calendar stepping is
// done on local dates (never by adding fixed milliseconds).

export const DEFAULT_TIME_ZONE = "UTC";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** True for a timezone Intl accepts (IANA names such as "America/New_York", or "UTC"). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/** `tz` when valid, else the fallback (default UTC). Never throws. */
export function resolveTimeZone(tz: unknown, fallback = DEFAULT_TIME_ZONE): string {
  return isValidTimeZone(tz) ? tz : fallback;
}

export interface ZonedParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** Minutes since local midnight. */
  minutes: number;
  /** "YYYY-MM-DD" local date. */
  ymd: string;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local wall-clock parts of an instant in an IANA timezone. */
export function zonedParts(d: Date, tz: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(d)) parts[p.type] = p.value;
  // Some engines still render midnight as "24" even with h23.
  let hour = Number(parts.hour ?? 0);
  if (hour === 24) hour = 0;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const minute = Number(parts.minute ?? 0);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second: Number(parts.second ?? 0),
    weekday: WEEKDAYS[parts.weekday ?? "Mon"] ?? 1,
    minutes: hour * 60 + minute,
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Offset of `tz` from UTC at instant `t` (ms; local − UTC). */
function offsetAt(t: number, tz: string): number {
  const p = zonedParts(new Date(t), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (t - (((t % 1000) + 1000) % 1000));
}

export type LocalResolution = "exact" | "ambiguous" | "gap";

/**
 * The instant at which the local wall time (year, month 1–12, day, minutes
 * since midnight) occurs in `tz`. Day/month overflow normalizes like
 * Date.UTC (day 32 → next month).
 *
 * - exact: the wall time occurs once.
 * - ambiguous (fall back): it occurs twice; the EARLIER instant is returned.
 * - gap (spring forward): it never occurs; the instant one gap-length later
 *   is returned (02:30 → 03:30 in New York), like Temporal's "compatible".
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  minutes: number,
  tz: string,
): { date: Date; resolution: LocalResolution } {
  const wall = Date.UTC(year, month - 1, day, 0, minutes);
  const DAY = 86_400_000;
  // Offsets either side of the wall time cover any single DST transition.
  const before = offsetAt(wall - DAY, tz);
  const after = offsetAt(wall + DAY, tz);
  const candidates = [...new Set([wall - before, wall - after])]
    .filter((t) => wall - t === offsetAt(t, tz))
    .sort((a, b) => a - b);
  if (candidates.length === 2) return { date: new Date(candidates[0]), resolution: "ambiguous" };
  if (candidates.length === 1) return { date: new Date(candidates[0]), resolution: "exact" };
  // In the gap: interpret with the pre-transition offset (moves forward).
  return { date: new Date(wall - before), resolution: "gap" };
}

/** Days in a month (month 1–12) of the proleptic Gregorian calendar. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Add calendar months to a (year, month, day) date, clamping the day to the
 * target month's length (Jan 31 + 1 month → Feb 28/29; Feb 29 + 12 → Feb 28).
 */
export function addMonthsClamped(
  year: number,
  month: number,
  day: number,
  months: number,
): { year: number; month: number; day: number } {
  const idx = year * 12 + (month - 1) + months;
  const y = Math.floor(idx / 12);
  const m = idx - y * 12 + 1;
  return { year: y, month: m, day: Math.min(day, daysInMonth(y, m)) };
}

/** Instant of local midnight starting the local day that contains `d`. */
export function startOfZonedDay(d: Date, tz: string): Date {
  const p = zonedParts(d, tz);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, tz).date;
}
