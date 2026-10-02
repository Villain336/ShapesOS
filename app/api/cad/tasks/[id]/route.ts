// Marketr — CAD + Hardware slice 4 API.
// GET    /api/cad/tasks/[id] — task detail with the activity trail and the
//          pinned revision summary.
// PATCH  /api/cad/tasks/[id] — edit (editor). Status changes append to the
//          trail; moving to done stamps closedAt/closedBy. The pinned version
//          row is never written through this route.
// DELETE /api/cad/tasks/[id] — delete (editor).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadProjectStore } from "@/lib/cad/project-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["TASK_NOT_FOUND"];
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
    return Response.json(await store.getTask(workspace.id, id));
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadProjectStore(prisma);
    const task = await store.updateTask(workspace.id, user.email ?? user.id, id, {
      kind: body?.kind,
      title: body?.title,
      description: body?.description,
      status: body?.status,
      priority: body?.priority,
      assignee: body?.assignee,
      dueDate: body?.dueDate,
    });
    return Response.json({ task });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const store = new PrismaCadProjectStore(prisma);
    await store.deleteTask(workspace.id, id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
