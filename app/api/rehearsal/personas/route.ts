// ShapesOS — Phase 19B (WS=panel): Dress Rehearsal personas.
//   GET  → { personas }                   (viewer+)
//   POST { spec } → 201 { persona }       a hand-made persona (uncalibrated: it walks, it gets no verdict) (editor+)

import { errorResponse } from "@/lib/api/errors";
import { addManualPersona, listPersonas } from "@/lib/panel/service.server";
import { badBody, readJson, rehearsalGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const actor = await rehearsalGuard("viewer");
    if (actor instanceof Response) return actor;
    return Response.json({ personas: await listPersonas(actor) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/rehearsal/personas", req);
  }
}

export async function POST(req: Request) {
  try {
    const actor = await rehearsalGuard("editor");
    if (actor instanceof Response) return actor;
    const body = await readJson(req);
    if (!body) return badBody();
    return Response.json({ persona: await addManualPersona(actor, body.spec) }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/rehearsal/personas", req);
  }
}
