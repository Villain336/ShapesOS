// ShapesOS — Phase 18.2 (WS=comms): revoke one of your calendar feeds.
//   DELETE /api/comms/calendar/feeds/[id] → 204   (viewer+, your own; the URL 404s at once)

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { auditEvent } from "@/lib/auditlog";
import { revokeFeed } from "@/lib/comms/calendar/feed.server";
import { commsGuard } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await commsGuard("viewer");
    const { id } = await params;
    await revokeFeed(ctx.workspaceId, ctx.userId, String(id).slice(0, 64));
    await auditEvent({ projectId: null, workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "calendar_feed_revoked", summary: `Calendar feed revoked (${id})` });
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, "DELETE /api/comms/calendar/feeds/[id]");
  }
}
