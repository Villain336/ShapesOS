// Marketr — CAD + Hardware slice 4 API.
// GET  /api/cad/parts — list tenant parts (?category=, ?lowStock=1).
// POST /api/cad/parts — create a part (editor). The opening on-hand balance
//        is recorded as an "opening balance" stock event.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadProjectStore } from "@/lib/cad/project-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  return Response.json({ error: e.message, code: e.code }, { status: 400 });
}

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadProjectStore(prisma);
    const url = new URL(req.url);
    const category = url.searchParams.get("category") ?? undefined;
    const lowStockOnly = url.searchParams.get("lowStock") === "1";
    const parts = await store.listParts(workspace.id, { category, lowStockOnly });
    return Response.json({ parts });
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
    const part = await store.createPart(workspace.id, user.email ?? user.id, {
      name: body?.name ?? "",
      sku: body?.sku,
      category: body?.category,
      onHandQty: body?.onHandQty,
      reorderPoint: body?.reorderPoint,
      unitOfMeasure: body?.unitOfMeasure,
      storageLocation: body?.storageLocation,
    });
    return Response.json({ part }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
