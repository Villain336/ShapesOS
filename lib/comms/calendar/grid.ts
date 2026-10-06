// ShapesOS — Phase 18.2 (WS=comms): the Calendar app's grid math (PURE,
// client-safe). Days are LOCAL dates ("YYYY-MM-DD") in the member's time
// zone; instants come from zonedTimeToUtc, so a DST day is 23 or 25 hours
// long and still starts at local midnight.

import { resolveTimeZone, zonedParts, zonedTimeToUtc } from "@/lib/time/zoned";

export type CalendarView = "month" | "week" | "day";

function parts(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

/** Calendar arithmetic on local dates (no time zone involved). */
export function addDays(ymd: string, n: number): string {
  const { y, m, d } = parts(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(ymd: string): number {
  const { y, m, d } = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday of the week containing `ymd`. */
export function startOfWeek(ymd: string): string {
  const wd = weekdayOf(ymd);
  return addDays(ymd, wd === 0 ? -6 : 1 - wd);
}

export function startOfMonth(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

export function addMonths(ymd: string, n: number): string {
  const { y, m } = parts(ymd);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return t.toISOString().slice(0, 10);
}

/** The days a view shows (month: 6 full weeks from the Monday before the 1st). */
export function viewDays(view: CalendarView, anchor: string): string[] {
  if (view === "day") return [anchor];
  const first = view === "week" ? startOfWeek(anchor) : startOfWeek(startOfMonth(anchor));
  const n = view === "week" ? 7 : 42;
  return Array.from({ length: n }, (_, i) => addDays(first, i));
}

/** The instant a local day starts. */
export function dayStart(ymd: string, timeZone: string): Date {
  const { y, m, d } = parts(ymd);
  return zonedTimeToUtc(y, m, d, 0, resolveTimeZone(timeZone)).date;
}

/** [from, to) of a view, as instants. */
export function viewWindow(view: CalendarView, anchor: string, timeZone: string): { from: Date; to: Date } {
  const days = viewDays(view, anchor);
  return { from: dayStart(days[0]!, timeZone), to: dayStart(addDays(days[days.length - 1]!, 1), timeZone) };
}

/** Move the anchor one view back / forward. */
export function shiftAnchor(view: CalendarView, anchor: string, dir: -1 | 1): string {
  if (view === "month") return addMonths(anchor, dir);
  return addDays(anchor, view === "week" ? 7 * dir : dir);
}

export function localYmd(d: Date | string, timeZone: string): string {
  return zonedParts(typeof d === "string" ? new Date(d) : d, resolveTimeZone(timeZone)).ymd;
}

export interface Placed {
  /** Minutes from local midnight. */
  top: number;
  /** Minutes long (at least 15 so it can be seen and clicked). */
  height: number;
  /** Side-by-side lane for overlapping events, and how many lanes the cluster has. */
  lane: number;
  lanes: number;
}

/**
 * Place a day's timed events in a time grid: minutes from local midnight
 * (clipped to the day) and side-by-side lanes for overlaps. PURE.
 */
export function placeDay<T extends { start: string; end: string | null }>(events: T[], ymd: string, timeZone: string): (T & Placed)[] {
  const tz = resolveTimeZone(timeZone);
  const startOfDay = dayStart(ymd, tz).getTime();
  const endOfDay = dayStart(addDays(ymd, 1), tz).getTime();
  const items = events
    .map((e) => {
      const s = Math.max(new Date(e.start).getTime(), startOfDay);
      const rawEnd = e.end ? new Date(e.end).getTime() : new Date(e.start).getTime() + 30 * 60_000;
      const en = Math.min(Math.max(rawEnd, s + 15 * 60_000), endOfDay);
      return { e, s, en };
    })
    .sort((a, b) => a.s - b.s || b.en - a.en);
  const out: (T & Placed)[] = [];
  let cluster: { e: T; s: number; en: number; lane: number }[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) {
      out.push({ ...c.e, top: Math.round((c.s - startOfDay) / 60_000), height: Math.max(15, Math.round((c.en - c.s) / 60_000)), lane: c.lane, lanes });
    }
    cluster = [];
  };
  for (const it of items) {
    if (it.s >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((c) => c.en > it.s).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    cluster.push({ ...it, lane });
    clusterEnd = Math.max(clusterEnd === -Infinity ? it.en : clusterEnd, it.en);
  }
  if (cluster.length) flush();
  return out;
}
