// Marketr — Dataset Builder slice 1: Prisma store.
// Production DatasetBuilderStore backed by the generated Prisma client.
// The NOT NULL foreign keys (migration 20261001150000_dataset_builder_slice1)
// reject orphan writes at the DB level; the checks below mirror the
// in-memory store's error codes so callers see identical behavior.

import type { Prisma, PrismaClient } from "@prisma/client";
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
  type DatasetSourceKind,
  type DatasetType,
  type ReviewDecision,
  type ReviewItemInput,
  type ReviewItemRecord,
  type ReviewItemStatus,
} from "./types";
import type {
  ClassificationStatus,
  DatasetType as PrismaDatasetType,
  ClassificationStatus as PrismaClassificationStatus,
  ReviewItemStatus as PrismaReviewStatus,
} from "./classify";

function toDatasetType(t: string): DatasetType {
  return t as DatasetType;
}

function toSourceKind(
  kind: "upload" | "drive" | "web" | "paste",
): DatasetSourceKind {
  return kind as DatasetSourceKind;
}

export class PrismaDatasetBuilderStore implements DatasetBuilderStore {
  constructor(private readonly db: PrismaClient) {}

  async createSource(input: DatasetSourceInput): Promise<DatasetSourceRecord> {
    const s = await this.db.datasetSource.create({
      data: {
        workspaceId: input.workspaceId,
        kind: input.kind,
        name: input.name,
        externalRef: input.externalRef,
        config: (input.config ?? {}) as Prisma.InputJsonValue,
      },
    });
    return {
      id: s.id,
      workspaceId: s.workspaceId,
      kind: toSourceKind(s.kind),
      name: s.name,
      externalRef: s.externalRef ?? undefined,
      config: (s.config as Record<string, unknown>) ?? {},
      createdAt: s.createdAt,
    };
  }

  async getSource(id: string): Promise<DatasetSourceRecord | null> {
    const s = await this.db.datasetSource.findUnique({ where: { id } });
    if (!s) return null;
    return {
      id: s.id,
      workspaceId: s.workspaceId,
      kind: toSourceKind(s.kind),
      name: s.name,
      externalRef: s.externalRef ?? undefined,
      config: (s.config as Record<string, unknown>) ?? {},
      createdAt: s.createdAt,
    };
  }

  async listSources(workspaceId: string): Promise<DatasetSourceRecord[]> {
    const rows = await this.db.datasetSource.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((s) => ({
      id: s.id,
      workspaceId: s.workspaceId,
      kind: toSourceKind(s.kind),
      name: s.name,
      externalRef: s.externalRef ?? undefined,
      config: (s.config as Record<string, unknown>) ?? {},
      createdAt: s.createdAt,
    }));
  }

  async createDocument(
    input: DatasetDocumentInput,
  ): Promise<DatasetDocumentRecord> {
    const source = await this.db.datasetSource.findUnique({
      where: { id: input.sourceId },
      select: { id: true },
    });
    if (!source) {
      throw new DatasetBuilderError(
        "UNKNOWN_SOURCE",
        `cannot create document: source "${input.sourceId}" does not exist`,
      );
    }
    const d = await this.db.datasetDocument.create({
      data: {
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        name: input.name,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
      },
    });
    return this.toDoc(d);
  }

  async getDocument(id: string): Promise<DatasetDocumentRecord | null> {
    const d = await this.db.datasetDocument.findUnique({ where: { id } });
    return d ? this.toDoc(d) : null;
  }

