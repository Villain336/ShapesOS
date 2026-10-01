// Marketr — Dataset Builder slice 3: versioned dataset compiler.
// Compiles applied classifications into immutable dataset versions with
// per-chunk lineage: which source → which document → which chunk, which
// model classified it (engine lineage), which transform compiled it
// (compiler settings), and when. Versions export as JSONL and Parquet.
//
// The zero-orphaned-data invariant extends to compiled snapshots: a
// version chunk is only written when its chunk and classification both
// reference live records, and verifyNoOrphanedVersionChunks() audits it.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";
import {
  DATASET_TYPES,
  type ClassificationRecord,
  type DatasetType,
} from "./classify";
import {
  DatasetBuilderError,
  type DatasetBuilderStore,
  type DatasetRecord,
  type DatasetVersionChunkRecord,
  type DatasetVersionRecord,
} from "./types";

export const DATASET_COMPILER_NAME = "dataset-compiler";
export const DATASET_COMPILER_VERSION = "build-v1";

export interface CompileResult {
  dataset: DatasetRecord;
  version: DatasetVersionRecord;
  chunkCount: number;
}

/**
 * Compile one dataset type into a new version. Snapshots every chunk with
 * an applied classification of that type, with per-chunk lineage.
 * Throws COMPILE_EMPTY when nothing is classified yet — compiling an
 * empty dataset is almost always a pipeline mistake, so it fails loudly.
 * Idempotent-safe: one chunk appears at most once per version even when
 * multiple engines classified it (highest confidence wins).
 */
export async function compileDataset(
  store: DatasetBuilderStore,
  workspaceId: string,
  type: DatasetType,
): Promise<CompileResult> {
  const applied = await appliedClassificationsByChunk(store, workspaceId, type);
  if (applied.length === 0) {
    throw new DatasetBuilderError(
      "COMPILE_EMPTY",
      `cannot compile "${type}": no chunks with applied classifications yet`,
    );
  }
  const dataset = await store.getOrCreateDataset(workspaceId, type);
  const latest = await store.getLatestDatasetVersion(dataset.id);
  const version = await store.createDatasetVersion({
    workspaceId,
    datasetId: dataset.id,
    version: (latest?.version ?? 0) + 1,
    chunkCount: applied.length,
    settings: {
      compiler: DATASET_COMPILER_NAME,
      compilerVersion: DATASET_COMPILER_VERSION,
      datasetType: type,
    },
  });
  await store.addDatasetVersionChunks(
    applied.map((c) => ({
      workspaceId,
      versionId: version.id,
      chunkId: c.chunkId,
      classificationId: c.id,
      engine: c.engine,
      engineVersion: c.engineVersion,
    })),
  );
  return { dataset, version, chunkCount: applied.length };
}

/**
 * Compile every dataset type that has classified chunks. Types with no
 * applied classifications are skipped (reported), not failed — a fresh
 * workspace compiles a subset on its first run.
 */
export async function compileDatasets(
  store: DatasetBuilderStore,
  workspaceId: string,
  types: DatasetType[] = DATASET_TYPES,
): Promise<{ compiled: CompileResult[]; skipped: DatasetType[] }> {
  const compiled: CompileResult[] = [];
  const skipped: DatasetType[] = [];
  for (const type of types) {
    const applied = await appliedClassificationsByChunk(store, workspaceId, type);
    if (applied.length === 0) {
      skipped.push(type);
      continue;
    }
    compiled.push(await compileDataset(store, workspaceId, type));
  }
  return { compiled, skipped };
}

/**
 * Applied classifications of one type, deduplicated to one per chunk.
 * When several engines classified the same chunk, the highest-confidence
 * classification wins the snapshot — a dataset never carries the same
 * chunk twice.
 */
async function appliedClassificationsByChunk(
  store: DatasetBuilderStore,
  workspaceId: string,
  type: DatasetType,
): Promise<ClassificationRecord[]> {
  const all = await store.listClassificationsByType(workspaceId, type);
  const byChunk = new Map<string, ClassificationRecord>();
  for (const c of all) {
    if (c.status !== "applied") continue;
    const current = byChunk.get(c.chunkId);
    if (!current || c.confidence > current.confidence) {
      byChunk.set(c.chunkId, c);
    }
  }
  return [...byChunk.values()].sort((a, b) =>
    a.chunkId.localeCompare(b.chunkId),
  );
}

// ------------------------------------------------------------- lineage ---

export interface VersionLineageChunk {
  versionChunkId: string;
  chunkId: string;
  text: string;
  position: number;
  charStart: number;
  charEnd: number;
  documentId: string;
  documentName: string;
  sourceId: string;
  sourceName: string;
  classificationId: string;
  confidence: number;
  /** Which model produced the classification that admitted this chunk. */
  engine: string;
  engineVersion: string;
}

