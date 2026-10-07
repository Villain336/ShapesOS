// ShapesOS — Phase 19B (WS=engine): cancel a queued or running town run.
// POST /api/rehearsal/town/runs/:id/cancel → { run } (editor+; seen by the worker at the next sim-day)

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { townActor } from "@/lib/sim/http.server";
import { cancelTownRun } from "@/lib/sim/service.server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace();
    const { id } = await params;
    return Response.json({ run: await cancelTownRun(await townActor(user.id, workspace.id), id) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
