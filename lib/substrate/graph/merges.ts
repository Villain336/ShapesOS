// Marketr — Phase 8 G1: human-gated ER decisions (SPEC-PHASE8.md B4).
//
// Approve → the absorbed node gets mergedIntoId + a SAME_AS provenance edge
// back to its source records (auditable, reversible). Reject → a NOT_SAME
// edge is recorded as a negative signal so future matchers skip the pair.
// Revert → the SAME_AS edge is expired and mergedIntoId cleared; the
// absorbed node's own facts were never touched, so it comes back intact.

import { withWorkspaceScope } from "./rls";
import { auditEvent } from "@/lib/auditlog";

export type ErDecision = "approved" | "rejected";

/**
 * Decide a queue item. Canonical node = the earlier-seen one (stable across
 * repeated merges); ties break by id.
 */
export async function resolveErItem(
  workspaceId: string,
  queueId: string,
  decision: ErDecision,
  decidedBy: string,
): Promise<{ canonicalId: string; absorbedId: string | null }> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const item = await tx.graphErQueue.findFirst({
      where: { workspaceId, id: queueId },
      include: { nodeA: true, nodeB: true },
    });
    if (!item) throw new Error("ER queue item not found");
    if (item.status !== "pending") throw new Error(`already decided (${item.status})`);

    const [first, second] =
      item.nodeA.firstSeen <= item.nodeB.firstSeen
        ? [item.nodeA, item.nodeB]
        : [item.nodeB, item.nodeA];

    if (decision === "approved") {
      await tx.graphNode.update({
        where: { id: second.id },
        data: { mergedIntoId: first.id, lastSeen: new Date() },
      });
      await tx.graphEdge.create({
        data: {
          workspaceId,
          fromNodeId: second.id,
          toNodeId: first.id,
          edgeType: "SAME_AS",
          properties: {
            decidedBy,
            decidedAt: new Date().toISOString(),
            queueId: item.id,
            confidence: item.confidence,
            reversible: true,
          },
          confidence: item.confidence,
          validAt: new Date(),
        },
      });
    } else {
      // Negative signal for future matchers — a deliberate non-merge.
      await tx.graphEdge.create({
        data: {
          workspaceId,
          fromNodeId: item.nodeAId,
          toNodeId: item.nodeBId,
          edgeType: "NOT_SAME",
          properties: { decidedBy, decidedAt: new Date().toISOString(), queueId: item.id },
          confidence: 1,
          validAt: new Date(),
        },
      });
    }

    await tx.graphErQueue.update({
      where: { id: item.id },
      data: { status: decision, decidedBy, decidedAt: new Date() },
    });
    await auditEvent({
      projectId: null,
      workspaceId,
      action: "graph_merge_decided",
      summary: `ER ${decision}: ${item.nodeA.displayName} ↔ ${item.nodeB.displayName} (confidence ${item.confidence.toFixed(2)})`,
      actor: "user",
      actorUserId: decidedBy,
    }).catch(() => {});
    return {
      canonicalId: decision === "approved" ? first.id : item.nodeAId,
      absorbedId: decision === "approved" ? second.id : null,
    };
  });
}

/**
 * Reverse a merge: expire the SAME_AS edge (bi-temporal — history stays)
 * and clear mergedIntoId. The absorbed node's facts were never mutated, so
 * the node returns exactly as it was.
 */
export async function revertMerge(
  workspaceId: string,
  absorbedNodeId: string,
  revertedBy: string,
): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    const node = await tx.graphNode.findFirst({
      where: { workspaceId, id: absorbedNodeId },
    });
    if (!node?.mergedIntoId) throw new Error("node is not merged");
    const now = new Date();
    await tx.graphEdge.updateMany({
      where: {
        workspaceId,
        fromNodeId: absorbedNodeId,
        toNodeId: node.mergedIntoId,
        edgeType: "SAME_AS",
        expiredAt: null,
      },
      data: {
        invalidAt: now,
        expiredAt: now,
        properties: { revertedBy, revertedAt: now.toISOString() },
      },
    });
    await tx.graphNode.update({
      where: { id: absorbedNodeId },
      data: { mergedIntoId: null, lastSeen: now },
    });
    await auditEvent({
      projectId: null,
      workspaceId,
      action: "graph_merge_decided",
      summary: `ER merge reverted: ${node.displayName} un-merged`,
      actor: "user",
      actorUserId: revertedBy,
    }).catch(() => {});
  });
}

/** Pending queue for the UI, with node summaries. */
export async function listErQueue(workspaceId: string, status: "pending" | "approved" | "rejected" = "pending") {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.graphErQueue.findMany({
      where: { workspaceId, status },
      include: {
        nodeA: { select: { id: true, displayName: true, entityType: true, canonicalKey: true, asOf: true, asOfSource: true } },
        nodeB: { select: { id: true, displayName: true, entityType: true, canonicalKey: true, asOf: true, asOfSource: true } },
      },
      orderBy: { confidence: "desc" },
      take: 200,
    }),
  );
}
