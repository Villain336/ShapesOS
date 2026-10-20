// ShapesOS — Phase 18.2 (WS=comms): channel membership.
//   POST   /api/comms/messages/channels/[id]/members { join: true } | { members: [...] } → { members }
//          (join: a project or public channel; add: any member of the channel, never a DM)
//   DELETE /api/comms/messages/channels/[id]/members → 204   (leave; not a DM)

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { addMembers, channelMembers, joinChannel, leaveChannel } from "@/lib/comms/messages/store.server";
import { idParam, messagesGuard } from "../../../_lib";

export const dynamic = "force-dynamic";

const Body = z.union([z.object({ join: z.literal(true) }).strict(), z.object({ members: z.array(z.string().max(120)).min(1).max(100) }).strict()]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await messagesGuard();
    const id = idParam((await params).id);
    const parsed = validateBody(Body, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    if ("join" in parsed.data) {
      await joinChannel(ctx, id);
      return Response.json({ members: await channelMembers(ctx, id) });
    }
    return Response.json({ members: await addMembers(ctx, id, parsed.data.members) });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/messages/channels/[id]/members");
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await messagesGuard();
    await leaveChannel(ctx, idParam((await params).id));
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, "DELETE /api/comms/messages/channels/[id]/members");
  }
}
