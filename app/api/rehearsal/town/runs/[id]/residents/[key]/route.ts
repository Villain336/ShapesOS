// ShapesOS — Phase 19B (WS=engine): follow a resident — their thought log.
// GET /api/rehearsal/town/runs/:id/residents/:key?variant=A|B → ResidentLog (viewer+)

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { townActor } from "@/lib/sim/http.server";
import { residentLog } from "@/lib/sim/service.server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; key: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace();
    const { id, key } = await params;
    const variant = new URL(req.url).searchParams.get("variant") === "B" ? "B" : "A";
    return Response.json(await residentLog(await townActor(user.id, workspace.id), id, key, variant), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
