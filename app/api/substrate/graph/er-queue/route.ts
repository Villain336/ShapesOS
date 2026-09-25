// Marketr — Phase 8 G1: ER review queue API.
// GET /api/substrate/graph/er-queue?status=&workspaceId=

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess, badRequest } from "@/lib/route-utils";
import { listErQueue } from "@/lib/substrate/graph/merges";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;

  const status = req.nextUrl.searchParams.get("status") ?? "pending";
  if (!["pending", "approved", "rejected"].includes(status)) {
    return badRequest("status must be pending|approved|rejected");
  }
  const items = await listErQueue(access.workspaceId, status as "pending" | "approved" | "rejected");
  return Response.json({
    items: items.map((i) => ({
      id: i.id,
      confidence: i.confidence,
      status: i.status,
      matcherSignals: i.matcherSignals,
      decidedBy: i.decidedBy,
      decidedAt: i.decidedAt?.toISOString() ?? null,
      createdAt: i.createdAt.toISOString(),
      nodeA: i.nodeA,
      nodeB: i.nodeB,
    })),
  });
}
