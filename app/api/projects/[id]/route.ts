// Marketr — DELETE /api/projects/[id], PATCH /api/projects/[id]

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { validateBody, z } from "@/lib/api/validate";

const BodySchema = z
  .object({
    backlinksEnabled: z.boolean().optional(),
  })
  .refine((b) => b.backlinksEnabled !== undefined, {
    message: "No updatable fields",
  });

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

  const rawBody = await req.json().catch(() => null);
  const v = validateBody(BodySchema, rawBody);
  if (!v.ok) return v.error;
  const data: { backlinksEnabled?: boolean } = {};
  if (v.data.backlinksEnabled !== undefined) {
    data.backlinksEnabled = v.data.backlinksEnabled;
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
