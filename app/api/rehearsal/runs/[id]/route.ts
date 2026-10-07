// ShapesOS — Phase 19B (WS=panel): one run with its steps, verdicts, report and calibration.
//   GET → { run, steps, verdicts, calibration }   (viewer+)

import { errorResponse } from "@/lib/api/errors";
import { getRun } from "@/lib/panel/service.server";
import { rehearsalGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await rehearsalGuard("viewer");
    if (actor instanceof Response) return actor;
    const { id } = await ctx.params;
    return Response.json(await getRun(actor, id), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/rehearsal/runs/[id]", req);
  }
}
