// Marketr — CAD + Hardware slice 4 API.
// PATCH  /api/cad/part-supplier-links/[linkId] — update a quote (editor).
// DELETE /api/cad/part-supplier-links/[linkId] — unlink (editor).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadProjectStore } from "@/lib/cad/project-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["LINK_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ linkId: string }> },
) {
  try {
    const { linkId } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadProjectStore(prisma);
    const link = await store.updatePartSupplierLink(workspace.id, linkId, {
      quotedUnitCost: body?.quotedUnitCost,
      currency: body?.currency,
      quotedDate: body?.quotedDate,
      quoteSource: body?.quoteSource,
      preferred: body?.preferred,
    });
    return Response.json({ link });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ linkId: string }> },
) {
  try {
    const { linkId } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const store = new PrismaCadProjectStore(prisma);
    await store.deletePartSupplierLink(workspace.id, linkId);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
