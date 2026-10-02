// Marketr — CAD + Hardware slice 4 API.
// POST /api/cad/parts/[id]/adjust — audited stock adjustment (editor).
//        Body: { delta, reason, confirmBelowZero? }. Going below zero fails
//        closed (NEGATIVE_STOCK_CONFIRMATION_REQUIRED) unless the caller
//        passes confirmBelowZero: true explicitly.

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

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadProjectStore(prisma);
    const part = await store.adjustStock(workspace.id, user.email ?? user.id, id, {
      delta: body?.delta,
      reason: body?.reason ?? "",
      confirmBelowZero: body?.confirmBelowZero === true,
    });
    return Response.json({ part });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
