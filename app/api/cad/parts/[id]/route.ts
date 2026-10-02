// Marketr — CAD + Hardware slice 4 API.
// GET    /api/cad/parts/[id] — part detail (supplier links + recent stock events).
// PATCH  /api/cad/parts/[id] — edit metadata (editor). onHandQty is NOT
//          writable here: stock moves only through audited adjustments.
// DELETE /api/cad/parts/[id] — delete (editor). Stock events and supplier
//          links cascade; BOM lines keep the line and lose the link.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadProjectStore } from "@/lib/cad/project-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["PART_NOT_FOUND"];
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
    return Response.json(await store.getPart(workspace.id, id));
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadProjectStore(prisma);
    const part = await store.updatePart(workspace.id, id, {
      name: body?.name,
      sku: body?.sku,
      category: body?.category,
      onHandQty: body?.onHandQty,
      reorderPoint: body?.reorderPoint,
      unitOfMeasure: body?.unitOfMeasure,
      storageLocation: body?.storageLocation,
    });
    return Response.json({ part });
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
    const store = new PrismaCadProjectStore(prisma);
    await store.deletePart(workspace.id, id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
