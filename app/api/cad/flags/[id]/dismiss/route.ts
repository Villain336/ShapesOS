// Marketr — CAD + Hardware slice 2 API.
// POST /api/cad/flags/[id]/dismiss — dismiss a manufacturability flag (editor).
//        A reason is required (audit trail). Idempotent.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadAiStore } from "@/lib/cad/ai-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["FLAG_NOT_FOUND"];
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
    const body = await req.json().catch(() => ({}));
    const store = new PrismaCadAiStore(prisma);
    const flag = await store.dismissFlag(
      workspace.id,
      user.email ?? user.id,
      id,
      body?.reason ?? "",
    );
    return Response.json({ flag });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
