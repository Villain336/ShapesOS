// Marketr — CAD + Hardware slice 2 API.
// DELETE /api/cad/annotations/[id] — remove an annotation (editor).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadAiStore } from "@/lib/cad/ai-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["ANNOTATION_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const store = new PrismaCadAiStore(prisma);
    const result = await store.deleteAnnotation(workspace.id, id);
    return Response.json(result);
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
