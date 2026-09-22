// Marketr — workspace connector health summary (Phase B, track B3).
// GET /api/connections/health?workspaceId= → { connections: [HealthPayload], summary }
// Reads: viewer+. Every connection is scoped to the caller's workspace;
// the ConnectorHealth rows are re-joined through ConnectorConnection so a
// health row can never leak across workspaces.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requireWorkspaceAccess } from "@/lib/route-utils";
import { workspaceIdFrom } from "@/lib/route-utils";
import { serializeHealth } from "@/lib/connectors/health";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;

  const connections = await prisma.connectorConnection.findMany({
    where: { workspaceId: access.workspaceId },
    include: { health: true },
    orderBy: { connectedAt: "desc" },
  });

  const items = connections.map((c) => serializeHealth(c, c.health));
  const summary = {
    total: items.length,
    healthy: items.filter((i) => i.status === "healthy").length,
    needsAttention: items.filter((i) => i.status === "needs_reauth" || i.status === "error").length,
    unknown: items.filter((i) => i.status === "unknown").length,
    degraded: items.filter((i) => i.status === "degraded").length,
  };
  return Response.json({ connections: items, summary });
}
