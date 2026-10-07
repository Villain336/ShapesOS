// ShapesOS — Phase 19B (WS=panel): the founder's edit / veto of one persona.
//   PATCH { edits } → { persona }               edit the spec (re-validated) (editor+)
//   PATCH { status: "vetoed" | "active" }       veto (never walks) or bring back

import { errorResponse } from "@/lib/api/errors";
import { PersonaEditsSchema, type PersonaEdits } from "@/lib/panel/persona";
import { editPersona, setPersonaStatus } from "@/lib/panel/service.server";
import { badBody, readJson, rehearsalGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await rehearsalGuard("editor");
    if (actor instanceof Response) return actor;
    const { id } = await ctx.params;
    const body = await readJson(req);
    if (!body) return badBody();
    if (body.status === "vetoed" || body.status === "active") return Response.json({ persona: await setPersonaStatus(actor, id, body.status) });
    const edits = PersonaEditsSchema.safeParse(body.edits ?? {});
    if (!edits.success) return Response.json({ error: "Those edits don't fit a persona: check the field types." }, { status: 400 });
    return Response.json({ persona: await editPersona(actor, id, edits.data as PersonaEdits) });
  } catch (err) {
    return errorResponse(err, "PATCH /api/rehearsal/personas/[id]", req);
  }
}
