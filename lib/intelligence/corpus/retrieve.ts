// Marketr — Phase 10 M9: retrieval over the expert corpus.
//
// retrieveExpertContext() is the public contract (see index.ts): cosine
// similarity of the query embedding against chunk embeddings, always with
// source attribution. Workspace-agnostic by design — the corpus is a
// product asset, not tenant data. Per-workspace usage is logged through the
// mission audit log (Chief Strategy Agent dispatch observations carry the
// expert_corpus citations).
//
// For tests, retrieveExpertContextWithEmbed() accepts an injected embedder
// so the suite doesn't need the local model.

import type { CorpusChunk, ExpertHit } from "./types";
import { loadChunks } from "./store";
import { embedCorpusText, cosineSimilarity } from "./embed";
import { recordRetrievalHits } from "./activity";

export interface RetrieveOptions {
  topK?: number;
}

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

type EmbedFn = (text: string) => Promise<number[]>;

async function retrieveWith(
  query: string,
  opts: RetrieveOptions | undefined,
  embed: EmbedFn,
): Promise<ExpertHit[]> {
  const q = (query ?? "").trim();
  if (!q) return [];
  const topK = Math.min(Math.max(opts?.topK ?? DEFAULT_TOP_K, 1), MAX_TOP_K);

  const queryVec = await embed(q.slice(0, 2000));

  const scored: Array<{ chunk: CorpusChunk; score: number }> = [];
  for (const asset of ["main", "by-sa"] as const) {
    for (const chunk of loadChunks(asset)) {
      if (!chunk.embedding || chunk.embedding.length === 0) continue;
      const score = cosineSimilarity(queryVec, chunk.embedding);
      scored.push({ chunk, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const hits = scored.slice(0, topK);
  // Audit trail: per-source retrieval counters (best-effort, never throws).
  // The public ExpertHit shape is unchanged — sourceIds stay internal.
  recordRetrievalHits(hits.map(({ chunk }) => chunk.provenance.sourceId));
  return hits.map(({ chunk }) => ({
    text: chunk.text,
    sourceTitle: chunk.provenance.sourceTitle,
    author: chunk.provenance.author,
    license: chunk.provenance.license,
  }));
}

/**
 * retrieveExpertContext(query, opts?: {topK}) — the exact public contract.
 * Embeds via the local corpus embedder (see embed.ts for the rationale).
 */
export async function retrieveExpertContext(
  query: string,
  opts?: RetrieveOptions,
): Promise<ExpertHit[]> {
  return retrieveWith(query, opts, embedCorpusText);
}

/** Injectable-embedder variant — for tests only. */
export async function retrieveExpertContextWithEmbed(
  query: string,
  opts: RetrieveOptions | undefined,
  embed: EmbedFn,
): Promise<ExpertHit[]> {
  return retrieveWith(query, opts, embed);
}
