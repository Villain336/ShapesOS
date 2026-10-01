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
  type DatasetPublishInput,
  type DatasetPublishRecord,
  type DatasetRecord,
  type PublishTarget,
  type DatasetSourceInput,
  type DatasetSourceRecord,
  type DatasetType,
  type DatasetVersionChunkInput,
  type DatasetVersionChunkRecord,
  type DatasetVersionInput,
  type DatasetVersionRecord,
  type ReviewDecision,
  type ReviewItemInput,
  type ReviewItemRecord,
  type ReviewItemStatus,
} from "./types";
import type {
  ClassificationStatus,
} from "./classify";
import { DATASET_TYPE_LABELS } from "./classify";

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
  private datasets = new Map<string, DatasetRecord>();
  private versions = new Map<string, DatasetVersionRecord>();
  private versionChunks = new Map<string, DatasetVersionChunkRecord>();
  private publishRecords = new Map<string, DatasetPublishRecord>();

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

  // ---- Slice 3: build -------------------------------------------------

  async getOrCreateDataset(
    workspaceId: string,
    type: DatasetType,
  ): Promise<DatasetRecord> {
    const existing = [...this.datasets.values()].find(
      (d) => d.workspaceId === workspaceId && d.type === type,
    );
    if (existing) return existing;
    const record: DatasetRecord = {
      id: newId("ds"),
      workspaceId,
      type,
      name: DATASET_TYPE_LABELS[type],
      createdAt: new Date(),
    };
    this.datasets.set(record.id, record);
    return record;
  }

  async getDataset(id: string): Promise<DatasetRecord | null> {
    return this.datasets.get(id) ?? null;
  }

  async getDatasetByType(
    workspaceId: string,
    type: DatasetType,
  ): Promise<DatasetRecord | null> {
    return (
      [...this.datasets.values()].find(
        (d) => d.workspaceId === workspaceId && d.type === type,
      ) ?? null
    );
  }

  async listDatasets(workspaceId: string): Promise<DatasetRecord[]> {
    return [...this.datasets.values()].filter(
      (d) => d.workspaceId === workspaceId,
    );
  }

  async createDatasetVersion(
    input: DatasetVersionInput,
  ): Promise<DatasetVersionRecord> {
    if (!this.datasets.has(input.datasetId)) {
      throw new DatasetBuilderError(
        "UNKNOWN_DATASET",
        `cannot create version: dataset "${input.datasetId}" does not exist`,
      );
    }
    const duplicate = [...this.versions.values()].find(
      (v) => v.datasetId === input.datasetId && v.version === input.version,
    );
    if (duplicate) {
      throw new DatasetBuilderError(
        "DATASET_VERSION_EXISTS",
        `dataset "${input.datasetId}" already has version ${input.version}`,
      );
    }
    if (!Number.isInteger(input.version) || input.version < 1) {
      throw new DatasetBuilderError(
        "VALIDATION_FAILED",
        "version must be a positive integer",
      );
    }
    if (!Number.isInteger(input.chunkCount) || input.chunkCount < 0) {
      throw new DatasetBuilderError(
        "VALIDATION_FAILED",
        "chunkCount must be a non-negative integer",
      );
    }
    const record: DatasetVersionRecord = {
      id: newId("dsv"),
      workspaceId: input.workspaceId,
      datasetId: input.datasetId,
      version: input.version,
      chunkCount: input.chunkCount,
      settings: input.settings,
      compiledAt: new Date(),
    };
    this.versions.set(record.id, record);
    return record;
  }

  async getDatasetVersion(id: string): Promise<DatasetVersionRecord | null> {
    return this.versions.get(id) ?? null;
  }

  async getLatestDatasetVersion(
    datasetId: string,
  ): Promise<DatasetVersionRecord | null> {
    const rows = [...this.versions.values()].filter(
      (v) => v.datasetId === datasetId,
    );
    if (rows.length === 0) return null;
    return rows.reduce((a, b) => (b.version > a.version ? b : a));
  }

  async listDatasetVersions(
    datasetId: string,
  ): Promise<DatasetVersionRecord[]> {
    return [...this.versions.values()]
      .filter((v) => v.datasetId === datasetId)
      .sort((a, b) => b.version - a.version);
  }

  async addDatasetVersionChunks(
    rows: DatasetVersionChunkInput[],
  ): Promise<DatasetVersionChunkRecord[]> {
    const written: DatasetVersionChunkRecord[] = [];
    for (const row of rows) {
      if (!this.versions.has(row.versionId)) {
        throw new DatasetBuilderError(
          "UNKNOWN_DATASET_VERSION",
          `cannot add lineage: version "${row.versionId}" does not exist`,
        );
      }
      if (!this.chunks.has(row.chunkId)) {
        throw new DatasetBuilderError(
          "UNKNOWN_CHUNK",
          `cannot add lineage: chunk "${row.chunkId}" does not exist`,
        );
      }
      if (!this.classifications.has(row.classificationId)) {
        throw new DatasetBuilderError(
          "UNKNOWN_CLASSIFICATION",
          `cannot add lineage: classification "${row.classificationId}" does not exist`,
        );
      }
      // Retry-safe: an identical (versionId, chunkId) row is skipped,
      // never duplicated.
      const existing = [...this.versionChunks.values()].find(
        (r) => r.versionId === row.versionId && r.chunkId === row.chunkId,
      );
      if (existing) {
        written.push(existing);
        continue;
      }
      const record: DatasetVersionChunkRecord = {
        id: newId("dsvchunk"),
        workspaceId: row.workspaceId,
        versionId: row.versionId,
        chunkId: row.chunkId,
        classificationId: row.classificationId,
        engine: row.engine,
        engineVersion: row.engineVersion,
        compiledAt: new Date(),
      };
      this.versionChunks.set(record.id, record);
      written.push(record);
    }
    return written;
  }

  async listDatasetVersionChunks(
    versionId: string,
  ): Promise<DatasetVersionChunkRecord[]> {
    return [...this.versionChunks.values()].filter(
      (r) => r.versionId === versionId,
    );
  }

  // ---- Slice 4: activate ----------------------------------------------

  async createPublishRecord(
    input: DatasetPublishInput,
  ): Promise<DatasetPublishRecord> {
    if (!this.datasets.has(input.datasetId)) {
      throw new DatasetBuilderError(
        "UNKNOWN_DATASET",
        `cannot publish: dataset "${input.datasetId}" does not exist`,
      );
    }
    if (!Number.isInteger(input.version) || input.version < 1) {
      throw new DatasetBuilderError(
        "VALIDATION_FAILED",
        "publish version must be a positive integer",
      );
    }
    // Idempotent: republishing the same version to the same target
    // returns the existing record, never a duplicate.
    const existing = [...this.publishRecords.values()].find(
      (r) =>
        r.datasetId === input.datasetId &&
        r.target === input.target &&
        r.version === input.version,
    );
    if (existing) return existing;
    const record: DatasetPublishRecord = {
      id: newId("dspub"),
      workspaceId: input.workspaceId,
      datasetId: input.datasetId,
      target: input.target,
      version: input.version,
      versionId: input.versionId,
      chunkCount: input.chunkCount,
      artifactRef: input.artifactRef,
      publishedAt: new Date(),
    };
    this.publishRecords.set(record.id, record);
    return record;
  }

  async getLatestPublishRecord(
    datasetId: string,
    target: PublishTarget,
  ): Promise<DatasetPublishRecord | null> {
    const rows = [...this.publishRecords.values()].filter(
      (r) => r.datasetId === datasetId && r.target === target,
    );
    if (rows.length === 0) return null;
    return rows.reduce((a, b) => (b.version > a.version ? b : a));
  }

  async listPublishRecords(
    datasetId: string,
  ): Promise<DatasetPublishRecord[]> {
    return [...this.publishRecords.values()]
      .filter((r) => r.datasetId === datasetId)
      .sort((a, b) => b.version - a.version);
  }
}
