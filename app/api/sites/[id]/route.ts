// Marketr — site connection delete API (milestone 6).
// DELETE /api/sites/[id]?projectId=…

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requireProjectRole, forbidden } from "@/lib/authz";
import { ownedConnection } from "@/lib/sitefiles/api";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const connection = await ownedConnection(
    user.id,
    req.nextUrl.searchParams.get("projectId"),
    id,
  );
  if (!connection) {
    return Response.json({ error: "Connection not found" }, { status: 404 });
  }
  // Milestone 11: deleting stored credentials is admin+.
  if (!(await requireProjectRole(user.id, connection.projectId, "admin")))
    return forbidden();
  await prisma.siteConnection.delete({ where: { id: connection.id } });
  // Milestone 11: credential lifecycle is audit-logged (no secret material).
  await prisma.fileChangeLog.create({
    data: {
      projectId: connection.projectId,
      filePath: "(connection)",
      actor: "user",
      action: "credential_deleted",
      summary: `${user.email ?? user.id} deleted SFTP connection "${connection.label}" (${connection.username}@${connection.host}:${connection.port})`,
      approvedBy: user.id,
    },
  });
  return Response.json({ ok: true });
}
