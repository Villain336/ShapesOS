// Marketr — newsletter API: delete a list (milestone 19).
// DELETE /api/newsletter/lists/[id]?projectId=

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { deleteList } from "@/lib/newsletter/service";
import { ownedProject, requireEditor, workspacePort } from "../../_lib";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  const portResult = await workspacePort(project.workspaceId);
  const port = "port" in portResult ? portResult.port : null;
  try {
    await deleteList(prisma, id, project.workspaceId, project.id, port);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to delete list" }, { status: 400 });
  }
}
