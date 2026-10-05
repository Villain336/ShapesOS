// ShapesOS — Phase 11 (conncore): Google Calendar events read/write (live).
//
//   GET   https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events
//         ?timeMin&timeMax&singleEvents=true&orderBy=startTime   → list_events
//   POST  …/calendars/{calendarId}/events?sendUpdates=all|none    → create_event
//   PATCH …/calendars/{calendarId}/events/{eventId}?sendUpdates=…  → update_event
// Scope: calendar.events (read/write events; calendar.readonly stays for
// the attendee import). Docs:
//   https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
//   https://developers.google.com/workspace/calendar/api/v3/reference/events/patch
//
// A date-time without an offset needs a timeZone (Google rejects it
// otherwise) — UTC when none is given. Writes are never retried on
// 5xx/network errors (no duplicate events); refresh-on-401 still happens.

import { liveRequest, type LiveDeps, type TokenSource } from "./http";
import type { CalendarEventSummary, EventFields } from "./graph";

export const GCAL_API = "https://www.googleapis.com/calendar/v3";
const PROVIDER = "Google Calendar";

const writeDeps = (deps: LiveDeps): LiveDeps => ({ ...deps, maxRetries: 0 });

interface RawGEvent {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  location?: string;
  attendees?: Array<{ email?: string }>;
  htmlLink?: string;
}

function summary(e: RawGEvent): CalendarEventSummary {
  return {
    id: String(e.id ?? ""),
    title: String(e.summary ?? ""),
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    timeZone: e.start?.timeZone ?? null,
    location: e.location || null,
    attendees: (e.attendees ?? []).map((a) => String(a.email ?? "")).filter(Boolean),
    url: e.htmlLink ?? null,
  };
}

export function calendarIdOf(v: unknown): string {
  const id = typeof v === "string" && v.trim() ? v.trim() : "primary";
  if (!/^[A-Za-z0-9_.@#+\-]{1,256}$/.test(id)) throw new Error("calendarId must be a calendar id or \"primary\".");
  return id;
}

function eventIdOf(v: unknown): string {
  const id = typeof v === "string" ? v.trim() : "";
  if (!/^[A-Za-z0-9_\-@.]{1,1024}$/.test(id)) throw new Error("eventId must be a Google Calendar event id.");
  return id;
}

const hasOffset = (s: string) => /(Z|[+-]\d{2}:\d{2})$/.test(s);

/** Google event resource from validated fields. PURE. */
export function googleEventBody(f: EventFields): Record<string, unknown> {
  const dt = (s: string) => (hasOffset(s) && !f.timeZone ? { dateTime: s } : { dateTime: s, timeZone: f.timeZone ?? "UTC" });
  const body: Record<string, unknown> = {};
  if (f.title !== undefined) body.summary = f.title;
  if (f.description !== undefined) body.description = f.description;
  if (f.location !== undefined) body.location = f.location;
  if (f.start) body.start = dt(f.start);
  if (f.end) body.end = dt(f.end);
  if (f.attendees) body.attendees = f.attendees.map((email) => ({ email }));
  return body;
}

export async function gcalListEvents(
  auth: TokenSource,
  opts: { calendarId?: unknown; from: string; to: string; max?: number },
  deps: LiveDeps = {},
): Promise<CalendarEventSummary[]> {
  const cal = calendarIdOf(opts.calendarId);
  const res = await liveRequest<{ items?: RawGEvent[] }>(
    {
      provider: PROVIDER,
      url: `${GCAL_API}/calendars/${encodeURIComponent(cal)}/events`,
      query: {
        timeMin: opts.from,
        timeMax: opts.to,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: Math.min(Math.max(Math.floor(opts.max ?? 50), 1), 250),
        fields: "items(id,summary,start,end,location,attendees(email),htmlLink)",
      },
      auth,
    },
    deps,
  );
  return (res?.items ?? []).map(summary);
}

export async function gcalCreateEvent(
  auth: TokenSource,
  opts: { calendarId?: unknown; fields: EventFields; notify: boolean },
  deps: LiveDeps = {},
): Promise<CalendarEventSummary> {
  const cal = calendarIdOf(opts.calendarId);
  const e = await liveRequest<RawGEvent>(
    {
      provider: PROVIDER,
      url: `${GCAL_API}/calendars/${encodeURIComponent(cal)}/events`,
      method: "POST",
      query: { sendUpdates: opts.notify ? "all" : "none" },
      json: googleEventBody(opts.fields),
      auth,
    },
    writeDeps(deps),
  );
  return summary(e ?? {});
}

export async function gcalUpdateEvent(
  auth: TokenSource,
  opts: { calendarId?: unknown; eventId: unknown; fields: EventFields; notify: boolean },
  deps: LiveDeps = {},
): Promise<CalendarEventSummary> {
  const cal = calendarIdOf(opts.calendarId);
  const body = googleEventBody(opts.fields);
  if (Object.keys(body).length === 0) throw new Error("Nothing to update — pass at least one field.");
  const e = await liveRequest<RawGEvent>(
    {
      provider: PROVIDER,
      url: `${GCAL_API}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventIdOf(opts.eventId))}`,
      method: "PATCH",
      query: { sendUpdates: opts.notify ? "all" : "none" },
      json: body,
      auth,
    },
    writeDeps(deps),
  );
  return summary(e ?? {});
}

/** Default window for list_events: now → +14 days. */
export function eventWindow(args: Record<string, unknown>, now = new Date()): { from: string; to: string } {
  const parse = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
  const from = parse(args.from) ?? now;
  const to = parse(args.to) ?? new Date(from.getTime() + 14 * 86_400_000);
  if (to <= from) throw new Error("to must be after from.");
  if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new Error("The window must be at most a year.");
  return { from: from.toISOString(), to: to.toISOString() };
}
