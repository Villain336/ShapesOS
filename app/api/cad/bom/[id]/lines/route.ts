// Marketr — CAD + Hardware slice 3 API (slice 4 extended).
// POST /api/cad/bom/[id]/lines — add a tenant-entered line item (editor).
//        source defaults to "manual"; any derived:<method> source is rejected
//        (DERIVED_METHOD_UNSUPPORTED) — v1 ships no derived BOM methods.
//        Optional inventoryPartId links the line to the parts inventory:
//        when no unit cost is given, the preferred supplier's quoted USD
//        cost is used (the quote citation comes back in `quote`).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadProjectStore } from "@/lib/cad/project-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["BOM_NOT_FOUND", "PART_NOT_FOUND"];
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
    const store = new PrismaCadProjectStore(prisma);
    const { line, quote } = await store.addBomLineWithInventoryPart(
      workspace.id,
      user.email ?? user.id,
      id,
      {
        partName: body?.partName ?? "",
        qty: body?.qty,
        unitName: body?.unitName,
        materialSpec: body?.materialSpec,
        supplier: body?.supplier,
        unitCostUsd: body?.unitCostUsd,
        source: body?.source,
        inventoryPartId: body?.inventoryPartId,
      },
    );
    return Response.json({ line, quote }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
