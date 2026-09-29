// Marketr — autopilot approval gate: edit (Phase 16 slice 3).
// POST /api/autopilot/items/[id]/edit  { projectId, title?, draftMarkdown? }  (editor+)
// Same code path as approve/reject: executes through the gate's
// editAutopilotItem service function (update-then-requeue-pending — the item
// stays pending and must still be approved before it can publish).

import { accessibleWorkspaceWhere, forbidden, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { editAutopilotItem } from "@/lib/seo/autopilot-service";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  let body: { projectId?: string; title?: string; draftMarkdown?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const project = await prisma.project.findFirst({
    where: { id: body.projectId ?? "", workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true },
  });
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();

  try {
    await editAutopilotItem(prisma, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      itemId: id,
      actor: user.id,
      title: body.title,
      draftMarkdown: body.draftMarkdown,
    });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Edit failed" }, { status: 400 });
  }
}
