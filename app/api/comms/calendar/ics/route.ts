// ShapesOS — Phase 18.2 (WS=comms): download one event as .ics.
//   GET /api/comms/calendar/ics?id=<calendar event id>&at=<its start, ISO> → text/calendar   (viewer+)
// The event is re-read from its source (never trusted from the request).

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { loadCalendarEvents } from "@/lib/comms/calendar/sources.server";
import { buildIcs, icsFileName } from "@/lib/comms/calendar/ics";
import { commsGuard, memberTimeZone } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const ctx = await commsGuard("viewer");
    const id = (req.nextUrl.searchParams.get("id") ?? "").slice(0, 1200);
    const at = Date.parse(req.nextUrl.searchParams.get("at") ?? "");
    if (!id || Number.isNaN(at)) return Response.json({ error: "id and at are required." }, { status: 400 });
    const timeZone = await memberTimeZone(ctx.userId);
    const load = await loadCalendarEvents({ workspaceId: ctx.workspaceId, userId: ctx.userId, timeZone }, new Date(at - 2 * 86_400_000), new Date(at + 2 * 86_400_000));
    const e = load.events.find((x) => x.id === id);
    if (!e) return Response.json({ error: "Event not found." }, { status: 404 });
    const body = buildIcs({
      name: e.title || "Event",
      events: [{ uid: `${e.id}@shapesos`, title: e.title, start: new Date(e.start), end: e.end ? new Date(e.end) : null, allDay: e.allDay, location: e.location, url: e.externalUrl, attendees: e.attendees }],
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="${icsFileName(e.title)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err, "GET /api/comms/calendar/ics");
  }
}
