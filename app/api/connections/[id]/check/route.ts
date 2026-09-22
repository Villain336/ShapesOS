// Marketr — manual connector health check (Phase B, track B3).
// POST /api/connections/[id]/check?workspaceId= → { health: HealthPayload }
// Connection owner or admin+ (same gate as the refresh route — running a
// check can trigger a silent token refresh, which is a sensitive action).
// Audited (connector_health_checked). Rate-limited by the global proxy tiers.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getMembership, roleAtLeast, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest, notFound } from "@/lib/route-utils";
import { auditEvent } from "@/lib/auditlog";
import { checkConnection, serializeHealth } from "@/lib/connectors/health";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const workspaceId = workspaceIdFrom(req);
  if (!workspaceId) return badRequest("workspaceId is required");

  const connection = await prisma.connectorConnection.findFirst({
    where: { id, workspaceId },
    include: { health: true },
  });
  if (!connection) return notFound("Connection not found");

  const membership = await getMembership(user.id, workspaceId);
  if (!membership) return forbidden();
  if (connection.userId !== user.id && !roleAtLeast(membership.role, "admin")) {
    return forbidden("Only the connection owner or an admin can run a health check.");
  }

  const result = await checkConnection(id);
  if (!result) return notFound("Connection not found");

  await auditEvent({
    projectId: null,
    workspaceId,
    action: "connector_health_checked",
    summary: `Health check for ${connection.connectorKey}: ${result.status}`,
    actorUserId: user.id,
  });

  return Response.json({
    health: serializeHealth(connection, {
      status: result.status,
      lastCheckAt: result.lastCheckAt,
      lastSuccessAt: result.lastSuccessAt,
      lastError: result.errorCode,
      quotaUsed: result.quotaUsed,
      quotaLimit: result.quotaLimit,
      honestLabel: result.label,
    }),
  });
}
