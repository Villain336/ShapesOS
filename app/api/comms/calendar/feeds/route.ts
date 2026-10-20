// ShapesOS — Phase 18.2 (WS=comms): your private calendar feeds (ICS subscribe).
//   GET  /api/comms/calendar/feeds → { feeds }                     (viewer+, your own)
//   POST /api/comms/calendar/feeds → 201 { id, url }  (the URL is shown once)

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { auditEvent } from "@/lib/auditlog";
import { createFeed, listFeeds } from "@/lib/comms/calendar/feed.server";
import { commsGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await commsGuard("viewer");
    return Response.json({ feeds: await listFeeds(ctx.workspaceId, ctx.userId) });
  } catch (err) {
    return errorResponse(err, "GET /api/comms/calendar/feeds");
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await commsGuard("viewer");
    const { id, path } = await createFeed(ctx.workspaceId, ctx.userId);
    await auditEvent({ projectId: null, workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "calendar_feed_created", summary: `Calendar feed created (${id})` });
    return Response.json({ id, url: new URL(path, req.nextUrl.origin).toString() }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/calendar/feeds");
  }
}
