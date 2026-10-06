// ShapesOS — Phase 18.2 (WS=comms): find time.
//   POST /api/comms/calendar/find-time { durationMin, from?, to?, workStart?, workEnd?, days? } → { slots, busyCount, connected, errors }   (viewer+)
// Free slots inside working hours in the member's time zone, around their
// connected calendars, bookings, focus blocks, calls and Ops events
// (lib/comms/calendar/freebusy.ts). Proposals only — booking one creates an
// event on their own calendar (POST /api/comms/calendar/events).

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { busyIntervals } from "@/lib/comms/calendar/sources.server";
import { findSlots } from "@/lib/comms/calendar/freebusy";
import { commsGuard, memberTimeZone } from "../../_lib";

export const dynamic = "force-dynamic";

const Body = z.object({
  durationMin: z.number().int().min(10).max(480),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  workStart: z.number().int().min(0).max(1439).optional(),
  workEnd: z.number().int().min(1).max(1440).optional(),
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  max: z.number().int().min(1).max(20).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const ctx = await commsGuard("viewer");
    const parsed = validateBody(Body, await req.json());
    if (!parsed.ok) return parsed.error;
    const b = parsed.data;
    const now = new Date();
    const from = b.from ? new Date(b.from) : now;
    const to = b.to ? new Date(b.to) : new Date(from.getTime() + 7 * 86_400_000);
    if (to.getTime() - from.getTime() > 31 * 86_400_000) return Response.json({ error: "Look at most 31 days ahead." }, { status: 400 });
    const timeZone = await memberTimeZone(ctx.userId);
    const { busy, errors, connected } = await busyIntervals({ workspaceId: ctx.workspaceId, userId: ctx.userId, timeZone }, from, to);
    const slots = findSlots({
      busy,
      from,
      to,
      durationMin: b.durationMin,
      timeZone,
      workStartMin: b.workStart,
      workEndMin: b.workEnd,
      days: b.days,
      max: b.max ?? 8,
      notBefore: new Date(now.getTime() + 15 * 60_000),
    });
    return Response.json({ slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })), busyCount: busy.length, connected, errors, timeZone });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/calendar/find-time");
  }
}
