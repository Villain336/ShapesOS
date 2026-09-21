// Marketr — DELETE /api/projects/[id]

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

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
