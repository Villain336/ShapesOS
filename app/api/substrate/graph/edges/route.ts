// Marketr — Phase 8 G1: edges API (SPEC-PHASE8.md §5).
// GET /api/substrate/graph/edges?node_id=&workspaceId=
// POST /api/substrate/graph/edges — manual relationship assertion, HUMAN ONLY
// (editor+). The substrate never auto-asserts relationships; agents propose.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess, badRequest, notFound } from "@/lib/route-utils";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { assertEdge } from "@/lib/substrate/graph/project";
import { appendFact } from "@/lib/substrate/graph/facts";
import { freshnessLabel } from "@/lib/substrate/graph/freshness";
import { auditEvent } from "@/lib/auditlog";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;

  const nodeId = req.nextUrl.searchParams.get("node_id");
  const edgeType = req.nextUrl.searchParams.get("edge_type");
  const at = req.nextUrl.searchParams.get("at"); // point-in-time query
  const currentOnly = req.nextUrl.searchParams.get("current") !== "false";

  const asOf = at ? new Date(at) : new Date();
  if (Number.isNaN(asOf.getTime())) return badRequest("invalid `at` timestamp");

  const edges = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.graphEdge.findMany({
      where: {
        workspaceId: access.workspaceId,
        ...(nodeId ? { OR: [{ fromNodeId: nodeId }, { toNodeId: nodeId }] } : {}),
        ...(edgeType ? { edgeType } : {}),
        validAt: { lte: asOf },
        AND: [{ OR: [{ invalidAt: null }, { invalidAt: { gt: asOf } }] }],
        ...(currentOnly ? { expiredAt: null } : {}),
      },
      include: {
        fromNode: { select: { id: true, displayName: true, entityType: true } },
        toNode: { select: { id: true, displayName: true, entityType: true } },
        // Edge freshness is derived, never stored: the edge is only as fresh
        // as the fact that asserted it.
        sourceFact: { select: { observedAt: true, source: true } },
      },
      orderBy: { validAt: "desc" },
      take: 500,
    }),
  );

  return Response.json({
    asOf: asOf.toISOString(),
    edges: edges.map((e) => {
      // sourceFactId is optional (onDelete: SetNull) — edges projected
      // without an asserting fact fall back to the edge's own validAt.
      const observedAt = e.sourceFact?.observedAt ?? e.validAt;
      const source = e.sourceFact?.source ?? "unasserted";
      const f = freshnessLabel(observedAt, source, asOf);
      return {
        id: e.id,
        edgeType: e.edgeType,
        from: e.fromNode,
        to: e.toNode,
        confidence: e.confidence,
        validAt: e.validAt.toISOString(),
        invalidAt: e.invalidAt?.toISOString() ?? null,
        properties: e.properties,
        sourceFactId: e.sourceFactId,
        asOf: observedAt.toISOString(),
        asOfSource: source,
        freshness: f,
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    workspaceId?: string;
    fromNodeId?: string;
    toNodeId?: string;
    edgeType?: string;
    properties?: Record<string, unknown>;
    confidence?: number;
    validAt?: string;
  } | null;
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, body), "editor");
  if ("error" in access) return access.error;
  if (!body?.fromNodeId || !body?.toNodeId || !body?.edgeType) {
    return badRequest("fromNodeId, toNodeId, edgeType are required");
  }
  if (body.fromNodeId === body.toNodeId) return badRequest("self-edges are not allowed");

  // Manual assertions are facts too: the human is the source, with provenance.
  // The fact carries no relationships — the edge is asserted once, below.
  const fact = await appendFact({
    workspaceId: access.workspaceId,
    source: "manual",
    sourceRecordId: `manual-edge:${user.id}:${Date.now()}`,
    entityRef: `manual:${body.fromNodeId}`,
    factType: "manual_edge_assertion",
    payload: {
      displayName: `Manual assertion: ${body.edgeType}`,
      core: { fromNodeId: body.fromNodeId, toNodeId: body.toNodeId, edgeType: body.edgeType },
      properties: body.properties ?? {},
    },
    actor: user.id,
    deferProjection: true,
  });

  const result = await withWorkspaceScope(access.workspaceId, async (tx) => {
    const [from, to] = await Promise.all([
      tx.graphNode.findFirst({ where: { workspaceId: access.workspaceId, id: body.fromNodeId } }),
      tx.graphNode.findFirst({ where: { workspaceId: access.workspaceId, id: body.toNodeId } }),
    ]);
    if (!from || !to) throw new Error("node not found");
    return assertEdge(
      tx,
      access.workspaceId,
      from.id,
      to.id,
      body.edgeType!,
      {
        to: "",
        edgeType: body.edgeType!,
        properties: body.properties ?? {},
        confidence: body.confidence ?? 1,
        validAt: body.validAt,
      },
      new Date(),
      fact.id,
    );
  }).catch((e: Error) => ({ error: e.message }));

  if ("error" in result) return notFound(result.error);
  await auditEvent({
    projectId: null,
    workspaceId: access.workspaceId,
    action: "graph_fact_appended",
    summary: `manual edge asserted: ${body.edgeType} (${body.fromNodeId} → ${body.toNodeId})`,
    actor: "user",
    actorUserId: user.id,
  }).catch(() => {});
  return Response.json({ edgeId: result.edgeId, superseded: result.superseded }, { status: 201 });
}