export interface VersionLineageSummary {
  id: string;
  name: string;
  chunkCount: number;
}

export interface VersionLineage {
  dataset: DatasetRecord;
  version: DatasetVersionRecord;
  chunks: VersionLineageChunk[];
  sources: VersionLineageSummary[];
  documents: (VersionLineageSummary & { sourceId: string; sourceName: string })[];
  engines: { name: string; version: string; chunkCount: number }[];
}

/**
 * Full lineage for one version: every chunk resolved back through its
 * document to its source, with the admitting classification and model.
 * Throws UNKNOWN_DATASET_VERSION for a missing version and LINEAGE_BROKEN
 * when any row points at a record that no longer exists — a data-integrity
 * incident, never silently skipped.
 */
export async function getVersionLineage(
  store: DatasetBuilderStore,
  versionId: string,
): Promise<VersionLineage> {
  const version = await store.getDatasetVersion(versionId);
  if (!version) {
    throw new DatasetBuilderError(
      "UNKNOWN_DATASET_VERSION",
      `no dataset version "${versionId}"`,
    );
  }
  const dataset = await store.getDataset(version.datasetId);
  if (!dataset) {
    throw new DatasetBuilderError(
      "LINEAGE_BROKEN",
      `version "${versionId}" points at a missing dataset`,
    );
  }
  const rows = await store.listDatasetVersionChunks(versionId);
  const chunks: VersionLineageChunk[] = [];
  for (const row of rows) {
    chunks.push(await resolveLineageChunk(store, row));
  }
  chunks.sort((a, b) => a.chunkId.localeCompare(b.chunkId));

  const sources = summarize(chunks, (c) => c.sourceId, (c) => c.sourceName);
  const documents = chunks
    .reduce(
      (acc, c) => {
        const key = c.documentId;
        const entry = acc.get(key) ?? {
          id: key,
          name: c.documentName,
          sourceId: c.sourceId,
          sourceName: c.sourceName,
          chunkCount: 0,
        };
        entry.chunkCount += 1;
        acc.set(key, entry);
        return acc;
      },
      new Map<string, VersionLineageSummary & { sourceId: string; sourceName: string }>(),
    );
  const engines = chunks
    .reduce((acc, c) => {
      const key = `${c.engine}@${c.engineVersion}`;
      const entry = acc.get(key) ?? {
        name: c.engine,
        version: c.engineVersion,
        chunkCount: 0,
      };
      entry.chunkCount += 1;
      acc.set(key, entry);
      return acc;
    }, new Map<string, { name: string; version: string; chunkCount: number }>())
    .values();

  return {
    dataset,
    version,
    chunks,
    sources,
    documents: [...documents.values()],
    engines: [...engines],
  };
}

async function resolveLineageChunk(
  store: DatasetBuilderStore,
  row: DatasetVersionChunkRecord,
): Promise<VersionLineageChunk> {
  const chunk = await store.getChunkById(row.chunkId);
  const classification = await store.getClassificationById(
    row.classificationId,
  );
  if (!chunk || !classification) {
    throw new DatasetBuilderError(
      "LINEAGE_BROKEN",
      `version chunk "${row.id}" points at a missing chunk or classification`,
    );
  }
  const document = await store.getDocument(chunk.documentId);
  if (!document) {
    throw new DatasetBuilderError(
      "LINEAGE_BROKEN",
      `chunk "${chunk.id}" points at a missing document`,
    );
  }
  const source = await store.getSource(document.sourceId);
  if (!source) {
    throw new DatasetBuilderError(
      "LINEAGE_BROKEN",
      `document "${document.id}" points at a missing source`,
    );
  }
  return {
    versionChunkId: row.id,
    chunkId: chunk.id,
    text: chunk.text,
    position: chunk.position,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    documentId: document.id,
    documentName: document.name,
    sourceId: source.id,
    sourceName: source.name,
    classificationId: classification.id,
    confidence: classification.confidence,
    engine: row.engine,
    engineVersion: row.engineVersion,
  };
}

function summarize(
  chunks: VersionLineageChunk[],
  keyOf: (c: VersionLineageChunk) => string,
  nameOf: (c: VersionLineageChunk) => string,
): VersionLineageSummary[] {
  const acc = new Map<string, VersionLineageSummary>();
  for (const c of chunks) {
    const key = keyOf(c);
    const entry = acc.get(key) ?? { id: key, name: nameOf(c), chunkCount: 0 };
    entry.chunkCount += 1;
    acc.set(key, entry);
  }
  return [...acc.values()].sort((a, b) => b.chunkCount - a.chunkCount);
}

