// ShapesOS — Phase 19B (WS=engine): replay a town run from its seed.
// POST /api/rehearsal/town/runs/:id/replay { capCredits, confirmed: true } → 201 { run }
// The original's recorded decisions answer first (a replay doesn't pay twice). Editor+.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { defaultSimDeps } from "@/lib/sim/deps.server";
import { townActor } from "@/lib/sim/http.server";
import { replayTownRun } from "@/lib/sim/service.server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace();
    const { id } = await params;
    const run = await replayTownRun(await townActor(user.id, workspace.id), id, await readJson(req), defaultSimDeps);
    return Response.json({ run }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
