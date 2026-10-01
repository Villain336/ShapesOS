// Marketr — Dataset Builder slice 1: source register + integrity check.
// The register is the clean-sourcing discipline made queryable: every
// source, its documents, and chunk counts. verifyNoOrphanedChunks() is the
// runtime counterpart of the DB foreign keys — it must always return an
// empty list; anything in it is a data-integrity incident.

import type {
  DatasetBuilderStore,
  DatasetChunkRecord,
  DatasetDocumentRecord,
  DatasetSourceRecord,
} from "./types";

export interface SourceRegisterEntry {
  source: DatasetSourceRecord;
  documents: {
    document: DatasetDocumentRecord;
    chunkCount: number;
    charCount: number;
  }[];
  documentCount: number;
  chunkCount: number;
  charCount: number;
}

export interface SourceRegister {
  workspaceId: string;
  entries: SourceRegisterEntry[];
  totals: { sources: number; documents: number; chunks: number; chars: number };
}

/** Every source with its documents and chunk counts for a workspace. */
export async function getSourceRegister(
  store: DatasetBuilderStore,
  workspaceId: string,
): Promise<SourceRegister> {
  const sources = await store.listSources(workspaceId);
  const entries: SourceRegisterEntry[] = [];
  for (const source of sources) {
    const documents = await store.listDocumentsBySource(source.id);
    const docs = [];
    let chunkCount = 0;
    let charCount = 0;
    for (const document of documents) {
      const chunks = await store.listChunksByDocument(document.id);
      chunkCount += chunks.length;
      charCount += document.charCount;
      docs.push({
        document,
        chunkCount: chunks.length,
        charCount: document.charCount,
      });
    }
    entries.push({
      source,
      documents: docs,
      documentCount: documents.length,
      chunkCount,
      charCount,
    });
  }
  return {
    workspaceId,
    entries,
    totals: {
      sources: entries.length,
      documents: entries.reduce((n, e) => n + e.documentCount, 0),
      chunks: entries.reduce((n, e) => n + e.chunkCount, 0),
      chars: entries.reduce((n, e) => n + e.charCount, 0),
    },
  };
}

/**
 * Integrity check: every chunk must point at a live document, and every
 * document at a live source. Returns the offending chunk records — an empty
 * array means the invariant holds. The store and the DB both reject the
 * writes that would create entries here, so a non-empty result is always
 * an incident, never a normal state.
 */
export async function verifyNoOrphanedChunks(
  store: DatasetBuilderStore,
  workspaceId: string,
): Promise<DatasetChunkRecord[]> {
  const chunks = await store.listAllChunks(workspaceId);
  const orphans: DatasetChunkRecord[] = [];
  for (const chunk of chunks) {
    const document = await store.getDocument(chunk.documentId);
    if (!document) {
      orphans.push(chunk);
      continue;
    }
    const source = await store.getSource(document.sourceId);
    if (!source) orphans.push(chunk);
  }
  return orphans;
}
