// Marketr — newsletter API shared helpers (milestone 19).

import { accessibleWorkspaceWhere, forbidden, getMembership, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createResendPort, type ResendPort } from "@/lib/newsletter/resend";
import { getResendPort } from "@/lib/newsletter/service";

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

/** Workspace-level guard (settings, domains): owner/admin/editor. */
export async function requireWorkspaceEditor(userId: string, workspaceId: string) {
  const m = await getMembership(userId, workspaceId);
  if (!m || !["owner", "admin", "editor"].includes(m.role)) return forbidden();
  return null;
}

/** Live Resend port for the workspace, or a 400 JSON response when no key. */
export async function workspacePort(
  workspaceId: string,
): Promise<{ port: ResendPort } | { response: Response }> {
  const port = await getResendPort(prisma, workspaceId, (key) => createResendPort(key));
  if (!port) {
    return {
      response: Response.json(
        { error: "No Resend API key configured — add one in newsletter settings first." },
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
