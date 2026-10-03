// Marketr — automation canvas: 5-field cron for workflow schedule triggers.
//
// One cron implementation for the whole app: this delegates to the
// scheduler's strict parser (lib/scheduler/cron.ts) — standard OR semantics
// for day-of-month/day-of-week, 0 and 7 both Sunday, out-of-range values
// rejected (never silently dropped). Schedules are read as wall-clock time in
// an explicit IANA timezone (the workflow's, default UTC), never the
// server's local zone.

import { cronMatchesInZone, parseCron as parseSchedulerCron, type CronSchedule } from "@/lib/scheduler/cron";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/time/zoned";

export type ParsedCron = CronSchedule;

/** Parse and validate a 5-field cron expression. Throws on invalid input. */
export function parseCron(expr: string): ParsedCron {
  return parseSchedulerCron(expr);
}

/** Validate an IANA timezone for a schedule. Throws on invalid input. */
export function parseTimeZone(tz: unknown): string {
  if (tz == null || tz === "") return DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(tz)) throw new Error(`Unknown timezone "${String(tz).slice(0, 64)}" (use an IANA name like America/New_York)`);
  return tz;
}

/** True when `date` falls on a minute this cron fires, read in `timeZone`. */
export function cronDue(expr: string, date: Date = new Date(), timeZone: string = DEFAULT_TIME_ZONE): boolean {
  return cronMatchesInZone(parseCron(expr), date, parseTimeZone(timeZone));
}

/** Start of the current minute — used to avoid double-firing a schedule. */
export function startOfCurrentMinute(date: Date = new Date()): Date {
  const d = new Date(date);
  d.setUTCSeconds(0, 0);
  return d;
}
