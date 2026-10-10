// ShapesOS — Phase 21A round 2 (WS=agentweb): one research session.
//   GET /api/agentweb/research/:id → { research, progress } (the owner, or any member once it is shared)
// "progress" is the linked browsing session's state (steps, status, sites), when the owner linked one.

import { NextResponse } from "next/server";
import { httpErrorResponse } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { getResearch } from "@/lib/agentweb/research/store";
import { getSessionView } from "@/lib/agentweb/sessions/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await answerActor();
    const { id } = await ctx.params;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const research = await getResearch(workspace.id, user.id, id, { includeWorkspace: true });
    if (!research) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const progress = research.runId ? await getSessionView(workspace.id, research.runId) : null;
    return NextResponse.json({ research, progress }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
