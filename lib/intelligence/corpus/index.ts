// Marketr — Phase 10 M9: Expert knowledge base ("think like expert marketers").
//
// Vetted, versioned corpus of marketing expertise for the Chief Strategy
// Agent, missions, and playbooks. Clean-sourcing tiers are binding — see
// ./allowlist.ts. Storage is file-based and versioned — see ./store.ts.

export type {
  ChunkProvenance,
  CorpusChunk,
  CorpusLicenseKind,
  CorpusManifest,
  CorpusSourceRecord,
  ExpertHit,
  SourceStatus,
} from "./types";

export {
  assertIngestAllowed,
  SEED_SOURCES,
  SYNTHESIS_PLAYBOOKS,
  seedSourceById,
  registryConformance,
  type IngestDecision,
  type SeedSourceDef,
  type SynthesisPlaybookRef,
} from "./allowlist";

export {
  chunkDocument,
  splitSections,
  htmlToText,
  plainTextClean,
  assertProvenanceComplete,
  CHUNK_TARGET_CHARS,
  CHUNK_MIN_CHARS,
} from "./chunker";

export {
  ingestSeedSource,
  ingestSynthesisPlaybook,
  assertSynthesisAllowed,
  renumberChunks,
  pendingRecord,
  ensureLicenseNotes,
  type SynthesisPlaybookDef,
} from "./ingest";

export {
  corpusDir,
  loadManifest,
  saveManifest,
  appendChunks,
  loadChunks,
  clearAsset,
  assetCounts,
  writeLicenseNotes,
  type CorpusAsset,
} from "./store";

export { embedCorpusText, cosineSimilarity, EMBED_DIMS } from "./embed";

import { retrieveExpertContext as retrieve } from "./retrieve";
import type { ExpertHit } from "./types";

/**
 * retrieveExpertContext(query, opts?: {topK}) — THE public retrieval
 * contract. Sibling modules + the Chief Strategy Agent call this exact
 * signature. Returns top-K expert passages, every one source-attributed.
 * Cosine similarity over local 384-d embeddings. Do not widen this shape
 * without updating all consumers.
 */
export async function retrieveExpertContext(
  query: string,
  opts?: { topK?: number },
): Promise<Array<{ text: string; sourceTitle: string; author: string; license: string }>> {
  const hits: ExpertHit[] = await retrieve(query, opts);
  return hits.map((h) => ({
    text: h.text,
    sourceTitle: h.sourceTitle,
    author: h.author,
    license: h.license,
  }));
}
