// ShapesOS — Phase 18.2 (WS=comms): the Calendar app's sources — one view
// over calendars and records that already exist (no event store of its own):
//
//   google / outlook  the member's OWN connected calendars (connector read
//                     tool list_events; editable through the tool gate)
//   booking           Bookings on the workspace's booking pages
//   focus             the member's WFH focus blocks (recurring ones expanded)
//   ops_event         Operations events (Phase 12 "Events"), not cancelled
//   social            scheduled social posts (read-only lane)
//   reminder          the member's own reminders with a due time
//   meeting           calls held in Meet
//
// A connected calendar that fails is shown as an error line, never hidden;
// a connector answering from its labelled mock path (dev / demo only — the
// production no-fakes guard refuses it) is flagged mock on every event.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { resolveTimeZone, zonedParts, zonedTimeToUtc } from "@/lib/time/zoned";
import { invokeConnection, personalConnections, type PersonalConnection } from "../connectors.server";
import type { Interval } from "./freebusy";

export const CALENDAR_SOURCES = ["google", "outlook", "booking", "focus", "ops_event", "social", "reminder", "meeting"] as const;
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];

export interface CalendarEvent {
  /** Source-prefixed id ("google:<connectionId>:<eventId>", "booking:<id>" …). */
  id: string;
  source: CalendarSource;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  attendees: string[];
  /** Where it opens in ShapesOS. */
  href: string | null;
  /** The provider's own page (https only). */
  externalUrl: string | null;
  /** Can be changed from the Calendar app (connected calendars only, through the tool gate). */
  editable: boolean;
  connectionId: string | null;
  externalId: string | null;
  mock: boolean;
}

export interface CalendarConnectionView {
  id: string;
  key: "google-calendar" | "outlook-calendar";
  account: string | null;
}

export interface CalendarLoad {
  events: CalendarEvent[];
  connections: CalendarConnectionView[];
  errors: { source: string; message: string }[];
  timeZone: string;
}

