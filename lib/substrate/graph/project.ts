// Marketr — Phase 8 G1: fact → node/edge projection (SPEC-PHASE8.md §2 G1).
//
// New facts INVALIDATE old edges (invalid_at/expired_at + superseded_by_id)
// instead of deleting them — Graphiti-style bi-temporal edges. Point-in-time
// queries ("what was true when we ran that campaign?") read valid_at /
// invalid_at (world time); created_at / expired_at (transaction time) is the
// audit trail of when the substrate learned it.

import type { GraphFact, GraphNode } from "@prisma/client";
import { parseEntityRef, type FactPayload, type FactRelationships } from "./types";
import type { TxClient } from "./rls";

const SYSTEM_SOURCES = new Set(["manual", "import", "onboarding"]);

function sourceLabel(source: string): string {
  if (SYSTEM_SOURCES.has(source)) return source;
  return source; // connector id — resolved to a display name at the UI layer
}

/** Shallow-merge JSON: fact payload wins on conflicts, never deletes keys. */
function mergeJson(base: unknown, overlay: unknown): object {
  const b = (base ?? {}) as Record<string, unknown>;
  const o = (overlay ?? {}) as Record<string, unknown>;
  return { ...b, ...o };
}

/**
 * Ensure the node for an entity_ref exists (create or refresh). Returns the
 * node. Runs inside the caller's scoped transaction.
 */
export async function ensureNode(
  tx: TxClient,
  workspaceId: string,
  entityRef: string,
  payload: FactPayload,
  observedAt: Date,
  source: string,
): Promise<GraphNode> {
  const { entityType, canonicalKey } = parseEntityRef(entityRef);
  const core = (payload.core ?? {}) as Record<string, unknown>;
  const properties = (payload.properties ?? {}) as Record<string, unknown>;
  const displayName =
    payload.displayName ??
    (typeof core.name === "string" ? core.name : null) ??
    (typeof core.title === "string" ? core.title : null) ??
    (typeof core.term === "string" ? core.term : null) ??
    canonicalKey;

  const existing = await tx.graphNode.findFirst({
    where: { workspaceId, canonicalKey },
  });
  if (!existing) {
    return tx.graphNode.create({
      data: {
        workspaceId,
        entityType,
        canonicalKey,
        displayName,
        core: core as object,
        properties: properties as object,
        firstSeen: observedAt,
        lastSeen: observedAt,
        asOf: observedAt,
        asOfSource: sourceLabel(source),
      },
    });
  }
  // Absorbed duplicates stay absorbed — facts about them refresh the
  // canonical node instead of resurrecting the duplicate.
  const targetId = existing.mergedIntoId ?? existing.id;
  const target =
    targetId === existing.id
      ? existing
      : await tx.graphNode.findFirst({ where: { workspaceId, id: targetId } });
  if (!target) return existing;
  return tx.graphNode.update({
    where: { id: target.id },
    data: {
      displayName,
      core: mergeJson(target.core, core),
      properties: mergeJson(target.properties, properties),
      lastSeen: observedAt,
      asOf: observedAt,
      asOfSource: sourceLabel(source),
    },
  });
}

/**
 * Invalidate the currently-valid edge(s) for (from, to, type) and assert the
 * new era. Invalidation sets invalid_at/expired_at + superseded_by_id — the
 * old row stays queryable for its era.
 */
export async function assertEdge(
  tx: TxClient,
  workspaceId: string,
  fromNodeId: string,
  toNodeId: string,
  edgeType: string,
  rel: FactRelationships,
  observedAt: Date,
  sourceFactId: string,
): Promise<{ edgeId: string; superseded: number }> {
  const validAt = rel.validAt ? new Date(rel.validAt) : observedAt;
  const created = await tx.graphEdge.create({
    data: {
      workspaceId,
      fromNodeId,
      toNodeId,
      edgeType,
      properties: (rel.properties ?? {}) as object,
      confidence: rel.confidence ?? 1,
      validAt,
      sourceFactId,
    },
  });
  const stale = await tx.graphEdge.findMany({
    where: {
      workspaceId,
      fromNodeId,
      toNodeId,
      edgeType,
      invalidAt: null,
      expiredAt: null,
      id: { not: created.id },
      // an edge that becomes valid later doesn't kill the current era
      validAt: { lte: validAt },
    },
  });
  for (const s of stale) {
    await tx.graphEdge.update({
      where: { id: s.id },
      data: { invalidAt: validAt, expiredAt: new Date(), supersededById: created.id },
    });
  }
  return { edgeId: created.id, superseded: stale.length };
}

/**
 * Project one fact into the resolved graph: upsert the node, then assert
 * each declared relationship (with bi-temporal invalidation).
 */
export async function projectFact(tx: TxClient, fact: GraphFact): Promise<void> {
  const payload = fact.payload as FactPayload;
  const node = await ensureNode(
    tx,
    fact.workspaceId,
    fact.entityRef,
    payload,
    fact.observedAt,
    fact.source,
  );
  for (const rel of payload.relationships ?? []) {
    const target = await ensureNode(
      tx,
      fact.workspaceId,
      rel.to,
      { displayName: rel.to },
      fact.observedAt,
      fact.source,
    );
    await assertEdge(
      tx,
      fact.workspaceId,
      node.id,
      target.id,
      rel.edgeType,
      rel,
      fact.observedAt,
      fact.id,
    );
  }
}

/**
 * Edges valid at a point in time (world time). The bi-temporal payoff:
 * "what was true when we ran that campaign?" — pass the campaign date.
 */
export async function edgesAt(
  tx: TxClient,
  workspaceId: string,
  at: Date,
  opts: { nodeId?: string; edgeType?: string } = {},
) {
  return tx.graphEdge.findMany({
    where: {
      workspaceId,
      ...(opts.edgeType ? { edgeType: opts.edgeType } : {}),
      validAt: { lte: at },
      AND: [
        { OR: [{ invalidAt: null }, { invalidAt: { gt: at } }] },
        ...(opts.nodeId
          ? [{ OR: [{ fromNodeId: opts.nodeId }, { toNodeId: opts.nodeId }] }]
          : []),
      ],
    },
    orderBy: { validAt: "desc" },
  });
}
