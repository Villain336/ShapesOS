// ShapesOS — Phase 19B (WS=panel): the track record — what really converted after launch.
//   PUT { conversions, visitors } → { calibration, summary }   (editor+)

import { errorResponse } from "@/lib/api/errors";
import { recordLaunch } from "@/lib/panel/service.server";
import { badBody, readJson, rehearsalGuard } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await rehearsalGuard("editor");
    if (actor instanceof Response) return actor;
    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return badBody();
    return Response.json(await recordLaunch(actor, id, { conversions: Number(body.conversions), visitors: Number(body.visitors) }));
  } catch (err) {
    return errorResponse(err, "PUT /api/rehearsal/runs/[id]/launch", req);
  }
}
