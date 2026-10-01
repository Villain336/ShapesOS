// Marketr — Dataset Builder slice 1: in-memory store.
// Used by tests and local tooling. Mirrors the production DB semantics:
//   - createDocument requires a live source (UNKNOWN_SOURCE otherwise)
//   - createChunk requires a live document (ORPHAN_CHUNK_REJECTED otherwise)
// so tests prove the same invariants the FKs enforce in Postgres.

import {
  DatasetBuilderError,
  type ChunkInput,
  type DatasetBuilderStore,
  type DatasetChunkRecord,
  type DatasetDocumentInput,
  type DatasetDocumentRecord,
  type DatasetSourceInput,
  type DatasetSourceRecord,
} from "./types";

let seq = 0;
function newId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Date.now().toString(36)}`;
}

export class InMemoryDatasetBuilderStore implements DatasetBuilderStore {
  private sources = new Map<string, DatasetSourceRecord>();
  private documents = new Map<string, DatasetDocumentRecord>();
  private chunks = new Map<string, DatasetChunkRecord>();

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
}
