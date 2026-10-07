// ShapesOS — Phase 19B (WS=panel): page walk runs.
//   GET  → { runs }   (viewer+)
//   POST { target, personaIds, stepCap?, capCredits, confirmed: true } → 201 { run }
// A run starts only after the person saw the estimate and confirmed a HARD
// credit cap; it is queued on the agent worker (editor+).

import { errorResponse } from "@/lib/api/errors";
import { panelDeps } from "@/lib/panel/deps.server";
import { listRuns, startPageWalk } from "@/lib/panel/service.server";
import { badBody, readJson, rehearsalGuard, strings } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const actor = await rehearsalGuard("viewer");
    if (actor instanceof Response) return actor;
    return Response.json({ runs: await listRuns(actor) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/rehearsal/runs", req);
  }
}

export async function POST(req: Request) {
  try {
    const actor = await rehearsalGuard("editor");
    if (actor instanceof Response) return actor;
    const body = await readJson(req);
    if (!body) return badBody();
    const run = await startPageWalk(
      actor,
      { target: body.target, personaIds: strings(body.personaIds), stepCap: Number(body.stepCap) || undefined, capCredits: Number(body.capCredits), confirmed: body.confirmed === true },
      panelDeps(),
    );
    return Response.json({ run }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/rehearsal/runs", req);
  }
}
