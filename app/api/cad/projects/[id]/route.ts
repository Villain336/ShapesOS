// Marketr — CAD + Hardware slice 1 API.
// GET    /api/cad/projects/[id] — project detail (viewer+).
// PATCH  /api/cad/projects/[id] — rename / re-describe (editor).
// DELETE /api/cad/projects/[id] — delete project + all models (editor).

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
    const project = await store.getProject(workspace.id, id);
    const models = await store.listModels(workspace.id, id);
    return Response.json({ project, models });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadStore(prisma);
    const project = await store.updateProject(workspace.id, id, {
      name: body?.name ?? "",
      description: body?.description ?? null,
    });
    return Response.json({ project });
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
    await store.deleteProject(workspace.id, id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