  async listDocumentsBySource(
    sourceId: string,
  ): Promise<DatasetDocumentRecord[]> {
    const rows = await this.db.datasetDocument.findMany({
      where: { sourceId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((d) => this.toDoc(d));
  }

  async updateDocument(
    id: string,
    patch: Partial<
      Pick<DatasetDocumentRecord, "charCount" | "status" | "error" | "mimeType">
    >,
  ): Promise<DatasetDocumentRecord> {
    try {
      const d = await this.db.datasetDocument.update({
        where: { id },
        data: {
          charCount: patch.charCount,
          status: patch.status,
          error: patch.error,
          mimeType: patch.mimeType,
        },
      });
      return this.toDoc(d);
    } catch {
      throw new DatasetBuilderError(
        "UNKNOWN_DOCUMENT",
        `cannot update document: "${id}" does not exist`,
      );
    }
  }

  async createChunk(input: ChunkInput): Promise<DatasetChunkRecord> {
    if (!input.documentId) {
      throw new DatasetBuilderError(
        "ORPHAN_CHUNK_REJECTED",
        "refusing chunk: document pointer is missing",
      );
    }
    const document = await this.db.datasetDocument.findUnique({
      where: { id: input.documentId },
      select: { id: true },
    });
    if (!document) {
      throw new DatasetBuilderError(
        "ORPHAN_CHUNK_REJECTED",
        `refusing chunk: document "${input.documentId}" does not exist`,
      );
    }
    const c = await this.db.datasetChunk.create({
      data: {
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        position: input.position,
        charStart: input.charStart,
        charEnd: input.charEnd,
        text: input.text,
      },
    });
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      documentId: c.documentId,
      position: c.position,
      charStart: c.charStart,
      charEnd: c.charEnd,
      text: c.text,
      createdAt: c.createdAt,
    };
  }

  async listChunksByDocument(
    documentId: string,
  ): Promise<DatasetChunkRecord[]> {
    const rows = await this.db.datasetChunk.findMany({
      where: { documentId },
      orderBy: { position: "asc" },
    });
    return rows.map((c) => ({
      id: c.id,
      workspaceId: c.workspaceId,
      documentId: c.documentId,
      position: c.position,
      charStart: c.charStart,
      charEnd: c.charEnd,
      text: c.text,
      createdAt: c.createdAt,
    }));
  }

  async listAllChunks(workspaceId: string): Promise<DatasetChunkRecord[]> {
    const rows = await this.db.datasetChunk.findMany({
      where: { workspaceId },
    });
    return rows.map((c) => ({
      id: c.id,
      workspaceId: c.workspaceId,
      documentId: c.documentId,
      position: c.position,
      charStart: c.charStart,
      charEnd: c.charEnd,
      text: c.text,
      createdAt: c.createdAt,
    }));
  }

  private toDoc(d: {
    id: string;
    workspaceId: string;
    sourceId: string;
    name: string;
    mimeType: string | null;
    byteSize: number | null;
    charCount: number;
    status: "pending" | "ready" | "failed";
    error: string | null;
    createdAt: Date;
  }): DatasetDocumentRecord {
    return {
      id: d.id,
      workspaceId: d.workspaceId,
      sourceId: d.sourceId,
      name: d.name,
      mimeType: d.mimeType,
      byteSize: d.byteSize,
      charCount: d.charCount,
      status: d.status,
      error: d.error,
      createdAt: d.createdAt,
    };
  }

  // ---- Slice 2: structure -------------------------------------------

  private toClassification(c: {
    id: string;
    workspaceId: string;
    chunkId: string;
    datasetType: string;
    confidence: number;
    engine: string;
    engineVersion: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }): ClassificationRecord {
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      chunkId: c.chunkId,
      datasetType: toDatasetType(c.datasetType),
      confidence: c.confidence,
      engine: c.engine,
      engineVersion: c.engineVersion,
      status: c.status as ClassificationRecord["status"],
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  private toReviewItem(r: {
    id: string;
    workspaceId: string;
    classificationId: string;
    status: string;
    note: string | null;
    decidedBy: string | null;
    decidedAt: Date | null;
    createdAt: Date;
  }): ReviewItemRecord {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      classificationId: r.classificationId,
      status: r.status as ReviewItemRecord["status"],
      note: r.note,
      decidedBy: r.decidedBy,
      decidedAt: r.decidedAt,
      createdAt: r.createdAt,
    };
  }

  async getChunkById(id: string): Promise<DatasetChunkRecord | null> {
    const c = await this.db.datasetChunk.findUnique({ where: { id } });
    if (!c) return null;
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      documentId: c.documentId,
      position: c.position,
      charStart: c.charStart,
      charEnd: c.charEnd,
      text: c.text,
      createdAt: c.createdAt,
    };
  }

  async upsertClassification(
    input: ClassificationInput,
  ): Promise<ClassificationRecord> {
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
    try {
      const c = await this.db.datasetClassification.upsert({
        where: {
          chunkId_engine: { chunkId: input.chunkId, engine: input.engine },
        },
        create: {
          workspaceId: input.workspaceId,
          chunkId: input.chunkId,
          datasetType: input.datasetType as PrismaDatasetType,
          confidence: input.confidence,
          engine: input.engine,
          engineVersion: input.engineVersion,
          status:
            (input.status as PrismaClassificationStatus | undefined) ??
            "applied",
        },
        update: {
          datasetType: input.datasetType as PrismaDatasetType,
          confidence: input.confidence,
          engineVersion: input.engineVersion,
          status: input.status as PrismaClassificationStatus | undefined,
        },
      });
      return this.toClassification(c);
    } catch {
      // FK to a missing chunk — mirrors the in-memory UNKNOWN_CHUNK.
      throw new DatasetBuilderError(
        "UNKNOWN_CHUNK",
        `cannot classify: chunk "${input.chunkId}" does not exist`,
      );
    }
  }

  async getClassificationByChunk(
    chunkId: string,
  ): Promise<ClassificationRecord | null> {
    const c = await this.db.datasetClassification.findFirst({
      where: { chunkId },
      orderBy: { createdAt: "desc" },
    });
    return c ? this.toClassification(c) : null;
  }

  async getClassificationById(
    id: string,
  ): Promise<ClassificationRecord | null> {
    const c = await this.db.datasetClassification.findUnique({ where: { id } });
    return c ? this.toClassification(c) : null;
  }

  async listClassificationsByType(
    workspaceId: string,
    type: DatasetType,
  ): Promise<ClassificationRecord[]> {
    const rows = await this.db.datasetClassification.findMany({
      where: { workspaceId, datasetType: type as PrismaDatasetType },
    });
    return rows.map((c) => this.toClassification(c));
  }

  async listPendingClassifications(
    workspaceId: string,
  ): Promise<ClassificationRecord[]> {
    const rows = await this.db.datasetClassification.findMany({
      where: { workspaceId, status: "pending_review" },
    });
    return rows.map((c) => this.toClassification(c));
  }

  async updateClassification(
    id: string,
    patch: Partial<
      Pick<ClassificationRecord, "datasetType" | "confidence" | "status">
    >,
  ): Promise<ClassificationRecord> {
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
    try {
      const c = await this.db.datasetClassification.update({
        where: { id },
        data: {
          datasetType: patch.datasetType as PrismaDatasetType | undefined,
          confidence: patch.confidence,
          status: patch.status as PrismaClassificationStatus | undefined,
        },
      });
      return this.toClassification(c);
    } catch {
      throw new DatasetBuilderError(
        "UNKNOWN_CLASSIFICATION",
        `cannot update classification: "${id}" does not exist`,
      );
    }
  }

  async createReviewItem(
    input: ReviewItemInput,
  ): Promise<ReviewItemRecord> {
    try {
      const r = await this.db.datasetReviewItem.create({
        data: {
          workspaceId: input.workspaceId,
          classificationId: input.classificationId,
          note: input.note,
        },
      });
      return this.toReviewItem(r);
    } catch {
      // Unique on classificationId → REVIEW_ALREADY_EXISTS; FK to a
      // missing classification → UNKNOWN_CLASSIFICATION.
      const existing = await this.db.datasetReviewItem.findUnique({
        where: { classificationId: input.classificationId },
      });
      if (existing) {
        throw new DatasetBuilderError(
          "REVIEW_ALREADY_EXISTS",
          `review item already exists for classification "${input.classificationId}"`,
        );
      }
      throw new DatasetBuilderError(
        "UNKNOWN_CLASSIFICATION",
        `cannot create review item: classification "${input.classificationId}" does not exist`,
      );
    }
  }

  async getReviewItem(id: string): Promise<ReviewItemRecord | null> {
    const r = await this.db.datasetReviewItem.findUnique({ where: { id } });
    return r ? this.toReviewItem(r) : null;
  }

  async getReviewItemByClassification(
    classificationId: string,
  ): Promise<ReviewItemRecord | null> {
    const r = await this.db.datasetReviewItem.findUnique({
      where: { classificationId },
    });
    return r ? this.toReviewItem(r) : null;
  }

  async listReviewItems(
    workspaceId: string,
    status?: ReviewItemStatus,
  ): Promise<ReviewItemRecord[]> {
    const rows = await this.db.datasetReviewItem.findMany({
      where: {
        workspaceId,
        status: status as PrismaReviewStatus | undefined,
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => this.toReviewItem(r));
  }

  async decideReviewItem(
    id: string,
    decision: ReviewDecision,
  ): Promise<{ review: ReviewItemRecord; classification: ClassificationRecord }> {
    const review = await this.db.datasetReviewItem.findUnique({
      where: { id },
    });
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
    const classification = await this.db.datasetClassification.findUnique({
      where: { id: review.classificationId },
    });
    if (!classification) {
      throw new DatasetBuilderError(
        "UNKNOWN_CLASSIFICATION",
        `review "${id}" points at a missing classification`,
      );
    }
    let nextStatus: PrismaClassificationStatus;
    let nextType: PrismaDatasetType = classification.datasetType;
    let reviewStatus: PrismaReviewStatus;
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
      nextType = decision.datasetType as PrismaDatasetType;
      reviewStatus = "approved";
    } else {
      nextStatus = "rejected";
      reviewStatus = "rejected";
    }

    const decidedAt = new Date();
    const [updatedReview, updatedClassification] = await this.db.$transaction([
      this.db.datasetReviewItem.update({
        where: { id },
        data: {
          status: reviewStatus,
          note: decision.note ?? review.note,
          decidedBy: decision.decidedBy ?? null,
          decidedAt,
        },
      }),
      this.db.datasetClassification.update({
        where: { id: review.classificationId },
        data: { status: nextStatus, datasetType: nextType },
      }),
    ]);
    return {
      review: this.toReviewItem(updatedReview),
      classification: this.toClassification(updatedClassification),
    };
  }
}
