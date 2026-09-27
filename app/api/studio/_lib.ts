// Marketr — studio API shared helpers (milestone 22).

import { accessibleWorkspaceWhere, forbidden, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

export async function ownedProject(userId: string, projectId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  return prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true, workspaceId: true },
  });
}

export async function ownedWorkspace(userId: string, workspaceId: unknown) {
  if (typeof workspaceId !== "string" || !workspaceId) return null;
  const ws = await prisma.workspace.findFirst({
    where: { id: workspaceId, ...accessibleWorkspaceWhere(userId) },
    select: { id: true },
  });
  return ws;
}

export async function requireEditor(userId: string, projectId: string) {
  if (!(await requireProjectRole(userId, projectId, "editor"))) return forbidden();
  return null;
}

/** Owner/admin only — for credential CRUD and domain purchases. */
export async function requireOwnerAdmin(userId: string, projectId: string) {
  if (!(await requireProjectRole(userId, projectId, "admin"))) {
    return forbidden("Domain purchases and API keys require an owner or admin role.");
  }
  return null;
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
