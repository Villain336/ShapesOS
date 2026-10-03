// Marketr — scheduler: strict 5-field cron parsing, matching, and next-run.
// (Phase B, W2. Threat model T2: cron-expression injection.)
//
// The parser is deliberately narrow: fields must match /^[0-9,*/-]+$/ and
// every numeric value is range-checked per field. There is no eval, no shell,
// no regex built from the raw string. Anything else → CronParseError → 400
// at the API layer, never persisted.

import { zonedParts, zonedTimeToUtc } from "@/lib/time/zoned";

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

/** Field definitions: [name, min, max]. Standard 5-field cron. */
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

const FIELD_TOKEN = /^[0-9,*/-]+$/;

export interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  /** Day of week, 0 = Sunday (7 is normalized to 0). */
  dow: Set<number>;
  /** Field started with "*": unrestricted for the dom/dow OR rule. */
  domStar: boolean;
  dowStar: boolean;
  /** The canonical expression as parsed. */
  expr: string;
}

const NUM = /^\d{1,2}$/;
const RANGE = /^(\d{1,2})-(\d{1,2})$/;

function expandToken(token: string, min: number, max: number, fieldName: string): number[] {
  const out: number[] = [];
  const push = (v: number) => {
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new CronParseError(
        `cron field "${fieldName}": value ${token} out of range ${min}-${max}`,
      );
    }
    out.push(v);
  };
  // Bounds of a base: "*", "<n>", or "<a>-<b>" (exactly two numbers, a <= b,
  // both in range). Anything else ("-5", "1-2-3", "5-", "") is malformed.
  const bounds = (base: string, allowOpen: boolean): [number, number] => {
    if (base === "*") return [min, max];
    const r = RANGE.exec(base);
    if (r) {
      const a = Number(r[1]);
      const b = Number(r[2]);
      if (a < min || b > max || a > b) {
        throw new CronParseError(`cron field "${fieldName}": bad range "${token}" (allowed ${min}-${max})`);
      }
      return [a, b];
    }
    if (NUM.test(base)) {
      const v = Number(base);
      if (v < min || v > max) {
        throw new CronParseError(`cron field "${fieldName}": value ${token} out of range ${min}-${max}`);
      }
      return [v, allowOpen ? max : v];
    }
    throw new CronParseError(`cron field "${fieldName}": bad token "${token}"`);
  };
  const pieces = token.split("/");
  if (pieces.length > 2) throw new CronParseError(`cron field "${fieldName}": bad step "${token}"`);
  const [base, stepRaw] = pieces;
  if (stepRaw !== undefined) {
    // step form: <base>/<step>
    if (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1 || Number(stepRaw) > max) {
      throw new CronParseError(`cron field "${fieldName}": bad step "${token}"`);
    }
    const step = Number(stepRaw);
    const [lo, hi] = bounds(base, true);
    for (let v = lo; v <= hi; v += step) push(v);
    return out;
  }
  const [lo, hi] = bounds(base, false);
  for (let v = lo; v <= hi; v++) push(v);
  return out;
}

function parseField(field: string, min: number, max: number, fieldName: string): Set<number> {
  if (!FIELD_TOKEN.test(field)) {
    throw new CronParseError(
      `cron field "${fieldName}": illegal characters (allowed: digits , * / -)`,
    );
  }
  const values = new Set<number>();
  for (const token of field.split(",")) {
    if (!token) throw new CronParseError(`cron field "${fieldName}": empty list element`);
    for (const v of expandToken(token, min, max, fieldName)) values.add(v);
  }
  if (values.size === 0) {
    throw new CronParseError(`cron field "${fieldName}": matches nothing`);
  }
  return values;
}

