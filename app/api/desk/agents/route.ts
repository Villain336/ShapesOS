// ShapesOS — Phase 18.1 (WS=desk): Control Center → Pause all agents / Resume.
//   POST /api/desk/agents { action: "pause" } → { paused: true, stopped: [runIds] }
//   POST /api/desk/agents { action: "resume" } → { paused: false }
// admin+ only: it freezes the whole workspace through the kill switch
// (lib/orchestrator/killswitch.ts) and stops every live run the way Stop
// does; both directions are written to command_audit.

import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { pauseAllAgents, resumeAgents } from "@/lib/desktop/control.server";
import { deskGuard, NO_STORE } from "../_lib";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ action: z.enum(["pause", "resume"]) });

export async function POST(req: Request) {
  const ctx = await deskGuard("admin");
  if (ctx instanceof Response) return ctx;
  try {
    const body = validateBody(BodySchema, await req.json());
    if (!body.ok) return body.error;
    if (body.data.action === "pause") {
      return Response.json(await pauseAllAgents(ctx.workspaceId, ctx.userId), { headers: NO_STORE });
    }
    await resumeAgents(ctx.workspaceId, ctx.userId);
    return Response.json({ paused: false }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "POST /api/desk/agents");
  }
}
