// Marketr — CAD + Hardware slice 1 API.
// GET  /api/cad/projects — the tenant's CAD projects (viewer+).
// POST /api/cad/projects — create a project (editor).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadStore } from "@/lib/cad/prisma-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["PROJECT_NOT_FOUND", "MODEL_NOT_FOUND", "VERSION_NOT_FOUND", "LINK_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadStore(prisma);
    const projects = await store.listProjects(workspace.id);
    return Response.json({ workspaceId: workspace.id, projects });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadStore(prisma);
    const project = await store.createProject(workspace.id, user.email ?? user.id, {
      name: body?.name ?? "",
      description: body?.description ?? null,
    });
    return Response.json({ project }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
