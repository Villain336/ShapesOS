// Marketr — single-connection health (Phase B, track B3).
// GET /api/connections/[id]/health?workspaceId= → { health: HealthPayload }
// Reads: viewer+. The connection is resolved by { id, workspaceId } so one
// workspace can never read another's health row (IDOR guard).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requireWorkspaceAccess, workspaceIdFrom, notFound } from "@/lib/route-utils";
import { serializeHealth } from "@/lib/connectors/health";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;
  const { id } = await params;

  const connection = await prisma.connectorConnection.findFirst({
    where: { id, workspaceId: access.workspaceId },
    include: { health: true },
  });
  if (!connection) return notFound("Connection not found");

  return Response.json({ health: serializeHealth(connection, connection.health) });
}
