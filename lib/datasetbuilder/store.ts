// Marketr — Dataset Builder slice 1: in-memory store.
// Used by tests and local tooling. Mirrors the production DB semantics:
//   - createDocument requires a live source (UNKNOWN_SOURCE otherwise)
//   - createChunk requires a live document (ORPHAN_CHUNK_REJECTED otherwise)
// so tests prove the same invariants the FKs enforce in Postgres.

import {
  DatasetBuilderError,
  type ChunkInput,
  type ClassificationInput,
  type ClassificationRecord,
  type DatasetBuilderStore,
  type DatasetChunkRecord,
  type DatasetDocumentInput,
  type DatasetDocumentRecord,
  type DatasetSourceInput,
  type DatasetSourceRecord,
  type DatasetType,
  type ReviewDecision,
  type ReviewItemInput,
  type ReviewItemRecord,
  type ReviewItemStatus,
} from "./types";
import type {
  ClassificationStatus,
} from "./classify";

let seq = 0;
function newId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Date.now().toString(36)}`;
}

export class InMemoryDatasetBuilderStore implements DatasetBuilderStore {
  private sources = new Map<string, DatasetSourceRecord>();
  private documents = new Map<string, DatasetDocumentRecord>();
  private chunks = new Map<string, DatasetChunkRecord>();
  private classifications = new Map<string, ClassificationRecord>();
  private reviewItems = new Map<string, ReviewItemRecord>();

  async createSource(input: DatasetSourceInput): Promise<DatasetSourceRecord> {
    const record: DatasetSourceRecord = {
      id: newId("src"),
      workspaceId: input.workspaceId,
      kind: input.kind,
      name: input.name,
      externalRef: input.externalRef,
      config: input.config ?? {},
      createdAt: new Date(),
    };
    this.sources.set(record.id, record);
    return record;
  }

  async getSource(id: string): Promise<DatasetSourceRecord | null> {
    return this.sources.get(id) ?? null;
  }

  async listSources(workspaceId: string): Promise<DatasetSourceRecord[]> {
    return [...this.sources.values()].filter((s) => s.workspaceId === workspaceId);
  }

  async createDocument(input: DatasetDocumentInput): Promise<DatasetDocumentRecord> {
    if (!this.sources.has(input.sourceId)) {
      throw new DatasetBuilderError(
        "UNKNOWN_SOURCE",
        `cannot create document: source "${input.sourceId}" does not exist`,
      );
    }
    const record: DatasetDocumentRecord = {
      id: newId("doc"),
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      name: input.name,
      mimeType: input.mimeType ?? null,
      byteSize: input.byteSize ?? null,
      charCount: 0,
      status: "pending",
      error: null,
      createdAt: new Date(),
    };
    this.documents.set(record.id, record);
    return record;
  }

  async getDocument(id: string): Promise<DatasetDocumentRecord | null> {
    return this.documents.get(id) ?? null;
  }

  async listDocumentsBySource(sourceId: string): Promise<DatasetDocumentRecord[]> {
    return [...this.documents.values()].filter((d) => d.sourceId === sourceId);
  }

  async updateDocument(
    id: string,
    patch: Partial<
      Pick<DatasetDocumentRecord, "charCount" | "status" | "error" | "mimeType">
    >,
  ): Promise<DatasetDocumentRecord> {
    const doc = this.documents.get(id);
    if (!doc) {
      throw new DatasetBuilderError(
        "UNKNOWN_DOCUMENT",
        `cannot update document: "${id}" does not exist`,
      );
    }
    const updated = { ...doc, ...patch };
    this.documents.set(id, updated);
    return updated;
  }

  async createChunk(input: ChunkInput): Promise<DatasetChunkRecord> {
    // The zero-orphans guard: no live document pointer, no chunk.
    if (!input.documentId || !this.documents.has(input.documentId)) {
      throw new DatasetBuilderError(
        "ORPHAN_CHUNK_REJECTED",
        `refusing chunk: document "${input.documentId || "(missing)"}" does not exist`,
      );
    }
    const record: DatasetChunkRecord = {
      id: newId("chk"),
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      position: input.position,
      charStart: input.charStart,
      charEnd: input.charEnd,
      text: input.text,
      createdAt: new Date(),
    };
    this.chunks.set(record.id, record);
    return record;
  }

  async listChunksByDocument(documentId: string): Promise<DatasetChunkRecord[]> {
    return [...this.chunks.values()]
      .filter((c) => c.documentId === documentId)
      .sort((a, b) => a.position - b.position);
  }

  async listAllChunks(workspaceId: string): Promise<DatasetChunkRecord[]> {
    return [...this.chunks.values()].filter((c) => c.workspaceId === workspaceId);
  }

  async getChunkById(id: string): Promise<DatasetChunkRecord | null> {
    return this.chunks.get(id) ?? null;
  }

  // ---- Slice 2: structure -------------------------------------------

  async upsertClassification(
    input: ClassificationInput,
  ): Promise<ClassificationRecord> {
    if (!this.chunks.has(input.chunkId)) {
      throw new DatasetBuilderError(
        "UNKNOWN_CHUNK",
        `cannot classify: chunk "${input.chunkId}" does not exist`,
      );
    }
    if (
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1
    ) {
      throw new DatasetBuilderError(
        "VALIDATION_FAILED",
        "confidence must be between 0 and 1",
      );
    }
    const existing = [...this.classifications.values()].find(
      (c) => c.chunkId === input.chunkId && c.engine === input.engine,
    );
    if (existing) {
      const updated: ClassificationRecord = {
        ...existing,
        datasetType: input.datasetType,
        confidence: input.confidence,
        engineVersion: input.engineVersion,
        status: input.status ?? existing.status,
      };
      this.classifications.set(existing.id, updated);
      return updated;
    }
    const record: ClassificationRecord = {
      id: newId("cls"),
      workspaceId: input.workspaceId,
      chunkId: input.chunkId,
      datasetType: input.datasetType,
      confidence: input.confidence,
      engine: input.engine,
      engineVersion: input.engineVersion,
      status: input.status ?? "applied",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.classifications.set(record.id, record);
    return record;
  }

  async getClassificationByChunk(
    chunkId: string,
  ): Promise<ClassificationRecord | null> {
    return (
      [...this.classifications.values()].find((c) => c.chunkId === chunkId) ??
      null
    );
  }

  async getClassificationById(
    id: string,
  ): Promise<ClassificationRecord | null> {
    return this.classifications.get(id) ?? null;
  }

  async listClassificationsByType(
    workspaceId: string,
    type: DatasetType,
  ): Promise<ClassificationRecord[]> {
    return [...this.classifications.values()].filter(
      (c) => c.workspaceId === workspaceId && c.datasetType === type,
    );
  }

  async listPendingClassifications(
    workspaceId: string,
  ): Promise<ClassificationRecord[]> {
    return [...this.classifications.values()].filter(
      (c) => c.workspaceId === workspaceId && c.status === "pending_review",
    );
  }

  async updateClassification(
    id: string,
    patch: Partial<
      Pick<ClassificationRecord, "datasetType" | "confidence" | "status">
    >,
  ): Promise<ClassificationRecord> {
    const current = this.classifications.get(id);
    if (!current) {
      throw new DatasetBuilderError(
        "UNKNOWN_CLASSIFICATION",
        `cannot update classification: "${id}" does not exist`,
      );
    }
    if (
      patch.confidence !== undefined &&
      (!Number.isFinite(patch.confidence) ||
        patch.confidence < 0 ||
        patch.confidence > 1)
    ) {
      throw new DatasetBuilderError(
        "VALIDATION_FAILED",
        "confidence must be between 0 and 1",
      );
    }
    const updated: ClassificationRecord = {
      ...current,
      ...patch,
      updatedAt: new Date(),
    };
    this.classifications.set(id, updated);
    return updated;
  }

  async createReviewItem(
    input: ReviewItemInput,
  ): Promise<ReviewItemRecord> {
    const classification = this.classifications.get(input.classificationId);
    if (!classification) {
      throw new DatasetBuilderError(
        "UNKNOWN_CLASSIFICATION",
        `cannot create review item: classification "${input.classificationId}" does not exist`,
      );
    }
    const duplicate = [...this.reviewItems.values()].find(
      (r) => r.classificationId === input.classificationId,
    );
    if (duplicate) {
      throw new DatasetBuilderError(
        "REVIEW_ALREADY_EXISTS",
        `review item already exists for classification "${input.classificationId}"`,
      );
    }
    const record: ReviewItemRecord = {
      id: newId("rev"),
      workspaceId: input.workspaceId,
      classificationId: input.classificationId,
      status: "pending",
      note: input.note ?? null,
      decidedBy: null,
      decidedAt: null,
      createdAt: new Date(),
    };
    this.reviewItems.set(record.id, record);
    return record;
  }

  async getReviewItem(id: string): Promise<ReviewItemRecord | null> {
    return this.reviewItems.get(id) ?? null;
  }

  async getReviewItemByClassification(
    classificationId: string,
  ): Promise<ReviewItemRecord | null> {
    return (
      [...this.reviewItems.values()].find(
        (r) => r.classificationId === classificationId,
      ) ?? null
    );
  }

  async listReviewItems(
    workspaceId: string,
    status?: ReviewItemStatus,
  ): Promise<ReviewItemRecord[]> {
    return [...this.reviewItems.values()]
      .filter(
        (r) =>
          r.workspaceId === workspaceId &&
          (status === undefined || r.status === status),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async decideReviewItem(
    id: string,
    decision: ReviewDecision,
  ): Promise<{ review: ReviewItemRecord; classification: ClassificationRecord }> {
    const review = this.reviewItems.get(id);
    if (!review) {
      throw new DatasetBuilderError(
        "UNKNOWN_REVIEW_ITEM",
        `cannot decide review: "${id}" does not exist`,
      );
    }
    if (review.status !== "pending") {
      throw new DatasetBuilderError(
        "REVIEW_ALREADY_DECIDED",
        `review "${id}" was already decided (${review.status})`,
      );
    }
    const classification = this.classifications.get(review.classificationId);
    if (!classification) {
      throw new DatasetBuilderError(
        "UNKNOWN_CLASSIFICATION",
        `review "${id}" points at a missing classification`,
      );
    }

    let nextStatus: ClassificationStatus;
    let nextType = classification.datasetType;
    let reviewStatus: ReviewItemStatus;
    if (decision.action === "approve") {
      nextStatus = "applied";
      reviewStatus = "approved";
    } else if (decision.action === "reassign") {
      if (!decision.datasetType) {
        throw new DatasetBuilderError(
          "VALIDATION_FAILED",
          "reassign requires a datasetType",
        );
      }
      nextStatus = "applied";
      nextType = decision.datasetType;
      reviewStatus = "approved";
    } else {
      nextStatus = "rejected";
      reviewStatus = "rejected";
    }

    const updatedClassification: ClassificationRecord = {
      ...classification,
      datasetType: nextType,
      status: nextStatus,
      updatedAt: new Date(),
    };
    const updatedReview: ReviewItemRecord = {
      ...review,
      status: reviewStatus,
      note: decision.note ?? review.note,
      decidedBy: decision.decidedBy ?? null,
      decidedAt: new Date(),
    };
    this.classifications.set(classification.id, updatedClassification);
    this.reviewItems.set(id, updatedReview);
    return { review: updatedReview, classification: updatedClassification };
  }
}
