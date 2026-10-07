// ShapesOS — Phase 19B (WS=panel): the up-front estimate for a page walk.
//   POST { personaIds, stepCap? } → { estimate }   (viewer+; no model call)

import { errorResponse } from "@/lib/api/errors";
import { panelDeps } from "@/lib/panel/deps.server";
import { estimatePageWalk } from "@/lib/panel/service.server";
import { badBody, readJson, rehearsalGuard, strings } from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const actor = await rehearsalGuard("viewer");
    if (actor instanceof Response) return actor;
    const body = await readJson(req);
    if (!body) return badBody();
    return Response.json({ estimate: await estimatePageWalk(actor, { personaIds: strings(body.personaIds), stepCap: Number(body.stepCap) || undefined }, panelDeps()) });
  } catch (err) {
    return errorResponse(err, "POST /api/rehearsal/runs/estimate", req);
  }
}
