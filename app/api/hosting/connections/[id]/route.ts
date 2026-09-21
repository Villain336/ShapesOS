// Marketr — delete a hosting connection (milestone 9).
// DELETE /api/hosting/connections/[id]?projectId=…
// Deployments made through it are kept (connectionId set to null via FK).

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireProjectRole, forbidden } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { ownedHostingConnection } from "@/lib/deploy";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const projectId = req.nextUrl.searchParams.get("projectId") ?? "";
  const conn = await ownedHostingConnection(user.id, projectId, id);
  if (!conn) return Response.json({ error: "Connection not found" }, { status: 404 });

  // Milestone 11: deleting stored tokens is admin+.
  if (!(await requireProjectRole(user.id, conn.projectId, "admin"))) return forbidden();
  await prisma.hostingConnection.delete({ where: { id: conn.id } });
  // Milestone 11: credential lifecycle is audit-logged (no secret material).
  await prisma.fileChangeLog.create({
    data: {
      projectId: conn.projectId,
      filePath: "(connection)",
      actor: "user",
      action: "credential_deleted",
      summary: `${user.email ?? user.id} deleted hosting connection "${conn.name}"`,
      approvedBy: user.id,
    },
  });
  return Response.json({ ok: true });
}
