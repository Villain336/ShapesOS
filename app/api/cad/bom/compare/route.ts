// ShapesOS — CAD BOM comparison (Phase 4b).
// GET /api/cad/bom/compare?from=<bomId>&to=<bomId> — part-level diff between
//   two BOMs of this workspace (matched on part name + material).

import { guardWorkspace } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { BadRequestError } from "@/lib/api/errors";
import { PrismaCadPipelineStore } from "@/lib/cad/pipeline-store";
import { cadRouteError } from "@/lib/cad/route-errors";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const url = new URL(req.url);
    const from = url.searchParams.get("from")?.trim() ?? "";
    const to = url.searchParams.get("to")?.trim() ?? "";
    if (!from || !to || from.length > 64 || to.length > 64) {
      throw new BadRequestError("Pass two BOM ids: ?from=…&to=…");
    }
    const store = new PrismaCadPipelineStore(prisma);
    return Response.json(await store.compareBomVersions(workspace.id, from, to));
  } catch (e) {
    return cadRouteError(e, "GET /api/cad/bom/compare", req);
  }
}
