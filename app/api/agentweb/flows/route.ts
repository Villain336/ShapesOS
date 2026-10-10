// ShapesOS — Phase 21A round 2 (WS=agentweb): taught web flows.
//   GET  /api/agentweb/flows   → { flows[] } (any member)
//   POST /api/agentweb/flows   { op: teach | rename | publish | unpublish | workflow, … } (editor+, same-origin JSON;
//                                publish also needs channel "ui_click")
// Typed values are never recorded, so a flow holds only where to click and what to call each field.

import { NextResponse } from "next/server";
import { httpErrorResponse } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { listFlows } from "@/lib/agentweb/flows/store";
import { handleFlowOp } from "@/lib/agentweb/flows/route-core";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await answerActor();
    return NextResponse.json({ flows: await listFlows(workspace.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace, role } = await answerActor();
    return await handleFlowOp({ userId: user.id, workspaceId: workspace.id, role }, req);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
