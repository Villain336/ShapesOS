// Marketr — ad factory API shared helpers (milestone 21).

import { accessibleWorkspaceWhere, forbidden, getMembership, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createHiggsfieldPort, type HiggsfieldPort } from "@/lib/ads/higgsfield";
import { getHiggsfieldPort } from "@/lib/ads/service";

export async function ownedProject(userId: string, projectId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  return prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true, workspaceId: true },
  });
}

export async function requireEditor(userId: string, projectId: string) {
  if (!(await requireProjectRole(userId, projectId, "editor"))) return forbidden();
  return null;
}

/** Workspace-level guard (Higgsfield key settings): owner/admin/editor. */
export async function requireWorkspaceEditor(userId: string, workspaceId: string) {
  const m = await getMembership(userId, workspaceId);
  if (!m || !["owner", "admin", "editor"].includes(m.role)) return forbidden();
  return null;
}

/**
 * Admin-level guard for Higgsfield credential + spend-cap management
 * (day-1 hardening, M2): connection credential CRUD stays admin+ per the
 * lib/authz.ts capability matrix. Editors can still read settings and
 * run generations; only admins may rotate the key or move the cap.
 */
export async function requireWorkspaceAdmin(userId: string, workspaceId: string) {
  const m = await getMembership(userId, workspaceId);
  if (!m || !["owner", "admin"].includes(m.role)) return forbidden();
  return null;
}

/** Live Higgsfield port for the workspace, or a 400 JSON response when no key. */
export async function workspacePort(
  workspaceId: string,
): Promise<{ port: HiggsfieldPort } | { response: Response }> {
  const port = await getHiggsfieldPort(prisma, workspaceId, (key) => createHiggsfieldPort(key));
  if (!port) {
    return {
      response: Response.json(
        { error: "No Higgsfield API key configured — add one in ad settings first." },
        { status: 400 },
      ),
    };
  }
  return { port };
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
