// ShapesOS — CAD BOM CSV export (Phase 4b).
// GET /api/cad/bom/[id]/export — the BOM as CSV (lines + total). Every cell
//   goes through lib/csv.ts (RFC 4180 + formula-injection neutralization):
//   part names and suppliers are tenant/collaborator text.

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
    const { filename, csv } = await store.exportBomCsv(workspace.id, id);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    return cadRouteError(e, "GET /api/cad/bom/[id]/export", req);
  }
}
