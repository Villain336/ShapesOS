// Marketr — CAD + Hardware slice 3 API.
// GET  /api/cad/models/[id]/versions/[vid]/cost-estimates — list estimates for a version.
// POST /api/cad/models/[id]/versions/[vid]/cost-estimates — compute + persist a
//        labeled estimate (editor; body: bomVersionId, rateCardId, quantity).
//        The BOM must be pinned to this version. Every number is labeled an
//        estimate with the rate card cited; uncomputable components come back
//        null with warnings — never invented, never a vendor quote.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadPipelineStore } from "@/lib/cad/pipeline-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["VERSION_NOT_FOUND", "BOM_NOT_FOUND", "RATE_CARD_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; vid: string }> },
) {
  try {
    const { vid } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadPipelineStore(prisma);
    const estimates = await store.listCostEstimates(workspace.id, vid);
    return Response.json({ estimates });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; vid: string }> },
) {
  try {
    const { vid } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadPipelineStore(prisma);
    const estimate = await store.createCostEstimate(
      workspace.id,
      user.email ?? user.id,
      vid,
      {
        bomVersionId: body?.bomVersionId ?? "",
        rateCardId: body?.rateCardId ?? "",
        quantity: body?.quantity,
      },
    );
    return Response.json({ estimate }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
