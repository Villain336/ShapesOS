// ShapesOS — Phase 19B (WS=panel): what changed between two runs.
//   GET ?before=<runId>&after=<runId> → { diff }   (viewer+)

import { errorResponse } from "@/lib/api/errors";
import { diffRuns } from "@/lib/panel/service.server";
import { rehearsalGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const actor = await rehearsalGuard("viewer");
    if (actor instanceof Response) return actor;
    const u = new URL(req.url);
    const before = u.searchParams.get("before") ?? "";
    const after = u.searchParams.get("after") ?? "";
    if (!before || !after) return Response.json({ error: "Pick two runs to compare." }, { status: 400 });
    return Response.json({ diff: await diffRuns(actor, before, after) });
  } catch (err) {
    return errorResponse(err, "GET /api/rehearsal/runs/diff", req);
  }
}
