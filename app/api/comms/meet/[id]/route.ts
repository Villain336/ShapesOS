// ShapesOS — Phase 18.2 (WS=comms): one meeting.
//   GET   /api/comms/meet/[id] → { meeting }   (with its transcript and summary; 404 when you can't see it)
//   PATCH /api/comms/meet/[id] { end: true } → { meeting }   (the person who started it, or an admin)

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { endMeeting, getMeeting } from "@/lib/comms/meet/meet.server";
import { idParam, meetGuard } from "../_lib";

export const dynamic = "force-dynamic";

const Patch = z.object({ end: z.literal(true) }).strict();

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await meetGuard();
    return Response.json({ meeting: await getMeeting(ctx, idParam((await params).id)) });
  } catch (err) {
    return errorResponse(err, "GET /api/comms/meet/[id]");
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await meetGuard();
    const parsed = validateBody(Patch, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    return Response.json({ meeting: await endMeeting(ctx, idParam((await params).id)) });
  } catch (err) {
    return errorResponse(err, "PATCH /api/comms/meet/[id]");
  }
}
