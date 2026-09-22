// Marketr — content autopilot kill switch (milestone 18).
// GET    /api/autopilot/kill?projectId=            → { workspaceKilled, projectKilled, killed }
// POST   /api/autopilot/kill  { projectId, scope: "project"|"workspace", reason? }
//   project scope: editor+. workspace scope: owner/admin.
// DELETE /api/autopilot/kill?projectId=&scope=     → release (explicit; no silent resume)

import { accessibleWorkspaceWhere, forbidden, requireProjectRole, requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getKillStatus, killAutopilot, unkillAutopilot } from "@/lib/seo/autopilot-service";

async function ownedProject(userId: string, projectId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  return prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true, workspaceId: true },
  });
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const status = await getKillStatus(prisma, { workspaceId: project.workspaceId, projectId: project.id });
  return Response.json(status);
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { projectId?: string; scope?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const workspaceScope = body.scope === "workspace";
  if (workspaceScope) {
    if (!(await requireWorkspaceRole(user.id, project.workspaceId, "admin"))) return forbidden("Owner or admin required for the workspace kill switch.");
  } else if (!(await requireProjectRole(user.id, project.id, "editor"))) {
    return forbidden();
  }

  await killAutopilot(prisma, {
    workspaceId: project.workspaceId,
    projectId: workspaceScope ? null : project.id,
    actor: user.id,
    reason: body.reason,
  });
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const project = await ownedProject(user.id, params.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const workspaceScope = params.get("scope") === "workspace";
  if (workspaceScope) {
    if (!(await requireWorkspaceRole(user.id, project.workspaceId, "admin"))) return forbidden("Owner or admin required.");
  } else if (!(await requireProjectRole(user.id, project.id, "editor"))) {
    return forbidden();
  }

  await unkillAutopilot(prisma, {
    workspaceId: project.workspaceId,
    projectId: workspaceScope ? null : project.id,
    actor: user.id,
  });
  return Response.json({ ok: true });
}
