// Marketr — CAD + Hardware slice 4 API.
// GET  /api/cad/parts/[id]/suppliers — the part's supplier links with quotes.
// POST /api/cad/parts/[id]/suppliers — link a supplier (editor).
//        Body: { supplierId, quotedUnitCost?, currency?, quotedDate?,
//                quoteSource?, preferred? }. A quoted cost requires its
//        source citation. Marking preferred demotes the previous one.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadProjectStore } from "@/lib/cad/project-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["PART_NOT_FOUND", "SUPPLIER_NOT_FOUND"];
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
    const links = await store.listPartSuppliers(workspace.id, id);
    return Response.json({ links });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
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
    const link = await store.linkPartSupplier(
      workspace.id,
      user.email ?? user.id,
      id,
      String(body?.supplierId ?? ""),
      {
        quotedUnitCost: body?.quotedUnitCost,
        currency: body?.currency,
        quotedDate: body?.quotedDate,
        quoteSource: body?.quoteSource,
        preferred: body?.preferred,
      },
    );
    return Response.json({ link }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
