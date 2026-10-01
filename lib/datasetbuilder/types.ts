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

import type {
  ClassificationInput,
  ClassificationRecord,
  DatasetType,
  ReviewDecision,
  ReviewItemInput,
  ReviewItemRecord,
  ReviewItemStatus,
} from "./classify";

export type {
  ClassificationInput,
  ClassificationRecord,
  DatasetType,
  ReviewDecision,
  ReviewItemInput,
  ReviewItemRecord,
  ReviewItemStatus,
};

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

  // ---- Slice 2: structure -------------------------------------------
  /**
   * Upsert by (chunkId, engine): re-running an engine replaces its own
   * classification, never duplicates it. chunkId must reference a live
   * chunk (UNKNOWN_CHUNK otherwise) — classifications of orphaned chunks
   * are as invalid as orphaned chunks themselves.
   */
  upsertClassification(
    input: ClassificationInput,
  ): Promise<ClassificationRecord>;
  getClassificationByChunk(
    chunkId: string,
  ): Promise<ClassificationRecord | null>;
  getClassificationById(id: string): Promise<ClassificationRecord | null>;
  getChunkById(id: string): Promise<DatasetChunkRecord | null>;
  listClassificationsByType(
    workspaceId: string,
    type: DatasetType,
  ): Promise<ClassificationRecord[]>;
  listPendingClassifications(
    workspaceId: string,
  ): Promise<ClassificationRecord[]>;
  updateClassification(
    id: string,
    patch: Partial<
      Pick<ClassificationRecord, "datasetType" | "confidence" | "status">
    >,
  ): Promise<ClassificationRecord>;

  /**
   * Exactly one review item per classification — REVIEW_ALREADY_EXISTS on
   * duplicates, so the review queue can never lose or double-count an item.
   */
  createReviewItem(input: ReviewItemInput): Promise<ReviewItemRecord>;
  getReviewItem(id: string): Promise<ReviewItemRecord | null>;
  getReviewItemByClassification(
    classificationId: string,
  ): Promise<ReviewItemRecord | null>;
  listReviewItems(
    workspaceId: string,
    status?: ReviewItemStatus,
  ): Promise<ReviewItemRecord[]>;
  /**
   * Applies a human decision (approve / reassign / reject). Throws
   * REVIEW_ALREADY_DECIDED when the item is not pending — decisions are
   * final and auditable.
   */
  decideReviewItem(
    id: string,
    decision: ReviewDecision,
  ): Promise<{ review: ReviewItemRecord; classification: ClassificationRecord }>;

  // ---- Slice 3: build ---------------------------------------------
  /**
   * One dataset per (workspaceId, type). Creates it on first use —
   * compiling a type's first version also creates "the pricing dataset".
   */
  getOrCreateDataset(
    workspaceId: string,
    type: DatasetType,
  ): Promise<DatasetRecord>;
  getDataset(id: string): Promise<DatasetRecord | null>;
  getDatasetByType(
    workspaceId: string,
    type: DatasetType,
  ): Promise<DatasetRecord | null>;
  listDatasets(workspaceId: string): Promise<DatasetRecord[]>;

  /**
   * Records an immutable version snapshot. Throws UNKNOWN_DATASET when
   * the dataset does not exist, DATASET_VERSION_EXISTS when the version
   * number is already taken for that dataset.
   */
  createDatasetVersion(
    input: DatasetVersionInput,
  ): Promise<DatasetVersionRecord>;
  getDatasetVersion(id: string): Promise<DatasetVersionRecord | null>;
  getLatestDatasetVersion(
    datasetId: string,
  ): Promise<DatasetVersionRecord | null>;
  listDatasetVersions(datasetId: string): Promise<DatasetVersionRecord[]>;

  /**
   * Writes per-chunk lineage rows for a version. Throws
   * UNKNOWN_DATASET_VERSION / UNKNOWN_CHUNK / UNKNOWN_CLASSIFICATION
   * when any pointer is dangling — a version snapshot can never carry
   * orphaned lineage. Retries are safe: an identical (versionId, chunkId)
   * row is skipped, never duplicated.
   */
  addDatasetVersionChunks(
    rows: DatasetVersionChunkInput[],
  ): Promise<DatasetVersionChunkRecord[]>;
  listDatasetVersionChunks(
    versionId: string,
  ): Promise<DatasetVersionChunkRecord[]>;
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
  | "VALIDATION_FAILED"
  | "UNKNOWN_CHUNK"
  | "UNKNOWN_CLASSIFICATION"
  | "UNKNOWN_REVIEW_ITEM"
  | "REVIEW_ALREADY_EXISTS"
  | "REVIEW_ALREADY_DECIDED"
  | "UNKNOWN_DATASET"
  | "UNKNOWN_DATASET_VERSION"
  | "DATASET_VERSION_EXISTS"
  | "COMPILE_EMPTY"
  | "LINEAGE_BROKEN";

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

// ---- Slice 3: build ---------------------------------------------------

/**
 * Compile-time transform lineage. Stored on every DatasetVersion so a
 * snapshot answers "which transform, when" without re-running anything.
 */
export interface CompileSettings {
  compiler: string;
  compilerVersion: string;
  datasetType: DatasetType;
}

/** One dataset per (workspace, type) — "the pricing dataset". */
export interface DatasetRecord {
  id: string;
  workspaceId: string;
  type: DatasetType;
  name: string;
  createdAt: Date;
}

/** An immutable versioned snapshot of a dataset's applied chunk set. */
export interface DatasetVersionRecord {
  id: string;
  workspaceId: string;
  datasetId: string;
  /** Monotonic per dataset: v1, v2, … */
  version: number;
  chunkCount: number;
  settings: CompileSettings;
  compiledAt: Date;
}

export interface DatasetVersionInput {
  workspaceId: string;
  datasetId: string;
  version: number;
  chunkCount: number;
  settings: CompileSettings;
}

/**
 * Per-chunk lineage row: version ← chunk ← classification, tracing back
 * to Source/Document through the chunk's own FK chain. The model lineage
 * (engine + engineVersion) is copied at compile time so it survives
 * engine renames.
 */
export interface DatasetVersionChunkInput {
  workspaceId: string;
  versionId: string;
  /** Must reference a live chunk — UNKNOWN_CHUNK otherwise. */
  chunkId: string;
  /** Must reference a live classification — UNKNOWN_CLASSIFICATION otherwise. */
  classificationId: string;
  engine: string;
  engineVersion: string;
}

export interface DatasetVersionChunkRecord
  extends DatasetVersionChunkInput {
  id: string;
  compiledAt: Date;
}
