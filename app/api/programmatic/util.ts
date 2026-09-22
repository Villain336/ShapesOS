// Marketr — shared helpers for the programmatic SEO API (milestone 17).

import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

export async function ownedProject(userId: string, projectId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  return prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true, workspaceId: true, domain: true },
  });
}

export type OwnedProject = NonNullable<Awaited<ReturnType<typeof ownedProject>>>;

export async function requireRole(userId: string, projectId: string, role: "viewer" | "editor") {
  return requireProjectRole(userId, projectId, role);
}
