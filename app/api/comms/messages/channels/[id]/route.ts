// ShapesOS — Phase 18.2 (WS=comms): one channel.
//   GET   /api/comms/messages/channels/[id] → { channel, members }   (404 when you can't see it)
//   PATCH /api/comms/messages/channels/[id] { name?, topic?, archived? } → { channel }   (its owner or an admin)

import type { NextRequest } from "next/server";
import { errorResponse, HttpError } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { channelMembers, listChannels, updateChannel } from "@/lib/comms/messages/store.server";
import { idParam, messagesGuard } from "../../_lib";

export const dynamic = "force-dynamic";

const Patch = z
  .object({ name: z.string().trim().min(1).max(80).optional(), topic: z.string().max(250).nullable().optional(), archived: z.boolean().optional() })
  .strict();

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await messagesGuard();
    const id = idParam((await params).id);
    const members = await channelMembers(ctx, id);
    const channel = (await listChannels(ctx, { includeArchived: true })).find((c) => c.id === id);
    if (!channel) throw new HttpError(404, "Channel not found.");
    return Response.json({ channel, members });
  } catch (err) {
    return errorResponse(err, "GET /api/comms/messages/channels/[id]");
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await messagesGuard();
    const id = idParam((await params).id);
    const parsed = validateBody(Patch, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    await updateChannel(ctx, id, parsed.data);
    const channel = (await listChannels(ctx, { includeArchived: true })).find((c) => c.id === id) ?? null;
    return Response.json({ channel });
  } catch (err) {
    return errorResponse(err, "PATCH /api/comms/messages/channels/[id]");
  }
}
