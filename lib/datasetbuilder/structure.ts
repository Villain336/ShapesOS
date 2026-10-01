// Marketr — Dataset Builder slice 2: structure pipeline.
// Classify chunks into dataset types; route low-confidence results to the
// human review queue (draft-for-approval) instead of force-fitting them.
// The trust-ladder rule: the machine suggests, the human decides — a
// rejected classification leaves the chunk unclassified, never mislabeled.

import {
  DATASET_TYPES,
  DEFAULT_CLASSIFICATION_THRESHOLD,
  type ClassificationEngine,
  type ClassificationRecord,
  type DatasetType,
  type ReviewDecision,
  type ReviewItemDetail,
  type TypeBreakdown,
} from "./classify";
import {
  DatasetBuilderError,
  type DatasetBuilderStore,
  type DatasetChunkRecord,
} from "./types";

export interface StructureOptions {
  /** Confidence at or above this auto-applies. Default 0.6. */
  threshold?: number;
}

export interface StructureResult {
  chunkId: string;
  classification: ClassificationRecord;
  /** Present when the classification routed to human review. */
  reviewItemId: string | null;
}

/**
 * Classify one chunk. High confidence → applied immediately.
 * Low confidence → pending_review + exactly one ReviewItem.
 * Idempotent per (chunk, engine): re-running replaces the engine's own
 * classification rather than duplicating it.
 */
export async function structureChunk(
  store: DatasetBuilderStore,
  engine: ClassificationEngine,
  chunk: DatasetChunkRecord,
  opts: StructureOptions = {},
): Promise<StructureResult> {
  const threshold = opts.threshold ?? DEFAULT_CLASSIFICATION_THRESHOLD;
  const { type, confidence } = await engine.classify(chunk.text);
  const status = confidence >= threshold ? "applied" : "pending_review";

  const classification = await store.upsertClassification({
    workspaceId: chunk.workspaceId,
    chunkId: chunk.id,
    datasetType: type,
    confidence,
    engine: engine.name,
    engineVersion: engine.version,
    status,
  });

  let reviewItemId: string | null = null;
  if (status === "pending_review") {
    const existing = await store.getReviewItemByClassification(classification.id);
    if (!existing) {
      const item = await store.createReviewItem({
        workspaceId: chunk.workspaceId,
        classificationId: classification.id,
      });
      reviewItemId = item.id;
    } else {
      reviewItemId = existing.id;
    }
  }
  return { chunkId: chunk.id, classification, reviewItemId };
}

/** Structure every chunk of a document. Returns per-chunk results. */
export async function structureDocument(
  store: DatasetBuilderStore,
  engine: ClassificationEngine,
  documentId: string,
  opts: StructureOptions = {},
): Promise<StructureResult[]> {
  const chunks = await store.listChunksByDocument(documentId);
  const results: StructureResult[] = [];
  for (const chunk of chunks) {
    results.push(await structureChunk(store, engine, chunk, opts));
  }
  return results;
}

/** Structure every unclassified chunk in the workspace. */
export async function structureWorkspace(
  store: DatasetBuilderStore,
  engine: ClassificationEngine,
  workspaceId: string,
  opts: StructureOptions = {},
): Promise<StructureResult[]> {
  const chunks = await store.listAllChunks(workspaceId);
  const results: StructureResult[] = [];
  for (const chunk of chunks) {
    const existing = await store.getClassificationByChunk(chunk.id);
    if (existing) continue;
    results.push(await structureChunk(store, engine, chunk, opts));
  }
  return results;
}

/**
 * Apply a human decision to a pending review. approve → the suggested type
 * applies; reassign → the human's type applies; reject → the classification
 * is discarded and the chunk stays unclassified (never force-fit).
 * Decided items are final: re-deciding throws REVIEW_ALREADY_DECIDED.
 */
export async function decideReview(
  store: DatasetBuilderStore,
  reviewId: string,
  decision: ReviewDecision,
): Promise<{ classification: ClassificationRecord; appliedType: DatasetType | null }> {
  if (decision.action === "reassign" && !decision.datasetType) {
    throw new DatasetBuilderError(
      "VALIDATION_FAILED",
      "reassign requires a datasetType",
    );
  }
  const { classification } = await store.decideReviewItem(reviewId, decision);
  if (decision.action === "reject") {
    return { classification, appliedType: null };
  }
  return { classification, appliedType: classification.datasetType };
}

/** Counts of applied classifications per type + unclassified + pending. */
export async function getTypeBreakdown(
  store: DatasetBuilderStore,
  workspaceId: string,
): Promise<TypeBreakdown> {
  const byType = Object.fromEntries(
    DATASET_TYPES.map((t) => [t, 0]),
  ) as Record<DatasetType, number>;
  for (const t of DATASET_TYPES) {
    const list = await store.listClassificationsByType(workspaceId, t);
    byType[t] = list.filter((c) => c.status === "applied").length;
  }
  const pending = await store.listPendingClassifications(workspaceId);
  const chunks = await store.listAllChunks(workspaceId);
  let unclassified = 0;
  for (const chunk of chunks) {
    const c = await store.getClassificationByChunk(chunk.id);
    if (!c) unclassified += 1;
  }
  return {
    workspaceId,
    byType,
    unclassified,
    pendingReview: pending.length,
  };
}

/** Pending reviews bundled with chunk text + document/source names for the UI. */
export async function listReviewQueue(
  store: DatasetBuilderStore,
  workspaceId: string,
): Promise<ReviewItemDetail[]> {
  const items = await store.listReviewItems(workspaceId, "pending");
  const details: ReviewItemDetail[] = [];
  for (const review of items) {
    // The store interface doesn't expose classification lookup by id, so
    // resolve via the chunk-scoped getter through the review's workspace.
    // (Prisma store joins directly; the in-memory store keeps an index.)
    const classification = await store.getClassificationById(review.classificationId);
    if (!classification) continue;
    const chunk = await store.getChunkById(classification.chunkId);
    const document = chunk ? await store.getDocument(chunk.documentId) : null;
    const source = document ? await store.getSource(document.sourceId) : null;
    details.push({
      review,
      classification,
      chunkText: chunk?.text ?? "",
      documentName: document?.name ?? "Unknown document",
      sourceName: source?.name ?? "Unknown source",
    });
  }
  return details;
}
