// Marketr — Phase 8 G1: append-only fact log API.
// GET /api/substrate/graph/facts?entity_ref=&fact_type=&source=&workspaceId=
// The audit trail: facts are immutable — there is no POST/PUT/DELETE here.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess } from "@/lib/route-utils";
import { listFacts } from "@/lib/substrate/graph/facts";
import { intQuery, parseQuery, z } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;

  const limitQuery = parseQuery(z.object({ limit: intQuery(200, 1, 1000) }), req.nextUrl.searchParams);
  if (!limitQuery.ok) return limitQuery.error;
  const facts = await listFacts(access.workspaceId, {
    entityRef: req.nextUrl.searchParams.get("entity_ref") ?? undefined,
    factType: req.nextUrl.searchParams.get("fact_type") ?? undefined,
    source: req.nextUrl.searchParams.get("source") ?? undefined,
    limit: limitQuery.data.limit,
  });

  return Response.json({
    facts: facts.map((f) => ({
      id: f.id,
      source: f.source,
      sourceRecordId: f.sourceRecordId,
      entityRef: f.entityRef,
      factType: f.factType,
      observedAt: f.observedAt.toISOString(),
      ingestedAt: f.ingestedAt.toISOString(),
      contentHash: f.contentHash.slice(0, 16),
      payload: f.payload,
    })),
  });
}
