// Marketr — skill uninstall (milestone 21).
// DELETE /api/skills/[id]?workspaceId= → { ok } (admin+ or skills.install grant; audited)

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest, notFound } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { uninstallSkill, SkillServiceError } from "@/lib/skills/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const workspaceId = workspaceIdFrom(req);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requirePermission(user.id, workspaceId, "skills.install"))) {
    return forbidden("skills.install permission required.");
  }

  try {
    const skill = await uninstallSkill(prisma, workspaceId, id, user.id);
    await auditEvent({
      projectId: null,
      workspaceId,
      action: "skill_uninstalled",
      summary: `Uninstalled skill "${skill.name}"`,
      actorUserId: user.id,
    });
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof SkillServiceError) return notFound(err.message);
    throw err;
  }
}
