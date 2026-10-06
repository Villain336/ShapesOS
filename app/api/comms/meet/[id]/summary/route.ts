// ShapesOS — Phase 18.2 (WS=comms): the meeting agent.
//   POST /api/comms/meet/[id]/summary → { meeting }   (editor+)
// The workspace's background model reads the transcript and writes notes,
// decisions and action items (metered like every model call). Without a
// live model the summary is labelled mock and can't be saved.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { summarizeMeeting } from "@/lib/comms/meet/meet.server";
import { idParam, meetGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await meetGuard();
    return Response.json({ meeting: await summarizeMeeting(ctx, idParam((await params).id)) });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/meet/[id]/summary");
  }
}
