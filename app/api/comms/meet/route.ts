// ShapesOS — Phase 18.2 (WS=comms): Meet.
//   GET  /api/comms/meet → { meetings, livekit: { configured, mode, reason }, opsProjects }
//   POST /api/comms/meet { title?, origin?: adhoc|calendar|channel, originRef? } → { meeting } (201)
// Starting from a channel posts "Started a call" with a Join button there.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { listMeetings, liveKitState, opsProjects, startMeeting } from "@/lib/comms/meet/meet.server";
import { meetGuard } from "./_lib";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    title: z.string().max(200).nullable().optional(),
    origin: z.enum(["adhoc", "calendar", "channel"]).optional(),
    originRef: z.string().max(400).nullable().optional(),
  })
  .strict();

export async function GET() {
  try {
    const ctx = await meetGuard();
    const [meetings, livekit, projects] = await Promise.all([listMeetings(ctx), liveKitState(), opsProjects(ctx).catch(() => [])]);
    return Response.json({ meetings, livekit, opsProjects: projects });
  } catch (err) {
    return errorResponse(err, "GET /api/comms/meet");
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await meetGuard();
    const parsed = validateBody(Body, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    return Response.json({ meeting: await startMeeting(ctx, parsed.data) }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/meet");
  }
}
