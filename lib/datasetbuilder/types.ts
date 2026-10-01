// Marketr — Dataset Builder slice 1: Ingest domain types.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §1 (Launch pillar on-ramp).
// Zero orphaned chunks: every Chunk record carries a non-nullable pointer
// to its Document, and every Document to its Source. The store rejects
// chunk writes that lack a live document pointer (ORPHAN_CHUNK_REJECTED);
// the DB enforces the same with NOT NULL + ON DELETE CASCADE foreign keys.

export type DatasetSourceKind = "upload" | "drive" | "web" | "paste";

export type DatasetDocumentStatus = "pending" | "ready" | "failed";

export interface ChunkingConfig {
  /** Target chunk size in characters. */
  chunkSize: number;
  /** Overlap between consecutive chunks in characters. */
  chunkOverlap: number;
}

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  chunkSize: 1000,
  chunkOverlap: 150,
};

export function validateChunkingConfig(config: ChunkingConfig): void {
  if (!Number.isInteger(config.chunkSize) || config.chunkSize <= 0) {
    throw new DatasetBuilderError(
      "INVALID_CHUNKING_CONFIG",
      "chunkSize must be a positive integer",
    );
  }
  if (
    !Number.isInteger(config.chunkOverlap) ||
    config.chunkOverlap < 0 ||
    config.chunkOverlap >= config.chunkSize
  ) {
    throw new DatasetBuilderError(
      "INVALID_CHUNKING_CONFIG",
      "chunkOverlap must be a non-negative integer smaller than chunkSize",
    );
  }
}

export interface DatasetSourceInput {
  workspaceId: string;
  kind: DatasetSourceKind;
  name: string;
  /** Origin identifier: drive file id, crawled URL, uploaded filename. */
  externalRef?: string;
  config?: Record<string, unknown>;
}

export interface DatasetDocumentInput {
  workspaceId: string;
  /** Must reference a live source. */
  sourceId: string;
  name: string;
  mimeType?: string;
  byteSize?: number;
}

export interface ChunkInput {
  workspaceId: string;
  /** Must reference a live document — never null, never dangling. */
  documentId: string;
  position: number;
  charStart: number;
  charEnd: number;
  text: string;
}

export interface DatasetSourceRecord extends DatasetSourceInput {
  id: string;
  config: Record<string, unknown>;
  createdAt: Date;
}

export interface DatasetDocumentRecord {
  id: string;
  workspaceId: string;
  sourceId: string;
  name: string;
  mimeType: string | null;
  byteSize: number | null;
  charCount: number;
  status: DatasetDocumentStatus;
  error: string | null;
  createdAt: Date;
}

export interface DatasetChunkRecord {
  id: string;
  workspaceId: string;
  /** Non-nullable document pointer — the zero-orphans invariant. */
  documentId: string;
  position: number;
  charStart: number;
  charEnd: number;
  text: string;
  createdAt: Date;
}

/** Store contract every backend (in-memory for tests, Prisma in prod) implements. */
export interface DatasetBuilderStore {
  createSource(input: DatasetSourceInput): Promise<DatasetSourceRecord>;
  getSource(id: string): Promise<DatasetSourceRecord | null>;
  listSources(workspaceId: string): Promise<DatasetSourceRecord[]>;

  createDocument(input: DatasetDocumentInput): Promise<DatasetDocumentRecord>;
  getDocument(id: string): Promise<DatasetDocumentRecord | null>;
  listDocumentsBySource(sourceId: string): Promise<DatasetDocumentRecord[]>;
  updateDocument(
    id: string,
    patch: Partial<
      Pick<DatasetDocumentRecord, "charCount" | "status" | "error" | "mimeType">
    >,
  ): Promise<DatasetDocumentRecord>;

  /**
   * Throws DatasetBuilderError(ORPHAN_CHUNK_REJECTED) when documentId does
   * not reference a live document — the code-level mirror of the DB FK.
   */
  createChunk(input: ChunkInput): Promise<DatasetChunkRecord>;
  listChunksByDocument(documentId: string): Promise<DatasetChunkRecord[]>;
  listAllChunks(workspaceId: string): Promise<DatasetChunkRecord[]>;
}

export type DatasetBuilderErrorCode =
  | "INVALID_CHUNKING_CONFIG"
  | "ORPHAN_CHUNK_REJECTED"
  | "UNKNOWN_SOURCE"
  | "UNKNOWN_DOCUMENT"
  | "UNSUPPORTED_FILE_TYPE"
  | "EXTRACTION_FAILED"
  | "FETCH_FAILED"
  | "NANGO_NOT_CONFIGURED"
  | "ENGINE_NOT_CONFIGURED"
  | "VALIDATION_FAILED";

export class DatasetBuilderError extends Error {
  readonly code: DatasetBuilderErrorCode;
  constructor(code: DatasetBuilderErrorCode, message: string) {
    super(message);
    this.name = "DatasetBuilderError";
    this.code = code;
  }
}

/** Clean-sourcing discipline: user-supplied text is labeled at ingest time. */
export interface PasteInput {
  workspaceId: string;
  /** Explicit source label the user provides — never invented. */
  label: string;
  text: string;
  chunking?: ChunkingConfig;
}

export interface CrawlInput {
  workspaceId: string;
  url: string;
  /** Optional label shown in the register; defaults to the URL. */
  label?: string;
  chunking?: ChunkingConfig;
}
