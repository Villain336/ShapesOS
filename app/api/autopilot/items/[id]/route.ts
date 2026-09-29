// Marketr — autopilot approval gate: fetch one item (Phase 16 slice 3).
// GET /api/autopilot/items/[id]?projectId=  (viewer+)
// The generative ApprovalCard renders from live gate data (ids only are
// emitted by the agent) — never from agent-invented item content.

import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true },
  });
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const item = await prisma.autopilotItem.findFirst({
    where: { id, projectId: project.id },
    select: {
      id: true,
      kind: true,
      title: true,
      draftMarkdown: true,
      status: true,
      reviewNote: true,
      createdAt: true,
      rule: { select: { id: true, name: true } },
    },
  });
  if (!item) return Response.json({ error: "Autopilot item not found" }, { status: 404 });
  return Response.json({ item, projectId: project.id, workspaceId: project.workspaceId });
}
