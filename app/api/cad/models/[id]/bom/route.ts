// Marketr — CAD + Hardware slice 3 API.
// GET  /api/cad/models/[id]/bom — list BOM versions for a model (?pin
//        shows which model version each BOM is pinned to).
// POST /api/cad/models/[id]/bom — create a BOM version pinned to one model
//        version (editor; body: modelVersionId, notes?). The pin never moves
//        when newer model versions publish.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadPipelineStore } from "@/lib/cad/pipeline-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["MODEL_NOT_FOUND", "VERSION_NOT_FOUND"];
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
    const store = new PrismaCadPipelineStore(prisma);
    const boms = await store.listBomVersions(workspace.id, id);
    return Response.json({ boms });
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
    const store = new PrismaCadPipelineStore(prisma);
    const bom = await store.createBomVersion(
      workspace.id,
      user.email ?? user.id,
      id,
      body?.modelVersionId ?? "",
      body?.notes,
    );
    return Response.json({ bom }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
