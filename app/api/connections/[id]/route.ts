// Marketr — connection lifecycle (milestone 21).
// DELETE /api/connections/[id]?workspaceId= → { ok }
//   Connection owner or admin+. Deletes the credential + connection.
//   Audited (connector_disconnected).
// POST /api/connections/[id]/refresh?workspaceId= → { status }
//   Manual refresh attempt. Audited (connector_reauth) only when the
//   connection flips to needs_reauth.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getMembership, roleAtLeast, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest, notFound } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { deleteConnection } from "@/lib/vault/apikey";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const workspaceId = workspaceIdFrom(req);
  if (!workspaceId) return badRequest("workspaceId is required");
  const connection = await prisma.connectorConnection.findFirst({
    where: { id, workspaceId },
  });
  if (!connection) return notFound("Connection not found");
  const membership = await getMembership(user.id, workspaceId);
  if (!membership) return forbidden();
  if (connection.userId !== user.id && !roleAtLeast(membership.role, "admin")) {
    return forbidden("Only the connection owner or an admin can manage this connection.");
  }

  try {
    await deleteConnection(id, workspaceId);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "Could not delete connection");
  }
  await auditEvent({
    projectId: null,
    workspaceId,
    action: "connector_disconnected",
    summary: `Disconnected ${connection.connectorKey}`,
    actorUserId: user.id,
  });
  return Response.json({ ok: true });
}
