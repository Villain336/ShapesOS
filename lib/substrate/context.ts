// Marketr — substrate.context(): the Phase 9 orchestrator interface (Phase 8 G3).
//
// "Give me everything relevant to <query> in one bounded call": a ranked
// graph slice (nodes + connecting edges, each with G1's honesty freshness
// label), recalled memories with provenance + freshness, and the budgets
// that bounded them. Documented as the Phase 9 GrowthOS orchestrator's
// context contract — agents call this instead of N ad-hoc queries.

import { withWorkspaceScope as withGraphScope } from "./graph/rls";
import { freshnessLabel } from "./graph/freshness";
import type { Freshness } from "./graph/types";
import { memoryRecall } from "./memory/recall";
import type { RecallHit } from "./memory/types";

export interface ContextGraphNode {
  id: string;
  entityType: string;
  displayName: string;
  score: number;
  freshness: Freshness;
}

export interface ContextGraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
  confidence: number;
  freshness: Freshness;
}

export interface ContextMemory extends RecallHit {
  freshness: Freshness;
}

export interface SubstrateContextOptions {
  query: string;
  /** memories to return (default 10) */
  topK?: number;
  /** max graph nodes in the slice (default 25) */
  graphLimit?: number;
  /** temporal query time (default now) */
  asOf?: Date;
  /** hybrid fusion α (default tuned) */
  alpha?: number;
  skipRerank?: boolean;
}

export interface SubstrateContext {
  query: string;
  asOf: string;
  generatedAt: string;
  budgets: { memories: number; graphNodes: number };
  graph: { nodes: ContextGraphNode[]; edges: ContextGraphEdge[] };
  memories: ContextMemory[];
}

/**
 * Ranked graph slice: trigram similarity of the query against
 * display_name/canonical_key, blended with recency of as_of; merged-away
 * duplicates excluded; bounded to `limit` nodes.
 */
async function graphSlice(
  workspaceId: string,
  query: string,
  limit: number,
  now: Date,
): Promise<{ nodes: ContextGraphNode[]; edges: ContextGraphEdge[] }> {
  return withGraphScope(workspaceId, async (tx) => {
    const rows = (await tx.$queryRawUnsafe(
      `SELECT "id", "entity_type"::text AS entity_type, "display_name",
              "as_of", "as_of_source",
              (0.7 * similarity("display_name", $2) + 0.3 * similarity("canonical_key", $2))
                * (0.5 + 0.5 * exp(-EXTRACT(EPOCH FROM ($3::timestamptz - "as_of")) / 86400 / 90)) AS score
         FROM "graph_nodes"
        WHERE "workspace_id" = $1
          AND "merged_into_id" IS NULL
          AND (similarity("display_name", $2) > 0.08 OR similarity("canonical_key", $2) > 0.08)
        ORDER BY score DESC
        LIMIT $4`,
      workspaceId,
      query.slice(0, 300),
      now.toISOString(),
      limit,
    )) as Array<{
      id: string;
      entity_type: string;
      display_name: string;
      as_of: Date;
      as_of_source: string;
      score: number;
    }>;
    const nodes: ContextGraphNode[] = rows.map((r) => ({
      id: r.id,
      entityType: r.entity_type,
      displayName: r.display_name,
      score: Number(r.score),
      freshness: freshnessLabel(new Date(r.as_of), r.as_of_source, now),
    }));
    let edges: ContextGraphEdge[] = [];
    if (nodes.length > 0) {
      const ids = nodes.map((n) => n.id);
      const erows = (await tx.$queryRawUnsafe(
        `SELECT "id", "from_node_id", "to_node_id", "edge_type", "confidence", "valid_at"
           FROM "graph_edges"
          WHERE "workspace_id" = $1
            AND "from_node_id" = ANY($2::text[]) AND "to_node_id" = ANY($2::text[])
            AND "invalid_at" IS NULL
          LIMIT 200`,
        workspaceId,
        ids,
      )) as Array<{
        id: string;
        from_node_id: string;
        to_node_id: string;
        edge_type: string;
        confidence: number;
        valid_at: Date;
      }>;
      edges = erows.map((e) => ({
        id: e.id,
        fromNodeId: e.from_node_id,
        toNodeId: e.to_node_id,
        edgeType: e.edge_type,
        confidence: Number(e.confidence),
        freshness: freshnessLabel(new Date(e.valid_at), "graph edge", now),
      }));
    }
    return { nodes, edges };
  });
}

/**
 * substrate.context(workspaceId, { query, ... }): one bounded call returning
 * the ranked graph slice + recalled memories with provenance and freshness
 * labels. The Phase 9 orchestrator's context contract.
 */
export async function substrateContext(
  workspaceId: string,
  opts: SubstrateContextOptions,
): Promise<SubstrateContext> {
  const query = opts.query.trim();
  if (!query) throw new Error("substrate.context: query is required");
  const now = new Date();
  const asOf = opts.asOf ?? now;
  const topK = Math.min(Math.max(opts.topK ?? 10, 1), 50);
  const graphLimit = Math.min(Math.max(opts.graphLimit ?? 25, 1), 100);

  const [graph, memories] = await Promise.all([
    graphSlice(workspaceId, query, graphLimit, now),
    memoryRecall(workspaceId, {
      query,
      topK,
      asOf,
      alpha: opts.alpha,
      skipRerank: opts.skipRerank,
    }),
  ]);

  return {
    query,
    asOf: asOf.toISOString(),
    generatedAt: now.toISOString(),
    budgets: { memories: topK, graphNodes: graphLimit },
    graph,
    memories: memories.map((m) => ({
      ...m,
      freshness: freshnessLabel(m.observedAt, `memory:${m.store}`, now),
    })),
  };
}
