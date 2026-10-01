// Marketr — Dataset Builder slice 1: Prisma store.
// Production DatasetBuilderStore backed by the generated Prisma client.
// The NOT NULL foreign keys (migration 20261001150000_dataset_builder_slice1)
// reject orphan writes at the DB level; the checks below mirror the
// in-memory store's error codes so callers see identical behavior.

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  DatasetBuilderError,
  type ChunkInput,
  type DatasetBuilderStore,
  type DatasetChunkRecord,
  type DatasetDocumentInput,
  type DatasetDocumentRecord,
  type DatasetSourceInput,
  type DatasetSourceRecord,
  type DatasetSourceKind,
} from "./types";

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
}
