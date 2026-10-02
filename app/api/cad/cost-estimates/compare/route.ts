// Marketr — CAD + Hardware slice 3 API.
// POST /api/cad/cost-estimates/compare — delta between two estimates
//        (e.g. version N vs N+1), for per-revision cost comparison.
//        Body: { fromEstimateId, toEstimateId }.

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

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const body = await req.json();
    const store = new PrismaCadPipelineStore(prisma);
    const comparison = await store.compareEstimates(
      workspace.id,
      body?.fromEstimateId ?? "",
      body?.toEstimateId ?? "",
    );
    return Response.json(comparison);
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
