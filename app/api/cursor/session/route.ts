// ShapesOS — Phase 19A (WS=server): POST /api/cursor/session
// → 200 { token, expiresAt, workspaceId, user, voice, limits, providers }
// (p19a-contract.md). ShapesOS Desktop's main process calls this with the
// session cookies of its signed-in window and gets a SHORT-LIVED (≤ 10 min)
// HMAC token bound to this user + workspace, which every /api/cursor/* route
// accepts as `Authorization: Bearer`. Any member (viewer included: a viewer
// may ask and be pointed at things; acting needs editor+ on each route).
// The response never contains a provider key.

import { requireWorkspaceRole } from "@/lib/authz";
import { cursorErrorResponse, forbiddenCursor, resolveCursorCaller } from "@/lib/cursor/http";
import { cursorSession } from "@/lib/cursor/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const caller = await resolveCursorCaller(req);
    if (!(await requireWorkspaceRole(caller.userId, caller.workspaceId, "viewer"))) throw forbiddenCursor("You are not a member of this workspace.");
    return Response.json(await cursorSession(caller), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return cursorErrorResponse(err);
  }
}
