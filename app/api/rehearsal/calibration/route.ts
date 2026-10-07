// ShapesOS — Phase 19B (WS=panel): the workspace's calibration score (predicted vs real, every launch).
//   GET → { summary }   (viewer+)

import { errorResponse } from "@/lib/api/errors";
import { calibrationSummary } from "@/lib/panel/service.server";
import { rehearsalGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const actor = await rehearsalGuard("viewer");
    if (actor instanceof Response) return actor;
    return Response.json({ summary: await calibrationSummary(actor) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/rehearsal/calibration", req);
  }
}
