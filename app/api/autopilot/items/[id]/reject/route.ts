// Marketr — autopilot approval gate: reject (milestone 18).
// POST /api/autopilot/items/[id]/reject  { projectId, note? }  (editor+)

import { accessibleWorkspaceWhere, forbidden, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { rejectAutopilotItem } from "@/lib/seo/autopilot-service";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  let body: { projectId?: string; note?: string };
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
    await rejectAutopilotItem(prisma, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      itemId: id,
      actor: user.id,
      note: body.note,
    });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Reject failed" }, { status: 400 });
  }
}
