// Marketr — Growth Memory (Phase 8 G3): shared types.
//
// Three stores, one retrieval contract (SPEC-PHASE8.md §2 G3):
//   episodic  — memory_episodes  (what happened; immutable)
//   semantic  — memory_facts     (distilled, bi-temporal; invalidate, never delete)
//   procedural— memory_learnings (what worked / failed / when; the F3 sink schema)

export type MemoryEpisodeType = "run" | "session" | "sync" | "agent_call";
export type MemoryLearningResult = "worked" | "failed" | "inconclusive";
export type MemoryLearningSource =
  | "test_lab"
  | "reallocation"
  | "campaign"
  | "human"
  | "import";
export type MemoryStoreKind = "episode" | "fact" | "learning";

/** Decay-to-floor provenance: what survives a prune sweep. */
export type MemoryOrigin = "user_told" | "agent_inferred" | "imported";

export interface EpisodeInput {
  episodeType: MemoryEpisodeType;
  actor: string;
  summary: string;
  refs?: Record<string, unknown>;
  startedAt?: Date;
  endedAt?: Date | null;
}

export interface FactInput {
  subjectNodeId?: string | null;
  predicate: string;
  object: Record<string, unknown>;
  confidence?: number;
  /** World time: when the fact was true. Defaults to now. */
  validAt?: Date;
  sourceEpisodeId?: string | null;
  origin?: MemoryOrigin;
}

export interface LearningInput {
  hypothesis: string;
  action: string;
  result: MemoryLearningResult;
  metricDelta?: Record<string, unknown>;
  observedAt?: Date;
  contextRefs?: Record<string, unknown>;
  source: MemoryLearningSource;
  sourceEpisodeId?: string | null;
}

export interface RecallHit {
  store: MemoryStoreKind;
  refId: string;
  title: string;
  body: string;
  subtitle: string | null;
  /** When the underlying record was observed / became valid. */
  observedAt: Date;
  /** For facts: the valid era. Null validTo = still current. */
  validFrom: Date | null;
  validTo: Date | null;
  episodeId: string | null;
  /** Fused score before rerank (0..1). */
  fusedScore: number;
  /** Cross-encoder rerank logit. */
  rerankScore: number | null;
  /** Final MMR+recency score (0..1). */
  score: number;
  exactMatch: boolean;
  /**
   * Candidate embedding (384-d), used for embedding-space MMR diversity.
   * Present on hits from recallRanked; stripped by memoryRecall before the
   * result leaves the retrieval layer (keeps API payloads lean).
   */
  embedding: number[] | null;
}

export interface RecallOptions {
  query: string;
  /** Bi-temporal lookup: facts valid at this instant. Defaults to now. */
  asOf?: Date;
  topK?: number;
  /** Fusion weight for the vector side (0 = BM25-only, 1 = vector-only). */
  alpha?: number;
  /** Skip the cross-encoder (used by the nDCG battery for ablations). */
  skipRerank?: boolean;
}

/** Provenance string rendered in UI / agent context packets. */
export function provenanceOf(hit: RecallHit): string {
  const when =
    hit.store === "fact" && hit.validFrom
      ? `valid ${hit.validFrom.toISOString().slice(0, 10)}${
          hit.validTo ? ` → ${hit.validTo.toISOString().slice(0, 10)}` : " → now"
        }`
      : `observed ${hit.observedAt.toISOString().slice(0, 10)}`;
  const ep = hit.episodeId ? ` · episode ${hit.episodeId.slice(-8)}` : "";
  return `${hit.store}:${hit.refId.slice(-8)} · ${when}${ep}`;
}
