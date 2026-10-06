// ShapesOS — Phase 18.2 (WS=comms): open (or find) a direct message.
//   POST /api/comms/messages/dm { members: ["user:<id>"|"agent:<key>", ...] } → { channel }
// One DM per set of people; only its members ever see it.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { openDm } from "@/lib/comms/messages/store.server";
import { messagesGuard } from "../_lib";

export const dynamic = "force-dynamic";

const Body = z.object({ members: z.array(z.string().max(120)).min(1).max(20) }).strict();

export async function POST(req: NextRequest) {
  try {
    const ctx = await messagesGuard();
    const parsed = validateBody(Body, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    return Response.json({ channel: await openDm(ctx, parsed.data) });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/messages/dm");
  }
}
