// ShapesOS — Phase 21A round 2 (WS=agentweb): your browsing memory.
//   GET  /api/agentweb/memory?q=  → { settings, items[] } — YOURS only (no way to name another member)
//   POST /api/agentweb/memory     { op: settings | forget | forget_site | forget_all, … } (same-origin JSON)
// Off by default. Remembered pages are the ones an agent read for your research; they expire after
// your retention period or when you forget them.

import { NextResponse } from "next/server";
import { httpErrorResponse } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { handleMemoryOp, memoryOverview } from "@/lib/agentweb/memory/route-core";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { user, workspace } = await answerActor();
    const q = new URL(req.url).searchParams.get("q") ?? undefined;
    return NextResponse.json(await memoryOverview({ userId: user.id, workspaceId: workspace.id }, q), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await answerActor();
    return await handleMemoryOp({ userId: user.id, workspaceId: workspace.id }, req);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
