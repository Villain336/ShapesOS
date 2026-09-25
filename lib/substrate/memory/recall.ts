// Marketr — Growth Memory retrieval: memory_recall() (Phase 8 G3).
//
// The 2026 production recipe, entirely inside Postgres (SPEC-PHASE8.md §2 G3):
//   hybrid tsvector/pg_trgm + pgvector HNSW → convex-combination fusion
//   (α tuned on the repo's ~40 labeled pairs in fixtures/retrieval-pairs.ts)
//   → cross-encoder rerank (local model, no external API) → MMR + recency
//   decay → top-k with provenance.
// Exact-match queries (IDs, error codes) bypass the vector component — the
// research shows zero vector benefit there.
// Temporal queries (as_of) resolve against bi-temporal validity.

import { withWorkspaceScope } from "./rls";
import { embedText, toVectorLiteral, crossEncoderScores } from "./embed";
import type { RecallHit, RecallOptions, MemoryStoreKind } from "./types";

export const DEFAULT_ALPHA = 0.4;
const CANDIDATE_LIMIT = 60;
const RERANK_POOL = 20;
const MMR_LAMBDA = 0.7;
// Recency half-life ~125 days: score *= 0.5 + 0.5 * exp(-ageDays/180)
const RECENCY_TAU_DAYS = 180;

interface Candidate {
  store: MemoryStoreKind;
  refId: string;
  title: string;
  body: string;
  subtitle: string | null;
  observedAt: Date;
  validFrom: Date | null;
  validTo: Date | null;
  episodeId: string | null;
  bm25: number;
  trgm: number;
  vsim: number | null; // 1 - cosine distance, null when no embedding
  embedding: number[] | null;
}

/** Build an OR-joined tsquery (research: AND-joined websearch_to_tsquery
 *  returns zero rows for most real queries — BM25 needs OR matching). */
function buildTsQuery(query: string): string | null {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const uniq = [...new Set(words)].slice(0, 24);
  if (uniq.length === 0) return null;
  return uniq.map((w) => `'${w.replace(/'/g, "''")}'`).join(" | ");
}

/** Exact-match bypass: IDs and error codes skip the vector component. */
export function isExactMatchQuery(query: string): boolean {
  const q = query.trim();
  return (
    /^[a-z0-9]{20,32}$/i.test(q) || // cuid-style ids
    /^[A-Z]{2,10}[-_][0-9A-Za-z]{2,20}$/.test(q) || // EXP-1042, ERR_TIMEOUT
    /^".+"$/.test(q) // quoted phrase → literal phrase search
  );
}

const STORE_SQL: Record<
  MemoryStoreKind,
  { table: string; textExpr: string; cols: string; observedCol: string; temporalWhere: string }
> = {
  episode: {
    table: "memory_episodes",
    textExpr: `"actor" || ' ' || "summary"`,
    cols: `"episode_type"::text AS title, "summary" AS body, "actor" AS subtitle, "started_at" AS observed_at, "started_at" AS valid_from, NULL::timestamptz AS valid_to, "id" AS episode_id`,
    observedCol: `"started_at"`,
    // Episodes are immutable history: only the observation-time bound applies.
    temporalWhere: `"started_at" <= $4::timestamptz`,
  },
  fact: {
    table: "memory_facts",
    textExpr: `"predicate" || ' ' || ("object"::text)`,
    cols: `"predicate" AS title, ("object"::text) AS body, "origin" AS subtitle, "created_at" AS observed_at, "valid_at" AS valid_from, "invalid_at" AS valid_to, "source_episode_id" AS episode_id`,
    observedCol: `"created_at"`,
    // Bi-temporal era: valid at $4 means the era started and hasn't been
    // superseded (invalid_at) yet.
    temporalWhere: `"valid_at" <= $4::timestamptz AND ("invalid_at" IS NULL OR "invalid_at" > $4::timestamptz)`,
  },
  learning: {
    table: "memory_learnings",
    textExpr: `"hypothesis" || ' ' || "action"`,
    cols: `("result"::text || ': ' || left("hypothesis", 120)) AS title, ("hypothesis" || ' ||| ' || "action") AS body, ("source"::text) AS subtitle, "observed_at" AS observed_at, "observed_at" AS valid_from, "invalidated_at" AS valid_to, "source_episode_id" AS episode_id`,
    observedCol: `"observed_at"`,
    // Learnings stay recallable for their era: invalidated_at ends the era.
    temporalWhere: `"observed_at" <= $4::timestamptz AND ("invalidated_at" IS NULL OR "invalidated_at" > $4::timestamptz)`,
  },
};

