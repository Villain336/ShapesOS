// ShapesOS — Phase 18.1 (WS=desk): the Control Center's state.
//   GET /api/desk/control → ControlState
//     { paused, liveRuns, canPause, focus, autoApprove, voice, spendToday }
// viewer+ (read-only; "Pause all agents" is POST /api/desk/agents, admin+).

import { errorResponse } from "@/lib/api/errors";
import { controlState } from "@/lib/desktop/control.server";
import { deskGuard, NO_STORE } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await deskGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    return Response.json(await controlState(ctx.workspaceId, ctx.userId, ctx.role), { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "GET /api/desk/control");
  }
}
