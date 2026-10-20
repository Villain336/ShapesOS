// ShapesOS — Phase 18.2 (WS=comms): the dock's Messages count.
//   GET /api/comms/messages/unread → { total, mentions, channels }

import { errorResponse } from "@/lib/api/errors";
import { unreadSummary } from "@/lib/comms/messages/store.server";
import { messagesGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await messagesGuard();
    return Response.json(await unreadSummary(ctx));
  } catch (err) {
    return errorResponse(err, "GET /api/comms/messages/unread");
  }
}
