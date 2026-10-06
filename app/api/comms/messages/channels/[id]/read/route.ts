// ShapesOS — Phase 18.2 (WS=comms): mark a channel read.
//   POST /api/comms/messages/channels/[id]/read → { ok: true }

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { markRead } from "@/lib/comms/messages/store.server";
import { idParam, messagesGuard } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await messagesGuard();
    await markRead(ctx, idParam((await params).id));
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/messages/channels/[id]/read");
  }
}
