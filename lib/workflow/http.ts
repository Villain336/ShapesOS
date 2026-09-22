// Marketr — automation canvas API: shared access helpers.
//
// Every workflows route follows the same pattern (mirrors
// /api/autopilot/items/[id]/approve): requireUser → find the project
// inside an accessible workspace → requireProjectRole (editor+ for
// mutations, viewer for reads).

import { accessibleWorkspaceWhere, forbidden, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

export type MinRole = "viewer" | "editor";

export async function requireWorkflowProject(
  userId: string,
  projectId: string,
  minRole: MinRole,
): Promise<
  | { project: { id: string; workspaceId: string } }
  | { error: Response }
> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true, workspaceId: true },
  });
  if (!project) return { error: Response.json({ error: "Project not found" }, { status: 404 }) };
  if (!(await requireProjectRole(userId, project.id, minRole))) return { error: forbidden() };
  return { project };
}

export async function requireWorkflow(
  userId: string,
  workflowId: string,
  minRole: MinRole,
): Promise<
  | { workflow: { id: string; projectId: string }; project: { id: string; workspaceId: string } }
  | { error: Response }
> {
  const workflow = await prisma.workflow.findFirst({
    where: { id: workflowId },
    select: { id: true, projectId: true },
  });
  if (!workflow) return { error: Response.json({ error: "Workflow not found" }, { status: 404 }) };
  const access = await requireWorkflowProject(userId, workflow.projectId, minRole);
  if ("error" in access) return access;
  return { workflow, project: access.project };
}

export function isError<T>(v: T | { error: Response }): v is { error: Response } {
  return typeof v === "object" && v !== null && "error" in v;
}
