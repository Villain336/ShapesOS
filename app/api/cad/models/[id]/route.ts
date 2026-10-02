// Marketr — CAD + Hardware slice 1 API.
// GET    /api/cad/models/[id] — model detail: model + versions (desc) +
//          diffs + share links (viewer+).
// DELETE /api/cad/models/[id] — delete model + versions (editor). Stored
//          file bytes stay in the files trash flow (filesystem convention).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadStore } from "@/lib/cad/prisma-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function cadErrorResponse(e: CadError) {
  const notFound = ["PROJECT_NOT_FOUND", "MODEL_NOT_FOUND", "VERSION_NOT_FOUND", "LINK_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadStore(prisma);
    const detail = await store.getModelDetail(workspace.id, id);
    return Response.json(detail);
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const store = new PrismaCadStore(prisma);
    await store.deleteModel(workspace.id, id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
