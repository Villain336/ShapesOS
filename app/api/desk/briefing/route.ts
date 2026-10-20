// ShapesOS — Phase 18.1 (WS=desk): the caller's "Today" briefing.
//   GET /api/desk/briefing              → BriefingData (a read — never writes one)
//   PUT /api/desk/briefing { enabled }  → { briefing }  turning it on writes
//     today's briefing once (idempotent per member per day; metered to the
//     workspace on the background workload / Batch API).
// viewer+; the caller's own opt-in and briefing (owner-only RLS).

import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { readTodayBriefing, setBriefingOptIn } from "@/lib/desktop/briefing.server";
import { getUserPreferences } from "@/lib/desktop/prefs";
import { deskGuard, NO_STORE } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await deskGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const tz = (await getUserPreferences(ctx.userId)).timeZone;
    return Response.json(await readTodayBriefing(ctx.workspaceId, ctx.userId, tz), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "GET /api/desk/briefing");
  }
}

const PutSchema = z.object({ enabled: z.boolean() });

export async function PUT(req: Request) {
  const ctx = await deskGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const body = validateBody(PutSchema, await req.json());
    if (!body.ok) return body.error;
    const tz = (await getUserPreferences(ctx.userId)).timeZone;
    await setBriefingOptIn(ctx.workspaceId, ctx.userId, body.data.enabled, { timeZone: tz });
    return Response.json({ briefing: await readTodayBriefing(ctx.workspaceId, ctx.userId, tz) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "PUT /api/desk/briefing");
  }
}
