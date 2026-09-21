// Marketr — DELETE /api/projects/[id], PATCH /api/projects/[id]

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/** PATCH /api/projects/[id] — update project settings (editor+). */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
  });
  if (!project) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // Milestone 15: project settings are editor+.
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();

  const body = await req.json().catch(() => ({}));
  const data: { backlinksEnabled?: boolean } = {};
  if (typeof body.backlinksEnabled === "boolean") {
    data.backlinksEnabled = body.backlinksEnabled;
  }
  if (Object.keys(data).length === 0) {
    return Response.json({ error: "No updatable fields" }, { status: 400 });
  }

  const updated = await prisma.project.update({ where: { id }, data });
  return Response.json({ ok: true, backlinksEnabled: updated.backlinksEnabled });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
  });
  if (!project) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // Milestone 11: project deletion is admin+.
  if (!(await requireProjectRole(user.id, project.id, "admin"))) return forbidden();

  await prisma.project.delete({ where: { id } });
  return Response.json({ ok: true });
}
