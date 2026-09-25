// Marketr — Phase 8 G1: node detail API.
// GET /api/substrate/graph/nodes/:id?workspaceId=
// → node + edges + freshness + provenance chain back to facts
// (node → edge → fact → source record).

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess, notFound } from "@/lib/route-utils";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { freshnessLabel } from "@/lib/substrate/graph/freshness";
import { listFacts } from "@/lib/substrate/graph/facts";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;
  const { id } = await ctx.params;

  const node = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.graphNode.findFirst({
      where: { workspaceId: access.workspaceId, id },
      include: {
        mergedInto: { select: { id: true, displayName: true, entityType: true } },
        absorbed: { select: { id: true, displayName: true, entityType: true } },
      },
    }),
  );
  if (!node) return notFound("Node not found");

  const edges = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.graphEdge.findMany({
      where: {
        workspaceId: access.workspaceId,
        OR: [{ fromNodeId: id }, { toNodeId: id }],
      },
      include: {
        fromNode: { select: { id: true, displayName: true, entityType: true } },
        toNode: { select: { id: true, displayName: true, entityType: true } },
        sourceFact: {
          select: { id: true, factType: true, source: true, sourceRecordId: true, observedAt: true, contentHash: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  );

  // Provenance chain: every fact that ever touched this node's canonical key.
  const facts = await listFacts(access.workspaceId, { entityRef: node.canonicalKey, limit: 100 });

  const f = freshnessLabel(node.asOf, node.asOfSource);
  return Response.json({
    node: {
      id: node.id,
      entityType: node.entityType,
      canonicalKey: node.canonicalKey,
      displayName: node.displayName,
      core: node.core,
      properties: node.properties,
      firstSeen: node.firstSeen.toISOString(),
      lastSeen: node.lastSeen.toISOString(),
      freshness: f.label,
      freshnessBucket: f.bucket,
      asOf: node.asOf.toISOString(),
      asOfSource: node.asOfSource,
      mergedInto: node.mergedInto,
      absorbed: node.absorbed,
    },
    edges: edges.map((e) => ({
      id: e.id,
      edgeType: e.edgeType,
      direction: e.fromNodeId === id ? "out" : "in",
      other: e.fromNodeId === id ? e.toNode : e.fromNode,
      confidence: e.confidence,
      validAt: e.validAt.toISOString(),
      invalidAt: e.invalidAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
      expiredAt: e.expiredAt?.toISOString() ?? null,
      supersededById: e.supersededById,
      sourceFact: e.sourceFact
        ? {
            ...e.sourceFact,
            observedAt: e.sourceFact.observedAt.toISOString(),
            contentHash: e.sourceFact.contentHash.slice(0, 12),
          }
        : null,
    })),
    provenance: facts.map((fact) => ({
      id: fact.id,
      factType: fact.factType,
      source: fact.source,
      sourceRecordId: fact.sourceRecordId,
      observedAt: fact.observedAt.toISOString(),
      ingestedAt: fact.ingestedAt.toISOString(),
      contentHash: fact.contentHash.slice(0, 12),
    })),
  });
}
