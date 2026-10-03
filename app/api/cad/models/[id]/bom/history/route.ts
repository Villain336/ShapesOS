// ShapesOS — CAD BOM rollups across revisions (Phase 4b).
// GET /api/cad/models/[id]/bom/history — every BOM of the model, oldest
//   model version first, with cost + mass totals and the change vs the
//   previous BOM (lines added / removed / changed, cost + mass deltas).

import { guardWorkspace } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadPipelineStore } from "@/lib/cad/pipeline-store";
import { cadRouteError } from "@/lib/cad/route-errors";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadPipelineStore(prisma);
    const history = await store.getBomHistory(workspace.id, id);
    return Response.json({ history });
  } catch (e) {
    return cadRouteError(e, "GET /api/cad/models/[id]/bom/history", req);
  }
}
