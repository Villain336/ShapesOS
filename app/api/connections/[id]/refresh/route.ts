// Marketr — manual connection refresh (milestone 21).
// POST /api/connections/[id]/refresh?workspaceId= → { status }
// Connection owner or admin+. Audits connector_reauth only when the
// connection flips to needs_reauth.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getMembership, roleAtLeast, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest, notFound } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { refreshConnection } from "@/lib/vault/refresh";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    return forbidden("Only the connection owner or an admin can refresh this connection.");
  }

  const wasActive = connection.status === "active";
  const status = await refreshConnection(id);
  if (status === "needs_reauth" && wasActive) {
    await auditEvent({
      projectId: null,
      workspaceId,
      action: "connector_reauth",
      summary: `Connection ${connection.connectorKey} needs re-authentication`,
      actorUserId: user.id,
    });
  }
  return Response.json({ status });
}
