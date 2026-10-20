// ShapesOS — Phase 18.2 (WS=comms): "find time" — free slots from busy
// intervals (PURE).
//
// Busy time comes from the member's own connected calendars, bookings, WFH
// focus blocks and meetings (lib/comms/calendar/sources.server.ts). Slots
// are proposed inside working hours in the member's time zone: each day's
// window is built from LOCAL wall times (zonedTimeToUtc), so a DST change
// moves the UTC instants, never the 09:00–17:00 the person sees. A slot is a
// proposal only — booking it is an event create through the tool gate.

import { resolveTimeZone, zonedParts, zonedTimeToUtc } from "@/lib/time/zoned";

export interface Interval {
  start: Date;
  end: Date;
}

export interface FindSlotsInput {
  busy: Interval[];
  from: Date;
  to: Date;
  durationMin: number;
  timeZone: string;
  /** Minutes since local midnight (default 09:00–17:00). */
  workStartMin?: number;
  workEndMin?: number;
  /** Local weekdays allowed (0 = Sunday; default Monday–Friday). */
  days?: number[];
  /** Candidate start granularity in minutes (default 30). */
  stepMin?: number;
  /** Free time kept around every busy interval (default 0). */
  bufferMin?: number;
  /** Max slots returned (default 8). */
  max?: number;
  /** Not before this instant (default `from`; e.g. now + 15 min). */
  notBefore?: Date;
}

/** Sorted, merged, non-overlapping intervals. */
export function mergeIntervals(xs: readonly Interval[]): Interval[] {
  const sorted = xs
    .filter((x) => x.end.getTime() > x.start.getTime())
    .map((x) => ({ start: new Date(x.start), end: new Date(x.end) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.start.getTime() <= last.end.getTime()) {
      if (x.end.getTime() > last.end.getTime()) last.end = x.end;
    } else out.push(x);
  }
  return out;
}

function overlaps(a: Interval, busy: readonly Interval[]): boolean {
  // busy is merged + sorted; a linear scan is fine for calendar sizes.
  for (const b of busy) {
    if (b.start.getTime() >= a.end.getTime()) return false;
    if (b.end.getTime() > a.start.getTime()) return true;
  }
  return false;
}

/** Free slots of `durationMin` inside working hours, earliest first. */
export function findSlots(input: FindSlotsInput): Interval[] {
  const tz = resolveTimeZone(input.timeZone);
  const duration = Math.max(5, Math.min(Math.round(input.durationMin), 12 * 60)) * 60_000;
  const step = Math.max(5, Math.round(input.stepMin ?? 30)) * 60_000;
  const workStart = input.workStartMin ?? 9 * 60;
  const workEnd = input.workEndMin ?? 17 * 60;
  const days = new Set(input.days ?? [1, 2, 3, 4, 5]);
  const max = Math.max(1, Math.min(input.max ?? 8, 50));
  const buffer = Math.max(0, input.bufferMin ?? 0) * 60_000;
  const busy = mergeIntervals(input.busy.map((b) => ({ start: new Date(b.start.getTime() - buffer), end: new Date(b.end.getTime() + buffer) })));
  const notBefore = Math.max(input.from.getTime(), input.notBefore?.getTime() ?? 0);
  const out: Interval[] = [];
  // Walk local days from the first to the last day of the window.
  const first = zonedParts(input.from, tz);
  for (let i = 0; i < 400 && out.length < max; i++) {
    const dayStart = zonedTimeToUtc(first.year, first.month, first.day + i, 0, tz).date;
    if (dayStart.getTime() > input.to.getTime()) break;
    const local = zonedParts(new Date(dayStart.getTime() + 12 * 3_600_000), tz); // midday: the day's weekday, DST-proof
    if (!days.has(local.weekday)) continue;
    const winStart = zonedTimeToUtc(local.year, local.month, local.day, workStart, tz).date.getTime();
    const winEnd = zonedTimeToUtc(local.year, local.month, local.day, workEnd, tz).date.getTime();
    // First candidate: the window start, or the next step boundary after notBefore.
    let t = winStart;
    if (t < notBefore) t = winStart + Math.ceil((notBefore - winStart) / step) * step;
    for (; t + duration <= winEnd && t + duration <= input.to.getTime(); t += step) {
      const slot = { start: new Date(t), end: new Date(t + duration) };
      if (!overlaps(slot, busy)) {
        out.push(slot);
        if (out.length >= max) break;
      }
    }
  }
  return out;
}
