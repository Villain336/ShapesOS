// Marketr — CAD + Hardware slice 3 API.
// GET /api/cad/export-requests/[id] — quote request detail (model, version,
//       status lineage, contact, process parameters).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadPipelineStore } from "@/lib/cad/pipeline-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["EXPORT_REQUEST_NOT_FOUND", "MODEL_NOT_FOUND", "VERSION_NOT_FOUND"];
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
    const store = new PrismaCadPipelineStore(prisma);
    const { request, model, version } = await store.getExportRequest(workspace.id, id);
    return Response.json({ request, model, version });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
