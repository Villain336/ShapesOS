// Marketr — social API shared helpers (milestone 20).

import { accessibleWorkspaceWhere, forbidden, getMembership, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createBufferPort, type BufferPort } from "@/lib/social/buffer";
import { getBufferPort } from "@/lib/social/service";

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

/** Workspace-level guard (Buffer token): owner/admin/editor. */
export async function requireWorkspaceEditor(userId: string, workspaceId: string) {
  const m = await getMembership(userId, workspaceId);
  if (!m || !["owner", "admin", "editor"].includes(m.role)) return forbidden();
  return null;
}

/** Live Buffer port for the workspace, or a 400 JSON response when no token. */
export async function workspacePort(
  workspaceId: string,
): Promise<{ port: BufferPort } | { response: Response }> {
  const port = await getBufferPort(prisma, workspaceId, (token) => createBufferPort(token));
  if (!port) {
    return {
      response: Response.json(
        { error: "No Buffer access token configured — connect Buffer in social settings first." },
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
