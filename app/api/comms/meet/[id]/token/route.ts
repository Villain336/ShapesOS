// ShapesOS — Phase 18.2 (WS=comms): join a meeting's room.
//   POST /api/comms/meet/[id]/token → { url, token, roomName, identity }
// A LiveKit participant token for a PERSON joining a WebRTC room (2 h).
// Nothing dials a phone (LIVE_DIALING is untouched). 409 with
// code "livekit_not_configured" when this server runs LiveKit in rehearsal
// mode or without credentials.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { joinMeeting } from "@/lib/comms/meet/meet.server";
import { idParam, meetGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await meetGuard();
    const out = await joinMeeting(ctx, idParam((await params).id));
    return Response.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/meet/[id]/token");
  }
}
