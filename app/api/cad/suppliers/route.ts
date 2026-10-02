// Marketr — CAD + Hardware slice 4 API.
// GET  /api/cad/suppliers — list tenant suppliers (with linked-part counts).
// POST /api/cad/suppliers — create a supplier (editor).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadProjectStore } from "@/lib/cad/project-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  return Response.json({ error: e.message, code: e.code }, { status: 400 });
}

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadProjectStore(prisma);
    const suppliers = await store.listSuppliers(workspace.id);
    return Response.json({ suppliers });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadProjectStore(prisma);
    const supplier = await store.createSupplier(workspace.id, user.email ?? user.id, {
      name: body?.name ?? "",
      contact: body?.contact,
      leadTime: body?.leadTime,
      notes: body?.notes,
    });
    return Response.json({ supplier }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
