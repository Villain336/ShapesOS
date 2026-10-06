// ShapesOS — Phase 18.2 (WS=comms): a channel's messages.
//   GET  /api/comms/messages/channels/[id]/messages[?before=iso][&thread=<rootId>] → { messages, hasMore }
//   POST /api/comms/messages/channels/[id]/messages { body, parentId? } → { message, agents, agentsSkipped } (201)
// Posting notifies the people it mentions who can see it (a DM: every other
// person) through the notification producers, and starts any agent it
// mentions (editor+) as a queued agent job.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { MAX_MESSAGE_CHARS } from "@/lib/comms/messages/model";
import { listMessages, postMessage } from "@/lib/comms/messages/store.server";
import { idParam, messagesGuard } from "../../../_lib";

export const dynamic = "force-dynamic";

const Body = z.object({ body: z.string().min(1).max(MAX_MESSAGE_CHARS), parentId: z.string().max(64).nullable().optional() }).strict();

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await messagesGuard();
    const id = idParam((await params).id);
    const before = req.nextUrl.searchParams.get("before");
    const d = before ? new Date(before) : null;
    const thread = req.nextUrl.searchParams.get("thread");
    return Response.json(await listMessages(ctx, id, { before: d && !Number.isNaN(d.getTime()) ? d : null, thread: thread ? idParam(thread) : null }));
  } catch (err) {
    return errorResponse(err, "GET /api/comms/messages/channels/[id]/messages");
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await messagesGuard();
    const id = idParam((await params).id);
    const parsed = validateBody(Body, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    const out = await postMessage(ctx, id, parsed.data);
    return Response.json(out, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/messages/channels/[id]/messages");
  }
}
