// ShapesOS — Phase 18.1 (WS=desk): the caller's focus / do not disturb.
//   GET /api/desk/focus                       → FocusView
//   PUT /api/desk/focus { minutes } | { until } | { on: false }
//     on  → notifications for the caller are queued (not dropped) until the end time;
//     off → focus ends now and everything queued is delivered ({ released }).
// viewer+; the state is the caller's own (user_desk_state, keyed to the session subject).

import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { endFocus, focusView, startFocus } from "@/lib/desktop/focus.server";
import { FOCUS_MAX_MINUTES } from "@/lib/desktop/focus";
import { deskGuard, NO_STORE } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await deskGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    return Response.json(await focusView(ctx.userId), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "GET /api/desk/focus");
  }
}

const PutSchema = z.union([
  z.object({ minutes: z.number().int().min(5).max(FOCUS_MAX_MINUTES) }),
  z.object({ until: z.iso.datetime() }),
  z.object({ on: z.literal(false) }),
]);

export async function PUT(req: Request) {
  const ctx = await deskGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const body = validateBody(PutSchema, await req.json());
    if (!body.ok) return body.error;
    const d = body.data;
    if ("on" in d) return Response.json(await endFocus(ctx.userId), { headers: NO_STORE });
    try {
      const view = await startFocus(ctx.userId, "minutes" in d ? { minutes: d.minutes } : { until: new Date(d.until) });
      return Response.json(view, { headers: NO_STORE });
    } catch (err) {
      if (err instanceof RangeError) return Response.json({ error: err.message }, { status: 400 });
      throw err;
    }
  } catch (err) {
    return errorResponse(err, "PUT /api/desk/focus");
  }
}
