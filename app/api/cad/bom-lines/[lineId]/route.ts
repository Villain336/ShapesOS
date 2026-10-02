// Marketr — CAD + Hardware slice 3 API.
// PATCH  /api/cad/bom-lines/[lineId] — edit a line (editor). Source is
//        immutable: provenance never changes after creation.
// DELETE /api/cad/bom-lines/[lineId] — delete a line (editor).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadPipelineStore } from "@/lib/cad/pipeline-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["BOM_LINE_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ lineId: string }> },
) {
  try {
    const { lineId } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadPipelineStore(prisma);
    const line = await store.updateBomLine(workspace.id, lineId, {
      partName: body?.partName,
      qty: body?.qty,
      unitName: body?.unitName,
      materialSpec: body?.materialSpec,
      supplier: body?.supplier,
      unitCostUsd: body?.unitCostUsd,
      source: body?.source,
    });
    return Response.json({ line });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ lineId: string }> },
) {
  try {
    const { lineId } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const store = new PrismaCadPipelineStore(prisma);
    await store.deleteBomLine(workspace.id, lineId);
    return Response.json({ deleted: true });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