/**
 * Audit: every version-chunk row in the workspace must resolve to a live
 * version, chunk, and classification. Returns the offending row ids —
 * always [] in a healthy store.
 */
export async function verifyNoOrphanedVersionChunks(
  store: DatasetBuilderStore,
  workspaceId: string,
): Promise<string[]> {
  const broken: string[] = [];
  const datasets = await store.listDatasets(workspaceId);
  for (const dataset of datasets) {
    const versions = await store.listDatasetVersions(dataset.id);
    for (const version of versions) {
      const rows = await store.listDatasetVersionChunks(version.id);
      for (const row of rows) {
        const chunk = await store.getChunkById(row.chunkId);
        const classification = await store.getClassificationById(
          row.classificationId,
        );
        if (!chunk || !classification) broken.push(row.id);
      }
    }
  }
  return broken;
}

// -------------------------------------------------------------- export ---

export interface DatasetExportRow {
  chunkId: string;
  datasetType: DatasetType;
  documentId: string;
  documentName: string;
  sourceId: string;
  sourceName: string;
  position: number;
  charStart: number;
  charEnd: number;
  text: string;
  confidence: number;
  engine: string;
  engineVersion: string;
  compiledVersion: number;
}

/** Export-ready rows for a version: lineage joined into flat records. */
export async function getVersionExportRows(
  store: DatasetBuilderStore,
  versionId: string,
): Promise<DatasetExportRow[]> {
  const lineage = await getVersionLineage(store, versionId);
  return lineage.chunks.map((c) => ({
    chunkId: c.chunkId,
    datasetType: lineage.dataset.type,
    documentId: c.documentId,
    documentName: c.documentName,
    sourceId: c.sourceId,
    sourceName: c.sourceName,
    position: c.position,
    charStart: c.charStart,
    charEnd: c.charEnd,
    text: c.text,
    confidence: c.confidence,
    engine: c.engine,
    engineVersion: c.engineVersion,
    compiledVersion: lineage.version.version,
  }));
}

interface JsonlRow extends Record<string, unknown> {
  chunk_id: string;
  dataset_type: string;
  document_id: string;
  document_name: string;
  source_id: string;
  source_name: string;
  position: number;
  char_start: number;
  char_end: number;
  text: string;
  confidence: number;
  classification_engine: string;
  classification_engine_version: string;
  compiled_version: number;
}

function toJsonlRow(row: DatasetExportRow): JsonlRow {
  return {
    chunk_id: row.chunkId,
    dataset_type: row.datasetType,
    document_id: row.documentId,
    document_name: row.documentName,
    source_id: row.sourceId,
    source_name: row.sourceName,
    position: row.position,
    char_start: row.charStart,
    char_end: row.charEnd,
    text: row.text,
    confidence: row.confidence,
    classification_engine: row.engine,
    classification_engine_version: row.engineVersion,
    compiled_version: row.compiledVersion,
  };
}

/** One JSON object per line, deterministic key order. */
export function exportDatasetJsonl(rows: DatasetExportRow[]): string {
  return rows.map((r) => JSON.stringify(toJsonlRow(r))).join("\n") + "\n";
}

const PARQUET_SCHEMA = new ParquetSchema({
  chunk_id: { type: "UTF8" },
  dataset_type: { type: "UTF8" },
  document_id: { type: "UTF8" },
  document_name: { type: "UTF8" },
  source_id: { type: "UTF8" },
  source_name: { type: "UTF8" },
  position: { type: "INT32" },
  char_start: { type: "INT32" },
  char_end: { type: "INT32" },
  text: { type: "UTF8" },
  confidence: { type: "DOUBLE" },
  classification_engine: { type: "UTF8" },
  classification_engine_version: { type: "UTF8" },
  compiled_version: { type: "INT32" },
});

/**
 * Parquet export via @dsnp/parquetjs (pure JS, pinned 1.8.9 — the 1.9.3
 * publish ships without dist/). Writes through a temp file because the
 * writer targets file paths; the temp file is always removed, even on
 * failure. Returns the file bytes.
 */
export async function exportDatasetParquet(
  rows: DatasetExportRow[],
): Promise<Buffer> {
  const tmpPath = join(
    tmpdir(),
    `dataset-export-${randomUUID().replace(/-/g, "")}.parquet`,
  );
  const writer = await ParquetWriter.openFile(PARQUET_SCHEMA, tmpPath);
  try {
    for (const row of rows) {
      await writer.appendRow(toJsonlRow(row));
    }
  } finally {
    await writer.close();
  }
  try {
    return await fs.readFile(tmpPath);
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
}
