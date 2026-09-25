// Marketr — Phase 8 G1: graph completeness API.
// GET /api/substrate/graph/completeness?workspaceId=
// The battery's live view: entity-type coverage, freshness distribution,
// ER queue depth, connector/sync health.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess } from "@/lib/route-utils";
import { completeness } from "@/lib/substrate/graph/freshness";
import { ENTITY_TYPES } from "@/lib/substrate/graph/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;

  const c = await completeness(access.workspaceId);
  const covered = new Set(c.entityTypes.map((e) => e.entityType));
  return Response.json({
    entityTypeCoverage: ENTITY_TYPES.map((t) => ({
      entityType: t,
      nodes: c.entityTypes.find((e) => e.entityType === t)?.nodes ?? 0,
      covered: covered.has(t),
    })),
    freshness: c.entityTypes.map((e) => ({
      entityType: e.entityType,
      nodes: e.nodes,
      oldestAsOf: e.oldestAsOf?.toISOString() ?? null,
      newestAsOf: e.newestAsOf?.toISOString() ?? null,
    })),
    openErItems: c.openErItems,
    connectors: c.connectors,
    syncJobs: c.syncJobs,
  });
}
