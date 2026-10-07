// ShapesOS — Phase 19B (WS=engine): one town run with its report.
// GET /api/rehearsal/town/runs/:id → { run, world, residents } (viewer+)

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { townActor } from "@/lib/sim/http.server";
import { getTownRun, listRunResidents, listWorlds } from "@/lib/sim/service.server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await townActor(user.id, workspace.id);
    const { id } = await params;
    const run = await getTownRun(actor, id);
    const [worlds, residents] = await Promise.all([listWorlds(actor), listRunResidents(actor, id)]);
    const world = worlds.find((w) => w.id === run.worldId) ?? null;
    return Response.json({ run, world, residents }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
