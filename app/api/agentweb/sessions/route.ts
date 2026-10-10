// ShapesOS — Phase 21A round 2 (WS=agentweb): GET /api/agentweb/sessions?live=1
// — this workspace's browsing sessions (the Agent sessions panel). Any member may look.

import { NextResponse } from "next/server";
import { httpErrorResponse } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { listSessions } from "@/lib/agentweb/sessions/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { workspace } = await answerActor();
    const live = new URL(req.url).searchParams.get("live") === "1";
    return NextResponse.json({ sessions: await listSessions(workspace.id, { liveOnly: live }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
