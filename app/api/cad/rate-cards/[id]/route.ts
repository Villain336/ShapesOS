// Marketr — CAD + Hardware slice 3 API.
// PATCH  /api/cad/rate-cards/[id] — edit a rate card (editor).
// DELETE /api/cad/rate-cards/[id] — delete (editor). Refused while any cost
//        estimate cites the card (RATE_CARD_IN_USE) — estimates keep their
//        rate-card lineage.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadPipelineStore } from "@/lib/cad/pipeline-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["RATE_CARD_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadPipelineStore(prisma);
    const rateCard = await store.updateRateCard(workspace.id, id, {
      name: body?.name,
      process: body?.process,
      currency: body?.currency,
      rates: body?.rates,
      isDefault: body?.isDefault,
      source: body?.source,
    });
    return Response.json({ rateCard });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const store = new PrismaCadPipelineStore(prisma);
    await store.deleteRateCard(workspace.id, id);
    return Response.json({ deleted: true });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
