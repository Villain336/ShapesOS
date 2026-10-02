// Marketr — CAD + Hardware slice 4 API.
// GET /api/cad/projects/[id]/dashboard — the per-project rollup: open
//        task/issue counts, low-stock parts relevant to this project,
//        the latest BOM's known cost per model, the latest revision per
//        model, and recent activity. Every figure comes from real rows.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadProjectStore } from "@/lib/cad/project-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["PROJECT_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadProjectStore(prisma);
    const dashboard = await store.getProjectDashboard(workspace.id, id);
    return Response.json({ dashboard });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
