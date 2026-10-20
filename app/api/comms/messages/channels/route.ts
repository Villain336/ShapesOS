// ShapesOS — Phase 18.2 (WS=comms): Messages channels.
//   GET  /api/comms/messages/channels → { channels }   (project, public, mine private, my DMs; unread counts)
//   POST /api/comms/messages/channels { name, topic?, isPrivate?, members?: ["user:<id>"|"agent:<key>"] } → { channel } (201)

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { createChannel, listChannels } from "@/lib/comms/messages/store.server";
import { messagesGuard } from "../_lib";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    name: z.string().trim().min(1).max(80),
    topic: z.string().max(250).nullable().optional(),
    isPrivate: z.boolean().optional(),
    members: z.array(z.string().max(120)).max(100).optional(),
  })
  .strict();

export async function GET() {
  try {
    const ctx = await messagesGuard();
    return Response.json({ channels: await listChannels(ctx) });
  } catch (err) {
    return errorResponse(err, "GET /api/comms/messages/channels");
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await messagesGuard();
    const parsed = validateBody(Body, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    const channel = await createChannel(ctx, parsed.data);
    return Response.json({ channel }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/messages/channels");
  }
}