export interface CalendarCtx {
  workspaceId: string;
  userId: string;
  timeZone: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * A provider's start/end into an instant: "2026-10-12" is an all-day date,
 * "…T15:00:00Z" / "+02:00" an instant, and a bare "…T15:00:00" is a wall
 * time in `tz` (Graph's dateTime + timeZone). PURE.
 */
export function parseProviderTime(v: string | null | undefined, tz: string | null | undefined): { date: Date; allDay: boolean } | null {
  if (!v) return null;
  if (DATE_ONLY.test(v)) return { date: new Date(`${v}T00:00:00Z`), allDay: true };
  const m = LOCAL_DT.exec(v);
  if (m) {
    const [, y, mo, d, h, mi] = m;
    const zone = resolveTimeZone(tz ?? "UTC");
    return { date: zonedTimeToUtc(Number(y), Number(mo), Number(d), Number(h) * 60 + Number(mi), zone).date, allDay: false };
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : { date: new Date(t), allDay: false };
}

function https(u: unknown): string | null {
  return typeof u === "string" && /^https:\/\//.test(u) ? u : null;
}

async function connectorEvents(conn: PersonalConnection, ctx: CalendarCtx, from: Date, to: Date): Promise<{ events: CalendarEvent[]; error: string | null }> {
  const res = await invokeConnection(conn, "list_events", { from: from.toISOString(), to: to.toISOString(), limit: 250 }, ctx);
  const source: CalendarSource = conn.connectorKey === "google-calendar" ? "google" : "outlook";
  if (!res.ok) return { events: [], error: res.error ?? "The calendar did not answer." };
  const rows = Array.isArray(res.data) ? (res.data as Record<string, unknown>[]) : [];
  const events: CalendarEvent[] = [];
  for (const e of rows) {
    const tz = typeof e.timeZone === "string" ? e.timeZone : null;
    const s = parseProviderTime(typeof e.start === "string" ? e.start : null, tz);
    if (!s) continue;
    const en = parseProviderTime(typeof e.end === "string" ? e.end : null, tz);
    const externalId = String(e.id ?? "");
    events.push({
      id: `${source}:${conn.id}:${externalId}`,
      source,
      title: typeof e.title === "string" && e.title.trim() ? e.title : "",
      start: s.date.toISOString(),
      end: en ? en.date.toISOString() : null,
      allDay: s.allDay,
      location: typeof e.location === "string" ? e.location : null,
      attendees: Array.isArray(e.attendees) ? (e.attendees as unknown[]).filter((a): a is string => typeof a === "string") : [],
      href: null,
      externalUrl: https(e.url),
      editable: !res.mock,
      connectionId: conn.id,
      externalId,
      mock: !!res.mock,
    });
  }
  return { events, error: null };
}

/** Occurrences of a (possibly recurring) focus block inside the window, in the member's zone. PURE. */
export function focusOccurrences(
  block: { startAt: Date; endAt: Date; recurrence: string },
  from: Date,
  to: Date,
  timeZone: string,
  max = 200,
): Interval[] {
  const out: Interval[] = [];
  const dur = block.endAt.getTime() - block.startAt.getTime();
  if (dur <= 0) return out;
  if (block.recurrence !== "daily" && block.recurrence !== "weekdays" && block.recurrence !== "weekly") {
    if (block.endAt > from && block.startAt < to) out.push({ start: block.startAt, end: block.endAt });
    return out;
  }
  const tz = resolveTimeZone(timeZone);
  const p = zonedParts(block.startAt, tz);
  for (let i = 0; i < 800 && out.length < max; i++) {
    const step = block.recurrence === "weekly" ? i * 7 : i;
    const start = zonedTimeToUtc(p.year, p.month, p.day + step, p.minutes, tz).date;
    if (start >= to) break;
    if (block.recurrence === "weekdays") {
      const wd = zonedParts(start, tz).weekday;
      if (wd === 0 || wd === 6) continue;
    }
    const end = new Date(start.getTime() + dur);
    if (end > from) out.push({ start, end });
  }
  return out;
}

/** Every source in the window, sorted by start. Never throws for one source. */
export async function loadCalendarEvents(ctx: CalendarCtx, from: Date, to: Date, opts: { include?: readonly CalendarSource[] } = {}): Promise<CalendarLoad> {
  const tz = resolveTimeZone(ctx.timeZone);
  const want = new Set<CalendarSource>(opts.include ?? CALENDAR_SOURCES);
  const errors: CalendarLoad["errors"] = [];
  const conns = await personalConnections(ctx.workspaceId, ctx.userId, ["google-calendar", "outlook-calendar"]).catch(() => []);
  const connections: CalendarConnectionView[] = conns.map((c) => ({ id: c.id, key: c.connectorKey as CalendarConnectionView["key"], account: c.account }));

  const fromConnectors = Promise.all(
    conns
      .filter((c) => want.has(c.connectorKey === "google-calendar" ? "google" : "outlook"))
      .map(async (c) => {
        const r = await connectorEvents(c, ctx, from, to);
        if (r.error) errors.push({ source: c.connectorKey, message: r.error });
        return r.events;
      }),
  );

  const native = withWorkspaceScope(ctx.workspaceId, async (tx) => {
    const ws = ctx.workspaceId;
    const [bookings, focus, opsEvents, social, reminders, meetings] = await Promise.all([
      want.has("booking")
        ? tx.booking.findMany({
            where: { workspaceId: ws, status: { not: "cancelled" }, startAt: { lt: to }, endAt: { gt: from } },
            orderBy: { startAt: "asc" },
            take: 500,
            select: { id: true, name: true, email: true, startAt: true, endAt: true, page: { select: { title: true } } },
          })
        : [],
      want.has("focus")
        ? tx.wfhFocusBlock.findMany({
            where: { workspaceId: ws, userId: ctx.userId, status: { notIn: ["cancelled", "overridden"] }, OR: [{ recurrence: { not: "none" } }, { startAt: { lt: to }, endAt: { gt: from } }] },
            take: 200,
            select: { id: true, title: true, startAt: true, endAt: true, recurrence: true },
          })
        : [],
      want.has("ops_event")
        ? tx.opsEvent.findMany({
            where: { workspaceId: ws, status: { not: "cancelled" }, startsAt: { lt: to }, endsAt: { gt: from } },
            orderBy: { startsAt: "asc" },
            take: 200,
            select: { id: true, title: true, startsAt: true, endsAt: true, venue: true, webinarUrl: true, status: true },
          })
        : [],
      want.has("social")
        ? tx.socialPublication.findMany({
            where: { workspaceId: ws, scheduledFor: { gte: from, lt: to }, status: { in: ["approved", "scheduled", "published", "pending_approval"] } },
            orderBy: { scheduledFor: "asc" },
            take: 200,
            select: { id: true, content: true, scheduledFor: true, status: true },
          })
        : [],
      want.has("reminder")
        ? tx.opsTask.findMany({
            where: { workspaceId: ws, projectId: null, assigneeId: ctx.userId, stage: { notIn: ["done", "cancelled"] }, dueAt: { gte: from, lt: to } },
            orderBy: { dueAt: "asc" },
            take: 200,
            select: { id: true, title: true, dueAt: true },
          })
        : [],
      want.has("meeting")
        ? // Meet: a call started in a channel shows only for the person who
          // started it (a private channel's call title never leaks here);
          // other meetings are the workspace's.
          tx.meetingSession.findMany({
            where: { workspaceId: ws, startedAt: { gte: from, lt: to }, OR: [{ startedBy: ctx.userId }, { origin: { not: "channel" } }] },
            orderBy: { startedAt: "asc" },
            take: 200,
            select: { id: true, title: true, startedAt: true, endedAt: true },
          })
        : [],
    ]);
    const out: CalendarEvent[] = [];
    const base = { location: null, attendees: [] as string[], externalUrl: null, editable: false, connectionId: null, externalId: null, mock: false, allDay: false };
    for (const b of bookings)
      out.push({ ...base, id: `booking:${b.id}`, source: "booking", title: `${b.page?.title ?? "Booking"} · ${b.name}`, start: b.startAt.toISOString(), end: b.endAt.toISOString(), attendees: b.email ? [b.email] : [], href: "/dashboard/calls" });
    for (const f of focus)
      for (const o of focusOccurrences(f, from, to, tz))
        out.push({ ...base, id: `focus:${f.id}:${o.start.toISOString()}`, source: "focus", title: f.title, start: o.start.toISOString(), end: o.end.toISOString(), href: "/dashboard/wfh" });
    for (const e of opsEvents)
      out.push({ ...base, id: `ops_event:${e.id}`, source: "ops_event", title: e.title, start: e.startsAt.toISOString(), end: e.endsAt.toISOString(), location: e.venue, externalUrl: https(e.webinarUrl), href: `/dashboard/ops/events?event=${encodeURIComponent(e.id)}` });
    for (const s of social)
      out.push({ ...base, id: `social:${s.id}`, source: "social", title: s.content.replace(/\s+/g, " ").slice(0, 80) || "Social post", start: s.scheduledFor!.toISOString(), end: null, href: "/dashboard/social" });
    for (const r of reminders)
      out.push({ ...base, id: `reminder:${r.id}`, source: "reminder", title: r.title, start: r.dueAt!.toISOString(), end: null, href: `/dashboard/reminders?reminder=${encodeURIComponent(r.id)}` });
    for (const m of meetings)
      out.push({ ...base, id: `meeting:${m.id}`, source: "meeting", title: m.title, start: m.startedAt.toISOString(), end: m.endedAt?.toISOString() ?? null, href: `/dashboard/meet?session=${encodeURIComponent(m.id)}` });
    return out;
  }).catch((err) => {
    errors.push({ source: "workspace", message: err instanceof Error ? err.message.slice(0, 200) : "error" });
    return [] as CalendarEvent[];
  });

  const [connectorLists, nativeEvents] = await Promise.all([fromConnectors, native]);
  const events = [...connectorLists.flat(), ...nativeEvents].sort((a, b) => a.start.localeCompare(b.start));
  return { events, connections, errors, timeZone: tz };
}

/** Busy intervals for "find time": the member's calendars, bookings, focus blocks and calls. */
export async function busyIntervals(ctx: CalendarCtx, from: Date, to: Date): Promise<{ busy: Interval[]; errors: CalendarLoad["errors"]; connected: number }> {
  const load = await loadCalendarEvents(ctx, from, to, { include: ["google", "outlook", "booking", "focus", "meeting", "ops_event"] });
  const busy: Interval[] = [];
  for (const e of load.events) {
    if (e.mock) continue; // a labelled sample is never treated as real busy time
    const start = new Date(e.start);
    const end = e.end ? new Date(e.end) : new Date(start.getTime() + 30 * 60_000);
    busy.push({ start, end });
  }
  return { busy, errors: load.errors, connected: load.connections.length };
}

/** Which of the member's connected calendars can take a new event. */
export async function writableCalendars(workspaceId: string, userId: string): Promise<CalendarConnectionView[]> {
  const conns = await personalConnections(workspaceId, userId, ["google-calendar", "outlook-calendar"]);
  return conns.map((c) => ({ id: c.id, key: c.connectorKey as CalendarConnectionView["key"], account: c.account }));
}
