// ShapesOS — Phase 21A round 2 (WS=agentweb): POST /api/agentweb/mandates/:id/reject
// — "No" on the cart card. Rejecting moves no money and signs nothing, so any editor in a
// signed-in session may do it; it still goes through the same same-origin JSON guard.

import { httpErrorResponse } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { handleReject } from "@/lib/agentweb/commerce/route-core";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace, role } = await answerActor();
    const { id } = await ctx.params;
    return await handleReject({ userId: user.id, workspaceId: workspace.id, role }, req, id);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
