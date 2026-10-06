// ShapesOS — Phase 18.2 (WS=comms): one message.
//   PATCH  /api/comms/messages/message/[id] { body } → { message }   (your own)
//   DELETE /api/comms/messages/message/[id] → { message }            (your own, or an admin; the text goes, the thread stays)

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { MAX_MESSAGE_CHARS } from "@/lib/comms/messages/model";
import { editMessage, removeMessage } from "@/lib/comms/messages/store.server";
import { idParam, messagesGuard } from "../../_lib";

export const dynamic = "force-dynamic";

const Body = z.object({ body: z.string().min(1).max(MAX_MESSAGE_CHARS) }).strict();

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await messagesGuard();
    const parsed = validateBody(Body, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    return Response.json({ message: await editMessage(ctx, idParam((await params).id), parsed.data.body) });
  } catch (err) {
    return errorResponse(err, "PATCH /api/comms/messages/message/[id]");
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await messagesGuard();
    return Response.json({ message: await removeMessage(ctx, idParam((await params).id)) });
  } catch (err) {
    return errorResponse(err, "DELETE /api/comms/messages/message/[id]");
  }
}
