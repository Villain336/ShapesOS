// ShapesOS — Phase 21A round 2 (WS=agentweb): POST /api/agentweb/mandates/:id/sign
// — the click on the Tier 3 card. { channel: "ui_click" } → { mandate, outcome }.
//
// The ONLY way a cart mandate gets signed. It is a signed-in session route (editor or above)
// behind lib/agentweb/commerce/http.ts humanClickGuard: same-origin fetch from this app's own
// page, JSON, channel "ui_click". No tool, API key, voice approval or agent can call it as a
// person. Signing records the person's signature; what it buys is decided server-side
// (finish.ts): a checkout we can drive, or "stopped at payment" for the person to finish.
// Money is never moved by anything that is not this click.

import { httpErrorResponse } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { handleSign } from "@/lib/agentweb/commerce/route-core";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace, role } = await answerActor();
    const { id } = await ctx.params;
    return await handleSign({ userId: user.id, workspaceId: workspace.id, role }, req, id);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
