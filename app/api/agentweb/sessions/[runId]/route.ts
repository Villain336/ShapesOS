// ShapesOS — Phase 21A round 2 (WS=agentweb): one browsing session.
//   GET  /api/agentweb/sessions/:runId   → { session, replay[] } (any member): the steps from the stored receipts
//   POST /api/agentweb/sessions/:runId   { op: pause | resume | takeover | handback | step | approve | reject |
//                                          step_mode | caps, … } (editor+, same-origin JSON)

import { NextResponse } from "next/server";
import { httpErrorResponse } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { getSessionView } from "@/lib/agentweb/sessions/store";
import { loadReplay } from "@/lib/agentweb/sessions/replay";
import { handleSessionOp } from "@/lib/agentweb/sessions/route-core";

export const dynamic = "force-dynamic";

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  try {
    const { workspace } = await answerActor();
    const { runId } = await ctx.params;
    if (!RUN_ID.test(runId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const session = await getSessionView(workspace.id, runId);
    if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ session, replay: await loadReplay(workspace.id, runId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  try {
    const { user, workspace, role } = await answerActor();
    const { runId } = await ctx.params;
    if (!RUN_ID.test(runId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return await handleSessionOp({ userId: user.id, workspaceId: workspace.id, role }, req, runId);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