async function fetchCandidates(
  tx: { $queryRawUnsafe: (q: string, ...p: unknown[]) => Promise<unknown> },
  workspaceId: string,
  store: MemoryStoreKind,
  query: string,
  tsq: string | null,
  vecLiteral: string | null,
  asOf: Date,
): Promise<Candidate[]> {
  const { table, textExpr, cols, temporalWhere } = STORE_SQL[store];
  const byId = new Map<string, Candidate>();
  const asOfIso = asOf.toISOString();

  // Lexical side: BM25 (ts_rank) + trigram similarity. Temporal predicates
  // are applied IN the candidate query so the LIMIT pool is era-correct
  // (post-hoc filtering alone can drop the right row from a full pool).
  if (tsq) {
    const rows = (await tx.$queryRawUnsafe(
      `SELECT "id" AS ref_id, ${cols},
              ts_rank("search_tsv", to_tsquery('english', $2)) AS bm25,
              similarity(${textExpr}, $3) AS trgm,
              "embedding"::text AS emb
         FROM "${table}"
        WHERE "workspace_id" = $1
          AND ("search_tsv" @@ to_tsquery('english', $2) OR similarity(${textExpr}, $3) > 0.12)
          AND ${temporalWhere}
        ORDER BY ts_rank("search_tsv", to_tsquery('english', $2)) DESC
        LIMIT ${CANDIDATE_LIMIT}`,
      workspaceId,
      tsq,
      query.slice(0, 500),
      asOfIso,
    )) as Record<string, unknown>[];
    for (const r of rows) byId.set(String(r.ref_id), toCandidate(store, r, null));
  }

  // Vector side: HNSW-backed nearest neighbors (ORDER BY <=> LIMIT).
  if (vecLiteral) {
    const rows = (await tx.$queryRawUnsafe(
      `SELECT "id" AS ref_id, ${cols},
              1 - ("embedding" <=> $2::vector) AS vsim,
              "embedding"::text AS emb
         FROM "${table}"
        WHERE "workspace_id" = $1 AND "embedding" IS NOT NULL
          AND ${temporalWhere.replace(/\$4/g, "$3")}
        ORDER BY "embedding" <=> $2::vector
        LIMIT ${CANDIDATE_LIMIT}`,
      workspaceId,
      vecLiteral,
      asOfIso,
    )) as Record<string, unknown>[];
    for (const r of rows) {
      const existing = byId.get(String(r.ref_id));
      if (existing) {
        existing.vsim = Number(r.vsim);
        existing.embedding = parseVector(r.emb);
      } else {
        byId.set(String(r.ref_id), toCandidate(store, r, Number(r.vsim)));
      }
    }
  }

  return [...byId.values()];
}

function parseVector(emb: unknown): number[] | null {
  if (typeof emb !== "string") return null;
  const inner = emb.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner) return null;
  const v = inner.split(",").map(Number);
  return v.length > 0 && v.every(Number.isFinite) ? v : null;
}

function toCandidate(store: MemoryStoreKind, r: Record<string, unknown>, vsim: number | null): Candidate {
  return {
    store,
    refId: String(r.ref_id),
    title: String(r.title ?? ""),
    body: String(r.body ?? ""),
    subtitle: r.subtitle == null ? null : String(r.subtitle),
    observedAt: new Date(String(r.observed_at)),
    validFrom: r.valid_from ? new Date(String(r.valid_from)) : null,
    validTo: r.valid_to ? new Date(String(r.valid_to)) : null,
    episodeId: r.episode_id ? String(r.episode_id) : null,
    bm25: Number(r.bm25 ?? 0),
    trgm: Number(r.trgm ?? 0),
    vsim,
    embedding: parseVector(r.emb),
  };
}

function minMax(vals: number[]): (v: number) => number {
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  if (!(hi > lo)) return () => 0.5;
  return (v) => (v - lo) / (hi - lo);
}

