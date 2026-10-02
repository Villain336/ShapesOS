// Marketr — CAD + Hardware slice 4 API.
// GET  /api/cad/projects/[id]/tasks — list project tasks/issues
//        (?status=, ?kind=, ?assignee=).
// POST /api/cad/projects/[id]/tasks — create (editor). Optional
//        modelVersionId pins the task to a specific immutable revision
//        (must belong to this project).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadProjectStore } from "@/lib/cad/project-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["PROJECT_NOT_FOUND", "VERSION_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadProjectStore(prisma);
    const url = new URL(req.url);
    const tasks = await store.listTasks(workspace.id, id, {
      status: url.searchParams.get("status") ?? undefined,
      kind: url.searchParams.get("kind") ?? undefined,
      assignee: url.searchParams.get("assignee") ?? undefined,
    });
    return Response.json({ tasks });
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
    const task = await store.createTask(workspace.id, user.email ?? user.id, id, {
      kind: body?.kind,
      title: body?.title ?? "",
      description: body?.description,
      modelVersionId: body?.modelVersionId,
      status: body?.status,
      priority: body?.priority,
      assignee: body?.assignee,
      dueDate: body?.dueDate,
    });
    return Response.json({ task }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
