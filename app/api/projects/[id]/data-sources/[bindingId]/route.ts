// Marketr — unbind a project data source (milestone 21).
// DELETE /api/projects/[id]/data-sources/[bindingId] → { ok }
// (editor+; audited data_source_unbound)

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { notFound, requireProjectAccess } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; bindingId: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id: projectId, bindingId } = await params;
  const access = await requireProjectAccess(user.id, projectId, "editor");
  if ("error" in access) return access.error;

  const binding = await prisma.projectDataSource.findFirst({
    where: { id: bindingId, projectId },
  });
  if (!binding) return notFound("Data source binding not found");
  await prisma.projectDataSource.delete({ where: { id: bindingId } });
  await auditEvent({
    projectId,
    workspaceId: access.project.workspaceId,
    action: "data_source_unbound",
    summary: `Unbound ${binding.connectorKey} from project`,
    actorUserId: user.id,
  });
  return Response.json({ ok: true });
}
