// Marketr — Phase 8 G1: graph nodes API (docs/specs/SPEC-PHASE8.md §5).
// GET /api/substrate/graph/nodes?type=&q=&workspaceId=

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess, badRequest } from "@/lib/route-utils";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { freshnessLabel } from "@/lib/substrate/graph/freshness";
import { ENTITY_TYPES } from "@/lib/substrate/graph/types";
import { intQuery, parseQuery, z } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;

  const type = req.nextUrl.searchParams.get("type");
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const limitQuery = parseQuery(z.object({ limit: intQuery(100, 1, 500) }), req.nextUrl.searchParams);
  if (!limitQuery.ok) return limitQuery.error;
  const limit = limitQuery.data.limit;
  if (type && !(ENTITY_TYPES as string[]).includes(type)) {
    return badRequest(`unknown entity type: ${type}`);
  }

  const nodes = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.graphNode.findMany({
      where: {
        workspaceId: access.workspaceId,
        ...(type ? { entityType: type as (typeof ENTITY_TYPES)[number] } : {}),
        ...(q
          ? {
              OR: [
                { displayName: { contains: q, mode: "insensitive" } },
                { canonicalKey: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { lastSeen: "desc" },
      take: limit,
      select: {
        id: true,
        entityType: true,
        canonicalKey: true,
        displayName: true,
        core: true,
        firstSeen: true,
        lastSeen: true,
        asOf: true,
        asOfSource: true,
        mergedIntoId: true,
      },
    }),
  );

  return Response.json({
    nodes: nodes.map((n) => ({
      ...n,
      firstSeen: n.firstSeen.toISOString(),
      lastSeen: n.lastSeen.toISOString(),
      freshness: freshnessLabel(n.asOf, n.asOfSource).label,
      freshnessBucket: freshnessLabel(n.asOf, n.asOfSource).bucket,
    })),
  });
}
