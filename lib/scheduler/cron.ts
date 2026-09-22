// Marketr — scheduler: strict 5-field cron parsing, matching, and next-run.
// (Phase B, W2. Threat model T2: cron-expression injection.)
//
// The parser is deliberately narrow: fields must match /^[0-9,*/-]+$/ and
// every numeric value is range-checked per field. There is no eval, no shell,
// no regex built from the raw string. Anything else → CronParseError → 400
// at the API layer, never persisted.

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
  dow: Set<number>;
  /** The canonical expression as parsed. */
  expr: string;
}

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
  // step form: <base>/<step>
  const [base, stepRaw] = token.split("/");
  if (stepRaw !== undefined) {
    if (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1 || Number(stepRaw) > max) {
      throw new CronParseError(`cron field "${fieldName}": bad step "${token}"`);
    }
    const step = Number(stepRaw);
    let lo = min;
    let hi = max;
    if (base === "*") {
      // keep full range
    } else if (base.includes("-")) {
      const [a, b] = base.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) {
        throw new CronParseError(`cron field "${fieldName}": bad range "${token}"`);
      }
      lo = a;
      hi = b;
    } else if (/^\d+$/.test(base)) {
      lo = Number(base);
      hi = max;
    } else {
      throw new CronParseError(`cron field "${fieldName}": bad step base "${token}"`);
    }
    for (let v = lo; v <= hi; v += step) push(v);
    return out;
  }
  if (base === "*") {
    for (let v = min; v <= max; v++) push(v);
    return out;
  }
  if (base.includes("-")) {
    const [a, b] = base.split("-").map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) {
      throw new CronParseError(`cron field "${fieldName}": bad range "${token}"`);
    }
    for (let v = a; v <= b; v++) push(v);
    return out;
  }
  if (!/^\d+$/.test(base)) {
    throw new CronParseError(`cron field "${fieldName}": bad token "${token}"`);
  }
  push(Number(base));
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
  const [minute, hour, dom, month, dow] = parts.map((f, i) =>
    parseField(f, FIELDS[i].min, FIELDS[i].max, FIELDS[i].name),
  );
  return { minute, hour, dom, month, dow, expr: trimmed };
}

/** True when every value in the set matches the full range (i.e. "*"). */
function isStar(set: Set<number>, min: number, max: number): boolean {
  return set.size === max - min + 1;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Does `date` (UTC) match the parsed schedule? */
export function cronMatches(s: CronSchedule, date: Date): boolean {
  const m = date.getUTCMinutes();
  const h = date.getUTCHours();
  const dom = date.getUTCDate();
  const mon = date.getUTCMonth() + 1;
  const dow = date.getUTCDay();
  if (!s.minute.has(m) || !s.hour.has(h) || !s.month.has(mon)) return false;
  // Standard cron dom/dow semantics: when both are restricted, either may match.
  const domStar = isStar(s.dom, 1, 31);
  const dowStar = isStar(s.dow, 0, 7);
  const domMatch = s.dom.has(dom);
  const dowMatch = s.dow.has(dow) || (dow === 0 && s.dow.has(7));
  if (!domStar && !dowStar) return domMatch || dowMatch;
  if (!domStar) return domMatch;
  if (!dowStar) return dowMatch;
  return true;
}

const MINUTE_MS = 60_000;
const SEARCH_LIMIT_MINUTES = 366 * 24 * 60; // ~1 year

/**
 * Next firing time strictly after `from` (UTC). Throws CronParseError when
 * nothing matches within a year (shouldn't happen for valid expressions).
 */
export function nextRunAfter(s: CronSchedule, from: Date): Date {
  // Start at the next minute boundary.
  let t = Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let i = 0; i < SEARCH_LIMIT_MINUTES; i++, t += MINUTE_MS) {
    const d = new Date(t);
    // Skip impossible calendar dates the sets can't represent (Feb 30 etc.)
    if (d.getUTCDate() > daysInMonth(d.getUTCFullYear(), d.getUTCMonth() + 1)) continue;
    if (cronMatches(s, d)) return d;
  }
  throw new CronParseError("cron expression has no firing time within a year");
}

/**
 * Advance `from` forward through missed windows until it is in the future.
 * Used by the missed-cron catch-up: after downtime the schedule fires once
 * and jumps to the next future slot instead of replaying every missed window.
 */
export function nextFutureRunAfter(s: CronSchedule, from: Date, now: Date): Date {
  let next = nextRunAfter(s, from);
  let guard = 0;
  while (next.getTime() <= now.getTime() && guard++ < 200_000) {
    next = nextRunAfter(s, next);
  }
  return next;
}