/** Longest each month can be (Feb counts its leap day). */
const MAX_DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Parse and strictly validate a 5-field cron expression. Throws CronParseError. */
export function parseCron(expr: string): CronSchedule {
  if (typeof expr !== "string" || !expr.trim()) {
    throw new CronParseError("cron expression is required");
  }
  const trimmed = expr.trim().replace(/\s+/g, " ");
  if (trimmed.length > 100) throw new CronParseError("cron expression too long");
  const parts = trimmed.split(" ");
  if (parts.length !== 5) {
    throw new CronParseError(
      `cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    );
  }
  const [minute, hour, dom, month, dowRaw] = parts.map((f, i) =>
    parseField(f, FIELDS[i].min, FIELDS[i].max, FIELDS[i].name),
  );
  // 0 and 7 are both Sunday.
  const dow = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));
  // Vixie-cron rule: a field is "unrestricted" when it starts with "*".
  const domStar = parts[2].startsWith("*");
  const dowStar = parts[4].startsWith("*");
  // A day-of-month-only schedule must name a day some selected month has
  // ("0 0 30 2 *" never fires — reject at save time, not at tick time).
  if (!domStar && dowStar && ![...month].some((m) => [...dom].some((d) => d <= MAX_DAYS[m]))) {
    throw new CronParseError("cron expression never fires (no selected month has that day)");
  }
  return { minute, hour, dom, month, dow, domStar, dowStar, expr: trimmed };
}

interface CalendarParts {
  minute: number;
  hour: number;
  /** day of month 1–31 */
  day: number;
  /** 1–12 */
  month: number;
  /** 0 = Sunday */
  weekday: number;
}

function dayMatches(s: CronSchedule, p: Omit<CalendarParts, "minute" | "hour">): boolean {
  if (!s.month.has(p.month)) return false;
  // Standard (Vixie) cron dom/dow semantics: when both fields are restricted,
  // either may match; when either starts with "*", both must.
  const domMatch = s.dom.has(p.day);
  const dowMatch = s.dow.has(p.weekday);
  if (!s.domStar && !s.dowStar) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/** Does a wall-clock reading match the parsed schedule? */
export function cronMatchesParts(s: CronSchedule, p: CalendarParts): boolean {
  return s.minute.has(p.minute) && s.hour.has(p.hour) && dayMatches(s, p);
}

/** Does `date` (UTC) match the parsed schedule? */
export function cronMatches(s: CronSchedule, date: Date): boolean {
  return cronMatchesParts(s, {
    minute: date.getUTCMinutes(),
    hour: date.getUTCHours(),
    day: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    weekday: date.getUTCDay(),
  });
}

/** Does `date` match the schedule read as wall-clock time in IANA zone `tz`? */
export function cronMatchesInZone(s: CronSchedule, date: Date, tz: string): boolean {
  const p = zonedParts(date, tz);
  return cronMatchesParts(s, { minute: p.minute, hour: p.hour, day: p.day, month: p.month, weekday: p.weekday });
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
// Eight years: Feb 29 schedules can wait up to 8 years between leap days
// (2096 → 2104), so a one-year window threw for "0 0 29 2 *" and halted ticks.
const SEARCH_LIMIT_DAYS = 8 * 366;

/**
 * Next firing time strictly after `from` (UTC). Walks whole days (≤ ~2,900
 * iterations) and only scans minutes on matching days. Throws CronParseError
 * when nothing matches within eight years (parseCron rejects such schedules).
 */
export function nextRunAfter(s: CronSchedule, from: Date): Date {
  // Start at the next minute boundary.
  const start = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const firstDay = Math.floor(start / DAY_MS) * DAY_MS;
  const hours = [...s.hour].sort((a, b) => a - b);
  const minutes = [...s.minute].sort((a, b) => a - b);
  for (let i = 0; i < SEARCH_LIMIT_DAYS; i++) {
    const dayStart = firstDay + i * DAY_MS;
    const d = new Date(dayStart);
    if (!dayMatches(s, { day: d.getUTCDate(), month: d.getUTCMonth() + 1, weekday: d.getUTCDay() })) continue;
    const minMinute = i === 0 ? (start - dayStart) / MINUTE_MS : 0;
    for (const h of hours) {
      if (h * 60 + 59 < minMinute) continue;
      for (const m of minutes) {
        if (h * 60 + m >= minMinute) return new Date(dayStart + (h * 60 + m) * MINUTE_MS);
      }
    }
  }
  throw new CronParseError("cron expression has no firing time within eight years");
}

/**
 * The first slot after both `from` and `now`. Used by the missed-cron
 * catch-up: after downtime the schedule fires once and jumps to the next
 * future slot instead of replaying every missed window.
 */
export function nextFutureRunAfter(s: CronSchedule, from: Date, now: Date): Date {
  return nextRunAfter(s, from.getTime() > now.getTime() ? from : now);
}

/** True for the zones where wall-clock time is UTC (no DST, no offset). */
function isUtcZone(tz: string): boolean {
  return tz === "UTC" || tz === "Etc/UTC" || tz === "Etc/GMT" || tz === "GMT";
}

/** Wall-clock slack (minutes) covering any real DST/offset change within a day. */
const DST_SLACK_MIN = 180;

/**
 * Next firing time strictly after `from`, reading the schedule as wall-clock
 * time in IANA zone `tz` (Phase 4a: per-schedule timezone). Every slot it
 * returns is a minute cronMatchesInZone(s, slot, tz) accepts, except across
 * DST transitions, which follow the same "compatible" rules as
 * lib/time/zoned.ts zonedTimeToUtc:
 *   - fall back (wall time occurs twice): fires once, at the earlier instant;
 *   - spring forward (wall time never occurs): fires once, shifted forward by
 *     the gap (02:30 → 03:30 in New York) instead of silently skipping a day.
 * Walks local calendar days (≤ eight years, like nextRunAfter) and converts
 * only candidate wall times on matching days. UTC delegates to nextRunAfter.
 */
export function nextRunAfterInZone(s: CronSchedule, from: Date, tz: string): Date {
  if (isUtcZone(tz)) return nextRunAfter(s, from);
  const start = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const local = zonedParts(new Date(start), tz);
  const hours = [...s.hour].sort((a, b) => a - b);
  const minutes = [...s.minute].sort((a, b) => a - b);
  for (let i = 0; i < SEARCH_LIMIT_DAYS; i++) {
    // Local calendar date i days after the start's local date (UTC math on a
    // date-only value: no offsets involved).
    const d = new Date(Date.UTC(local.year, local.month - 1, local.day + i));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    if (!dayMatches(s, { day, month, weekday: d.getUTCDay() })) continue;
    // Wall times far before the start on its own day are long past.
    const minWall = i === 0 ? local.minutes - DST_SLACK_MIN : -1;
    let best: number | null = null;
    let bestWall = Number.POSITIVE_INFINITY;
    scan: for (const h of hours) {
      for (const m of minutes) {
        const wall = h * 60 + m;
        if (wall < minWall) continue;
        // A wall time this much later can't map to an earlier instant.
        if (wall > bestWall + DST_SLACK_MIN) break scan;
        const t = zonedTimeToUtc(year, month, day, wall, tz).date.getTime();
        if (t >= start && (best === null || t < best)) {
          best = t;
          bestWall = wall;
        }
      }
    }
    if (best !== null) return new Date(best);
  }
  throw new CronParseError("cron expression has no firing time within eight years");
}

/** nextFutureRunAfter, read in IANA zone `tz` (see nextRunAfterInZone). */
export function nextFutureRunAfterInZone(s: CronSchedule, from: Date, now: Date, tz: string): Date {
  return nextRunAfterInZone(s, from.getTime() > now.getTime() ? from : now, tz);
}
