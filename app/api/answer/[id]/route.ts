// ShapesOS — Phase 21A (WS=agentweb): one stored answer, for the person who asked it.
// GET /api/answer/:id → { id, question, status, mock, payload, usage, createdAt } | 404

import { httpErrorResponse } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { getAnswer } from "@/lib/answer/service";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await answerActor();
    const { id } = await ctx.params;
    const a = await getAnswer(workspace.id, user.id, id);
    return a ? Response.json(a, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Not found" }, { status: 404 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
