// ShapesOS — Phase 18.2 (WS=comms): presence.
//   POST /api/comms/messages/presence → { ok: true }               (the open Messages app says "still here" each minute)
//   GET  /api/comms/messages/presence?ids=a,b → { presence }       (members of this workspace only)
// Someone in a focus session shows as "focus" (and their notifications wait).

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { heartbeat, presenceFor } from "@/lib/comms/messages/store.server";
import { messagesGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const ctx = await messagesGuard();
    await heartbeat(ctx);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/messages/presence");
  }
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await messagesGuard();
    const ids = (req.nextUrl.searchParams.get("ids") ?? "").split(",").map((s) => s.trim().slice(0, 64)).filter(Boolean).slice(0, 200);
    return Response.json({ presence: await presenceFor(ctx, ids) });
  } catch (err) {
    return errorResponse(err, "GET /api/comms/messages/presence");
  }
}
