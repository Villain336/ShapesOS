// Marketr — content autopilot API: single rule (milestone 18).
// PATCH /api/autopilot/rules/[id]   { projectId, ...partialRuleInput }  (editor+)
// DELETE /api/autopilot/rules/[id]?projectId=                            (editor+)

import { accessibleWorkspaceWhere, forbidden, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { deleteAutopilotRule, updateAutopilotRule } from "@/lib/seo/autopilot-service";

async function ownedProject(userId: string, projectId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  return prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true, workspaceId: true },
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();

  try {
    await updateAutopilotRule(prisma, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      ruleId: id,
      input: body,
    });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to update rule" }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const projectId = new URL(req.url).searchParams.get("projectId");
  const project = await ownedProject(user.id, projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();

  try {
    await deleteAutopilotRule(prisma, { workspaceId: project.workspaceId, projectId: project.id, ruleId: id });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to delete rule" }, { status: 400 });
  }
}
