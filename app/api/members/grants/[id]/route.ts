// Marketr — remove a permission grant (milestone 21).
// DELETE /api/members/grants/[id]?workspaceId= → { ok }
// (admin+; audited permission_grant_removed)

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, badRequest, notFound, requireWorkspaceAccess } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";

export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;

  const grant = await prisma.permissionGrant.findFirst({
    where: { id, workspaceId: access.workspaceId },
  });
  if (!grant) return notFound("Grant not found");
  await prisma.permissionGrant.delete({ where: { id } });
  await auditEvent({
    projectId: null,
    workspaceId: access.workspaceId,
    action: "permission_grant_removed",
    summary: `Removed ${grant.permission} grant from ${grant.userId ?? `role ${grant.role}`}`,
    actorUserId: user.id,
  });
  return Response.json({ ok: true });
}