/** Fusion + rerank, no MMR/recency. Exported for the nDCG battery. */
export async function recallRanked(
  workspaceId: string,
  opts: RecallOptions,
): Promise<Array<RecallHit & { fusedScore: number; rerankScore: number | null }>> {
  const query = opts.query.trim();
  if (!query) return [];
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const asOf = opts.asOf ?? new Date();

  return withWorkspaceScope(workspaceId, async (tx) => {
    // Exact-match bypass: IDs / error codes skip vector + rerank.
    if (isExactMatchQuery(query)) {
      return exactMatchRecall(tx, workspaceId, query, asOf, opts.topK ?? 10);
    }

    const tsq = buildTsQuery(query);
    const vecLiteral = toVectorLiteral(await embedText(query));
    const all: Candidate[] = [];
    for (const store of ["episode", "fact", "learning"] as MemoryStoreKind[]) {
      all.push(...(await fetchCandidates(tx, workspaceId, store, query, tsq, vecLiteral, asOf)));
    }

    // Temporal filter (bi-temporal for facts; era filter for learnings via
    // invalidated_at). Belt-and-braces: the candidate SQL already applies the
    // same predicates so the LIMIT pool is era-correct.
    const inEra = all.filter((c) => {
      if (c.observedAt > asOf) return false;
      if (c.store === "fact" || c.store === "learning") {
        if (c.validFrom && c.validFrom > asOf) return false;
        if (c.validTo && c.validTo <= asOf) return false;
      }
      return true;
    });
    if (inEra.length === 0) return [];

    // Convex-combination fusion of min-max normalized signals.
    const nBm25 = minMax(inEra.map((c) => c.bm25));
    const nTrgm = minMax(inEra.map((c) => c.trgm));
    const nVec = minMax(inEra.map((c) => c.vsim ?? 0));
    const fused = inEra.map((c) => {
      const lexical = 0.7 * nBm25(c.bm25) + 0.3 * nTrgm(c.trgm);
      const vector = c.vsim == null ? 0 : nVec(c.vsim);
      return { c, fusedScore: alpha * vector + (1 - alpha) * lexical };
    });
    fused.sort((a, b) => b.fusedScore - a.fusedScore);
    const pool = fused.slice(0, RERANK_POOL);

    // Cross-encoder rerank (local model).
    let reranked: Array<{ c: Candidate; fusedScore: number; rerankScore: number | null }>;
    if (opts.skipRerank || pool.length === 0) {
      reranked = pool.map((p) => ({ ...p, rerankScore: null }));
    } else {
      const scores = await crossEncoderScores(
        query,
        pool.map((p) => `${p.c.title} ${p.c.body}`.slice(0, 2000)),
      );
      reranked = pool
        .map((p, i) => ({ ...p, rerankScore: scores[i] ?? null }))
        .sort((a, b) => (b.rerankScore ?? -Infinity) - (a.rerankScore ?? -Infinity));
    }

    return reranked.map(({ c, fusedScore, rerankScore }) => ({
      store: c.store,
      refId: c.refId,
      title: c.title,
      body: c.body.length > 600 ? c.body.slice(0, 600) + "…" : c.body,
      subtitle: c.subtitle,
      observedAt: c.observedAt,
      validFrom: c.validFrom,
      validTo: c.validTo,
      episodeId: c.episodeId,
      fusedScore,
      rerankScore,
      score: fusedScore,
      exactMatch: false,
      embedding: c.embedding,
    }));
  });
}

