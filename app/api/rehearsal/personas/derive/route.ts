// ShapesOS — Phase 19B (WS=panel): derive personas from interviews.
//   POST { transcriptIds, capCredits, confirmed: true } → 201 { result }
// Model calls (4 reflection lenses + 1 persona per interview) run under the
// HARD credit cap the person confirmed after seeing the estimate (editor+).

import { errorResponse } from "@/lib/api/errors";
import { panelDeps } from "@/lib/panel/deps.server";
import { derivePersonas } from "@/lib/panel/service.server";
import { badBody, readJson, rehearsalGuard, strings } from "../../_lib";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const actor = await rehearsalGuard("editor");
    if (actor instanceof Response) return actor;
    const body = await readJson(req);
    if (!body) return badBody();
    if (body.confirmed !== true) return Response.json({ error: "Confirm the credit cap before personas are derived." }, { status: 400 });
    const result = await derivePersonas(actor, { transcriptIds: strings(body.transcriptIds), capCredits: Number(body.capCredits) }, panelDeps());
    return Response.json({ result }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/rehearsal/personas/derive", req);
  }
}
