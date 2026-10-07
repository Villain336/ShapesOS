// ShapesOS — Phase 19B (WS=panel): what deriving personas from these interviews can cost.
//   POST { transcriptIds } → { estimate }   (editor+; no model call)

import { errorResponse } from "@/lib/api/errors";
import { panelDeps } from "@/lib/panel/deps.server";
import { estimatePersonaDerivation } from "@/lib/panel/service.server";
import { badBody, readJson, rehearsalGuard, strings } from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const actor = await rehearsalGuard("editor");
    if (actor instanceof Response) return actor;
    const body = await readJson(req);
    if (!body) return badBody();
    return Response.json({ estimate: await estimatePersonaDerivation(actor, strings(body.transcriptIds), panelDeps()) });
  } catch (err) {
    return errorResponse(err, "POST /api/rehearsal/personas/estimate", req);
  }
}