async function exactMatchRecall(
  tx: { $queryRawUnsafe: (q: string, ...p: unknown[]) => Promise<unknown> },
  workspaceId: string,
  query: string,
  asOf: Date,
  topK: number,
): Promise<RecallHit[]> {
  const q = query.trim();
  const phrase = q.replace(/^"|"$/g, "");
  const hits: RecallHit[] = [];
  const seen = new Set<string>();
  const push = (r: Record<string, unknown>, store: MemoryStoreKind) => {
    const id = String(r.ref_id);
    if (seen.has(id)) return;
    seen.add(id);
    hits.push({
      store,
      refId: id,
      title: String(r.title ?? ""),
      body: String(r.body ?? "").slice(0, 600),
      subtitle: r.subtitle == null ? null : String(r.subtitle),
      observedAt: new Date(String(r.observed_at)),
      validFrom: r.valid_from ? new Date(String(r.valid_from)) : null,
      validTo: r.valid_to ? new Date(String(r.valid_to)) : null,
      episodeId: r.episode_id ? String(r.episode_id) : null,
      fusedScore: 1,
      rerankScore: null,
      score: 1,
      exactMatch: true,
      embedding: null,
    });
  };
  for (const store of ["episode", "fact", "learning"] as MemoryStoreKind[]) {
    const { table, textExpr, cols, observedCol } = STORE_SQL[store];
    const rows = (await tx.$queryRawUnsafe(
      `SELECT "id" AS ref_id, ${cols} FROM "${table}"
        WHERE "workspace_id" = $1
          AND ("id" = $2 OR ${textExpr} ILIKE $3)
          AND ${observedCol} <= $4::timestamptz
        LIMIT $5`,
      workspaceId,
      q,
      `%${phrase.replace(/[%_]/g, "")}%`,
      asOf.toISOString(),
      topK,
    )) as Record<string, unknown>[];
    // facts need the bi-temporal era check too
    for (const r of rows) {
      if (store === "fact") {
        const vf = r.valid_from ? new Date(String(r.valid_from)) : null;
        const vt = r.valid_to ? new Date(String(r.valid_to)) : null;
        if (vf && vf > asOf) continue;
        if (vt && vt <= asOf) continue;
      }
      push(r, store);
      if (hits.length >= topK) break;
    }
    if (hits.length >= topK) break;
  }
  return hits.slice(0, topK);
}

function recencyFactor(observedAt: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - observedAt.getTime()) / 86400_000);
  return 0.5 + 0.5 * Math.exp(-ageDays / RECENCY_TAU_DAYS);
}

/**
 * memory_recall(): the retrieval interface every agent calls.
 * Hybrid → fusion → cross-encoder rerank → MMR (diversity) + recency decay.
 * Returns top-k hits with provenance.
 */
export async function memoryRecall(
  workspaceId: string,
  opts: RecallOptions,
): Promise<RecallHit[]> {
  const topK = Math.min(Math.max(opts.topK ?? 10, 1), 50);
  const ranked = await recallRanked(workspaceId, opts);
  if (ranked.length === 0) return [];
  if (ranked[0]!.exactMatch) return ranked.slice(0, topK);

  // MMR: greedily pick diverse, relevant hits. Diversity is embedding-space
  // cosine similarity when both candidates carry embeddings (they are
  // already fetched for the vector signal — no extra query), with
  // token-overlap Jaccard as the fallback.
  const now = opts.asOf ?? new Date();
  const scored = ranked.map((h) => ({
    h,
    rel: h.rerankScore != null ? sigmoid(h.rerankScore) : h.fusedScore,
  }));
  const selected: typeof scored = [];
  const remaining = [...scored].sort((a, b) => b.rel - a.rel);
  while (remaining.length > 0 && selected.length < topK) {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]!;
      let maxSim = 0;
      for (const s of selected) {
        maxSim = Math.max(maxSim, diversitySim(cand.h, s.h));
      }
      const mmr = MMR_LAMBDA * cand.rel - (1 - MMR_LAMBDA) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        best = i;
      }
    }
    const [pick] = remaining.splice(best, 1);
    selected.push(pick!);
  }

  // Strip embeddings before the result leaves the retrieval layer.
  return selected.map(({ h, rel }) => {
    const { embedding: _embedding, ...rest } = h;
    return { ...rest, embedding: null, score: rel * recencyFactor(h.observedAt, now) };
  });
}

/** Embedding cosine when available, else token-overlap Jaccard. */
function diversitySim(a: RecallHit, b: RecallHit): number {
  if (a.embedding && b.embedding) return cosineSim(a.embedding, b.embedding);
  return jaccard(a.title + " " + a.body, b.title + " " + b.body);
}

function cosineSim(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!(na > 0 && nb > 0)) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function jaccard(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Re-export the tuned default so the battery and API share one α. */
export { DEFAULT_ALPHA as TUNED_ALPHA_DEFAULT };
