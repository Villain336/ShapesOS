// Marketr — Growth Memory local models (Phase 8 G3).
//
// No external API on the recall path (spec §2 G3): embeddings and the
// cross-encoder reranker both run locally via transformers.js. Models are
// downloaded once (battery warms the cache) and served from the local HF
// cache afterwards. If a model cannot load, the caller gets an HONEST error
// — never a silent degraded mode (spec §9.12).

import { env, pipeline } from "@xenova/transformers";

env.cacheDir = process.env.MEMORY_MODEL_CACHE ?? `${process.env.HOME ?? "/tmp"}/.cache/hf-models`;
env.allowLocalModels = true;

const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

/** Embedding dimension of EMBED_MODEL. Matches vector(384) in the migration. */
export const EMBED_DIMS = 384;

type FeatureExtractionPipeline = (text: string, opts?: Record<string, unknown>) => Promise<{
  data: Float32Array;
  dims: number[];
}>;

let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;
let rerankerPromise: Promise<{
  tokenizer: (texts: string[], opts: Record<string, unknown>) => unknown;
  model: (inputs: unknown) => Promise<{ logits: { data: Float32Array } }>;
}> | null = null;

export class MemoryModelError extends Error {}

/** Lazy singleton embedder. Throws MemoryModelError (honest) when unloadable. */
export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      try {
        const pipe = await pipeline("feature-extraction", EMBED_MODEL);
        return pipe as unknown as FeatureExtractionPipeline;
      } catch (err) {
        embedderPromise = null;
        throw new MemoryModelError(
          `Growth Memory embedder failed to load (${EMBED_MODEL}): ${
            err instanceof Error ? err.message : String(err)
          }. Recall embeddings require the cached local model — check MEMORY_MODEL_CACHE / network for first download.`,
        );
      }
    })();
  }
  return embedderPromise;
}

/** Embed one text → 384-d L2-normalized vector. */
export async function embedText(text: string): Promise<number[]> {
  const pipe = await getEmbedder();
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 4000) || "(empty)";
  const out = await pipe(clean, { pooling: "mean", normalize: true });
  if (out.dims[1] !== EMBED_DIMS) {
    throw new MemoryModelError(`Unexpected embedding dims ${out.dims[1]} (expected ${EMBED_DIMS})`);
  }
  return Array.from(out.data);
}

/** Format a float array as a pgvector literal: '[0.1,0.2,...]'. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.map((v) => (Number.isFinite(v) ? v : 0)).join(",")}]`;
}

/**
 * Cross-encoder rerank scores for (query, doc) pairs via the local
 * ms-marco MiniLM model. Returns raw logits (higher = more relevant).
 * Batched in chunks to bound memory.
 */
export async function crossEncoderScores(
  query: string,
  docs: string[],
): Promise<number[]> {
  if (docs.length === 0) return [];
  if (!rerankerPromise) {
    rerankerPromise = (async () => {
      try {
        const { AutoTokenizer, AutoModelForSequenceClassification } = await import(
          "@xenova/transformers"
        );
        const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL);
        const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL);
        return { tokenizer, model };
      } catch (err) {
        rerankerPromise = null;
        throw new MemoryModelError(
          `Growth Memory reranker failed to load (${RERANK_MODEL}): ${
            err instanceof Error ? err.message : String(err)
          }.`,
        );
      }
    })();
  }
  const { tokenizer, model } = await rerankerPromise;
  const scores: number[] = [];
  const CHUNK = 16;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const chunk = docs.slice(i, i + CHUNK);
    const enc = (tokenizer as (t: string[], o: Record<string, unknown>) => unknown)(
      Array(chunk.length).fill(query),
      { text_pair: chunk.map((d) => d.replace(/\s+/g, " ").trim().slice(0, 2000)), padding: true, truncation: true },
    );
    const { logits } = await model(enc);
    for (const s of Array.from(logits.data)) scores.push(s);
  }
  return scores;
}

/** Warm both models (used by the battery + first-write path). */
export async function warmMemoryModels(): Promise<void> {
  await embedText("warmup");
  await crossEncoderScores("warmup", ["warmup document"]);
}
