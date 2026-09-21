// Marketr — shared helpers for the site/IDE API routes.
// Every route is auth-gated and workspace-access checked (milestone 11:
// membership-based via lib/authz, replacing the ownerUserId-only check).
// Connection records are only ever loaded server-side; secrets never reach
// the client.

import { prisma } from "@/lib/prisma";
import { accessibleWorkspaceWhere } from "@/lib/authz";

export async function ownedProject(userId: string, projectId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  return prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
  });
}

export async function ownedConnection(
  userId: string,
  projectId: unknown,
  connectionId: unknown,
) {
  const project = await ownedProject(userId, projectId);
  if (!project) return null;
  if (typeof connectionId !== "string" || !connectionId) return null;
  return prisma.siteConnection.findFirst({
    where: { id: connectionId, projectId: project.id },
  });
}

export async function readJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
