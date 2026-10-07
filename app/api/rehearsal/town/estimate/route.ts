// ShapesOS — Phase 19B (WS=engine): the up-front estimate of a town run.
// POST /api/rehearsal/town/estimate <TownRunInput> → { estimate, model, modelKind, mode }
// Nothing is spent: a rules-only dry run (lib/sim/estimate.ts). Viewer+.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { defaultSimDeps } from "@/lib/sim/deps.server";
import { townActor } from "@/lib/sim/http.server";
import { estimateTown } from "@/lib/sim/service.server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace();
    const out = await estimateTown(await townActor(user.id, workspace.id), await readJson(req), defaultSimDeps);
    return Response.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
