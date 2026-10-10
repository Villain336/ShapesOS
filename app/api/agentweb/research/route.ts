// ShapesOS — Phase 21A round 2 (WS=agentweb): research sessions.
//   GET  /api/agentweb/research   → { research[] }: yours and the ones members shared with the workspace
//   POST /api/agentweb/research   { op: create | update | remove | attach_answer | attach_page | clip, … } (same-origin JSON)
// A session is its starter's until they share it; sharing needs the editor role; clipping into other
// apps needs the role the tool needs (editor+).

import { NextResponse } from "next/server";
import { httpErrorResponse } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { listResearch } from "@/lib/agentweb/research/store";
import { handleResearchOp } from "@/lib/agentweb/research/route-core";
import "@/lib/answer/tools";
import "@/lib/documents/tools";

export const dynamic = "force-dynamic";
// Attaching a page reads it over the network.
export const maxDuration = 60;

export async function GET() {
  try {
    const { user, workspace } = await answerActor();
    return NextResponse.json({ research: await listResearch(workspace.id, user.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace, role } = await answerActor();
    return await handleResearchOp({ userId: user.id, workspaceId: workspace.id, role }, req);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
