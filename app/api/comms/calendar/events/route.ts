// ShapesOS — Phase 18.2 (WS=comms): the Calendar app.
//   GET   /api/comms/calendar/events?from=&to=[&sources=a,b] → { events, connections, errors, timeZone }   (viewer+)
//   POST  /api/comms/calendar/events { connectionId, title, start, end, timeZone?, attendees?, description?, location?, notifyAttendees? }
//   PATCH /api/comms/calendar/events { connectionId, eventId, …fields }
// Reads: the member's own connected calendars + bookings, focus blocks, Ops
// events, scheduled social posts, reminders and calls (lib/comms/calendar).
// Writes go to the member's OWN connected calendar through the connector's
// create_event / update_event (the person's click is the confirmation).

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { CALENDAR_SOURCES, loadCalendarEvents, type CalendarSource } from "@/lib/comms/calendar/sources.server";
import { saveCalendarEvent } from "@/lib/comms/calendar/write.server";
import { commsGuard, memberTimeZone } from "../../_lib";

export const dynamic = "force-dynamic";

const MAX_WINDOW_MS = 62 * 86_400_000;

function windowOf(req: NextRequest): { from: Date; to: Date } {
  const p = req.nextUrl.searchParams;
  const now = new Date();
  const from = p.get("from") && !Number.isNaN(Date.parse(p.get("from")!)) ? new Date(p.get("from")!) : new Date(now.getTime() - 7 * 86_400_000);
  let to = p.get("to") && !Number.isNaN(Date.parse(p.get("to")!)) ? new Date(p.get("to")!) : new Date(from.getTime() + 35 * 86_400_000);
  if (to <= from) to = new Date(from.getTime() + 86_400_000);
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) to = new Date(from.getTime() + MAX_WINDOW_MS);
  return { from, to };
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await commsGuard("viewer");
    const { from, to } = windowOf(req);
    const raw = req.nextUrl.searchParams.get("sources");
    const include = raw ? (raw.split(",").filter((s) => (CALENDAR_SOURCES as readonly string[]).includes(s)) as CalendarSource[]) : undefined;
    const timeZone = await memberTimeZone(ctx.userId);
    const load = await loadCalendarEvents({ workspaceId: ctx.workspaceId, userId: ctx.userId, timeZone }, from, to, { include });
    return Response.json(load);
  } catch (err) {
    return errorResponse(err, "GET /api/comms/calendar/events");
  }
}

const Fields = {
  title: z.string().trim().min(1).max(500),
  start: z.string().min(10).max(40),
  end: z.string().min(10).max(40),
  timeZone: z.string().max(64).optional(),
  attendees: z.string().max(4000).optional(),
  description: z.string().max(8000).optional(),
  location: z.string().max(500).optional(),
  notifyAttendees: z.boolean().optional(),
};
const CreateSchema = z.object({ connectionId: z.string().min(1).max(64), ...Fields });
const PatchSchema = z.object({
  connectionId: z.string().min(1).max(64),
  eventId: z.string().min(1).max(1024),
  title: Fields.title.optional(),
  start: Fields.start.optional(),
  end: Fields.end.optional(),
  timeZone: Fields.timeZone,
  attendees: Fields.attendees,
  description: Fields.description,
  location: Fields.location,
  notifyAttendees: Fields.notifyAttendees,
});

export async function POST(req: NextRequest) {
  try {
    const ctx = await commsGuard("viewer");
    const parsed = validateBody(CreateSchema, await req.json());
    if (!parsed.ok) return parsed.error;
    const { connectionId, ...fields } = parsed.data;
    const out = await saveCalendarEvent({ workspaceId: ctx.workspaceId, userId: ctx.userId, connectionId, fields, by: "person" });
    return Response.json(out, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/calendar/events");
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await commsGuard("viewer");
    const parsed = validateBody(PatchSchema, await req.json());
    if (!parsed.ok) return parsed.error;
    const { connectionId, eventId, ...fields } = parsed.data;
    const out = await saveCalendarEvent({ workspaceId: ctx.workspaceId, userId: ctx.userId, connectionId, eventId, fields, by: "person" });
    return Response.json(out);
  } catch (err) {
    return errorResponse(err, "PATCH /api/comms/calendar/events");
  }
}
