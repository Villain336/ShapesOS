// Marketr — CAD + Hardware slice 3 API.
// GET /api/cad/cost-estimates/[id] — estimate detail (labeled breakdown).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadPipelineStore } from "@/lib/cad/pipeline-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["ESTIMATE_NOT_FOUND"];
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
    const estimate = await store.getCostEstimate(workspace.id, id);
    return Response.json({ estimate });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
