// Marketr — remove a workspace-custom MCP server (milestone 21).
// DELETE /api/connectors/mcp/[id]?workspaceId= → { ok }
// Removes the connector, its connections, and their credentials.
// Admin+ or connectors.connect grant. Audited (mcp_connector_removed).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requirePermission, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest, notFound } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";

export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const workspaceId = workspaceIdFrom(req);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requirePermission(user.id, workspaceId, "connectors.connect"))) {
    return forbidden("connectors.connect permission required.");
  }

  const connector = await prisma.connector.findFirst({
    where: { id, workspaceId },
  });
  if (!connector) return notFound("Connector not found");
  if (connector.kind !== "mcp") {
    return badRequest("Only custom MCP connectors can be removed here");
  }

  // Explicitly delete connections' credentials first (FK also cascades,
  // but explicit-first avoids orphaned rows on a racing write).
  const conns = await prisma.connectorConnection.findMany({
    where: { connectorId: id },
    select: { id: true },
  });
  const connIds = conns.map((c) => c.id);
  if (connIds.length) {
    await prisma.connectorCredential.deleteMany({ where: { connectionId: { in: connIds } } });
    await prisma.connectorConnection.deleteMany({ where: { id: { in: connIds } } });
  }
  await prisma.connector.delete({ where: { id } });

  await auditEvent({
    projectId: null,
    workspaceId,
    action: "mcp_connector_removed",
    summary: `Removed MCP connector "${connector.displayName}" (${connIds.length} connections)`,
    actorUserId: user.id,
  });
  return Response.json({ ok: true });
}
