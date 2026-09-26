// Marketr — Phase 10 M9: corpus embedding.
//
// DEVIATION (documented): the task said "embed (via lib/llm router
// embeddings)", but lib/llm has NO embeddings API — the LlmProvider
// interface exposes only generate() (completions). Rather than invent a new
// remote-embeddings surface (new API spend, new key material, new ZDR
// surface), the corpus uses the same local 384-d MiniLM embedder that Phase
// 8 G3 already runs for Growth Memory (lib/substrate/memory/embed.ts):
//
//   • zero marginal cost (Phase 10's rent-cutting goal),
//   • no external API on the recall path (SPEC-PHASE8 §2 G3 posture),
//   • models already cached in the box (MEMORY_MODEL_CACHE).
//
// The embedding space is IDENTICAL to Growth Memory's (same model, same
// normalization), which keeps future cross-corpus fusion trivial. If a
// remote embeddings provider is ever added to lib/llm, it can be swapped in
// behind embedCorpusText() without touching callers.

import { embedText as memoryEmbedText, EMBED_DIMS } from "../../substrate/memory/embed";

export { EMBED_DIMS };

/** Embed one chunk/query text → 384-d L2-normalized vector. */
export async function embedCorpusText(text: string): Promise<number[]> {
  return memoryEmbedText(text);
}

/** Cosine similarity of two L2-normalized vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  // Clamp: float noise can push a hair past ±1.
  return Math.max(-1, Math.min(1, dot));
}
