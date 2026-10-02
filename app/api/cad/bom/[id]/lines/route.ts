// Marketr — CAD + Hardware slice 3 API.
// POST /api/cad/bom/[id]/lines — add a tenant-entered line item (editor).
//        source defaults to "manual"; any derived:<method> source is rejected
//        (DERIVED_METHOD_UNSUPPORTED) — v1 ships no derived BOM methods.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadPipelineStore } from "@/lib/cad/pipeline-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["BOM_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadPipelineStore(prisma);
    const line = await store.addBomLine(workspace.id, user.email ?? user.id, id, {
      partName: body?.partName ?? "",
      qty: body?.qty,
      unitName: body?.unitName,
      materialSpec: body?.materialSpec,
      supplier: body?.supplier,
      unitCostUsd: body?.unitCostUsd,
      source: body?.source,
    });
    return Response.json({ line }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
