// Marketr — studio API shared helpers (milestone 22).

import { accessibleWorkspaceWhere, forbidden, getMembership, requireProjectRole } from "@/lib/authz";
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

/** Workspace-level editor+ guard (Canva connect/disconnect). */
export async function requireWorkspaceEditor(userId: string, workspaceId: string) {
  const m = await getMembership(userId, workspaceId);
  if (!m || !["owner", "admin", "editor"].includes(m.role)) return forbidden();
  return null;
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Canva Connect app credentials come from the environment (single Marketr integration). */
export function canvaClientConfig(): { clientId: string; clientSecret: string } {
  return {
    clientId: process.env.CANVA_CLIENT_ID ?? "",
    clientSecret: process.env.CANVA_CLIENT_SECRET ?? "",
  };
}

/** Redirect URI for the OAuth callback, derived from the request origin. */
export function canvaRedirectUri(req: Request): string {
  const url = new URL(req.url);
  return `${url.origin}/api/studio/canva/callback`;
}
