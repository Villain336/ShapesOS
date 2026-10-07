// ShapesOS — Phase 19B (WS=engine): town runs.
// GET  /api/rehearsal/town/runs → { runs: TownRunView[] }
// POST /api/rehearsal/town/runs <TownRunInput> & { capCredits, confirmed: true } → 201 { run }
//      The estimate is recomputed server-side; the person's confirmed cap is the hard cap.
// Access: viewer reads, editor starts; entitlement dress_rehearsal.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { defaultSimDeps } from "@/lib/sim/deps.server";
import { townActor } from "@/lib/sim/http.server";
import { listTownRuns, startTownRun } from "@/lib/sim/service.server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { user, workspace } = await guardWorkspace();
    const runs = await listTownRuns(await townActor(user.id, workspace.id));
    // The list stays light: reports are read per run.
    return Response.json({ runs: runs.map((r) => ({ ...r, report: null, hasReport: Boolean(r.report) })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace();
    const run = await startTownRun(await townActor(user.id, workspace.id), await readJson(req), defaultSimDeps);
    return Response.json({ run }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
