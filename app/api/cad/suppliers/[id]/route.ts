// Marketr — CAD + Hardware slice 4 API.
// GET    /api/cad/suppliers/[id] — supplier detail with linked parts.
// PATCH  /api/cad/suppliers/[id] — edit (editor).
// DELETE /api/cad/suppliers/[id] — delete (editor). Fails closed with
//          SUPPLIER_HAS_PARTS when parts are still linked — unlink first.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadProjectStore } from "@/lib/cad/project-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["SUPPLIER_NOT_FOUND"];
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
    return Response.json(await store.getSupplier(workspace.id, id));
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
    const supplier = await store.updateSupplier(workspace.id, id, {
      name: body?.name,
      contact: body?.contact,
      leadTime: body?.leadTime,
      notes: body?.notes,
    });
    return Response.json({ supplier });
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
    await store.deleteSupplier(workspace.id, id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
