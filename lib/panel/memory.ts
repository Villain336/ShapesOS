// ShapesOS — Phase 19B (WS=panel): the Dress Rehearsal memory stream.
// Commercial layer (entitlement dress_rehearsal). See lib/panel/README.md.
//
// Ported from the prototype's src/calibration/transcripts.ts (the genagents
// rule: the transcript IS the product — stored verbatim, chunked into memory
// nodes, never summarized into a bio). Retrieval scores each node by
//   recency (0.99 decay per hour since last retrieved)
// + relevance (cosine similarity of embeddings)
// + importance (heuristic keyword scorer, or an injected scorer).
//
// What changed versus the prototype:
//   * relevance is embedding similarity, not token overlap. Production uses
//     the local MiniLM embedder and pgvector (lib/panel/store.server.ts,
//     PgMemoryStore); this file's InMemoryMemoryStore takes any embed
//     function. lexicalTestEmbedder is a labelled FAKE embedder (hashed bag
//     of words) so pure tests stay deterministic — never used in production.
//   * retrieval can be SCOPED to transcripts and to one run's persona
//     (`transcriptIds`, `runId` / `personaKey`), and `perTranscript` retrieves
//     k nodes from EACH transcript. The prototype pulled the global top-k and
//     filtered afterwards, so a persona's evidence was starved whenever other
//     transcripts outscored its own ("evidence starved across transcripts").
//
// The MemoryStore interface is the seam the town engine (WS=engine) reads:
// residents and panel personas share one memory stream.

export type NodeKind = "interview" | "reflection" | "observation" | "thought" | "verdict";
export const NODE_KINDS: readonly NodeKind[] = ["interview", "reflection", "observation", "thought", "verdict"];

export interface Transcript {
  id: string;
  /** Raw interview text, verbatim. Never rewritten, never summarized. */
  text: string;
  title?: string;
  interviewee?: string;
  createdAt: number;
}

export interface MemoryNode {
  id: string;
  kind: NodeKind;
  /** Interview / reflection nodes: the transcript they came from. */
  transcriptId: string | null;
  /** Walk nodes (observation / thought / verdict): the run and persona they belong to. */
  runId: string | null;
  personaKey: string | null;
  /** Reflection nodes: the lens that produced them. */
  lens?: string | null;
  /** Verbatim chunk of the transcript, or generated text for walk nodes. */
  content: string;
  importance: number;
  chunkIndex: number;
  createdAt: number;
  lastRetrieved: number;
}

export type NewMemoryNode = Omit<MemoryNode, "createdAt" | "lastRetrieved" | "transcriptId" | "runId" | "personaKey"> & {
  transcriptId?: string | null;
  runId?: string | null;
  personaKey?: string | null;
};

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

export type ImportanceScorer = (content: string) => number | Promise<number>;
/** Text → unit-length vector. Production: MiniLM (384-d). */
export type EmbedFn = (text: string) => Promise<number[]>;

const STOPWORDS = new Set(
  "a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,have,has,had,do,does,did,will,would,should,could,can,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,our,their,my,your,me,him,us,not,no,yes,so,very,just,about,into,over,after,before,between,through,during,up,down,out,off,again,once,here,there,when,where,why,how,all,any,both,each,few,more,most,other,some,such,only,own,same,than,too".split(","),
);

/** Content words (length > 2, no stopwords), lowercased. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Heuristic importance: the signals that matter to a customer simulator —
 * pricing, objections, competitors, trust, workflow fit — score high;
 * everything else keeps a 0.2 floor so no chunk is invisible.
 */
export function heuristicImportanceScorer(content: string): number {
  const text = content.toLowerCase();
  let score = 0.2;
  const strong: [RegExp, number][] = [
    [/\b(price|cost|pricing|expensive|cheap|budget|pay|afford|roi)\b/, 0.35],
    [/\b(objection|concern|worried|worry|problem|issue|frustrat|annoy|hate|dislike)\b/, 0.3],
    [/\b(competitor|alternative|instead of|switched|migrat|vs\.?)\b/, 0.25],
    [/\b(trust|skeptical|doubt|believe|claim|promise|guarantee|scam)\b/, 0.3],
    [/\b(setup|onboard|integration|workflow|migrate|learning curve)\b/, 0.2],
    [/\b(buy|purchase|subscribe|sign ?up|checkout|trial)\b/, 0.2],
    [/\b(cancel|refund|churn|quit|stopped using)\b/, 0.35],
  ];
  for (const [re, weight] of strong) if (re.test(text)) score += weight;
  return Math.min(1, score);
}

/** Cosine similarity of two vectors, clamped to [0, 1] (negative similarity = unrelated). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return Math.min(1, Math.max(0, dot / Math.sqrt(na * nb)));
}

/** FNV-1a 32-bit (deterministic hashing for the fake embedder). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * FAKE embedder for tests (labelled): a 256-bucket hashed bag of content
 * words, L2-normalised. Two texts sharing words are similar; no shared words
 * → 0; an empty text → the zero vector (similarity 0). Production retrieval
 * never uses it (PgMemoryStore embeds with MiniLM).
 */
export const lexicalTestEmbedder: EmbedFn = async (text) => {
  const v = new Array<number>(256).fill(0);
  for (const t of tokenize(text)) v[fnv1a(t) % 256] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
};

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export interface ChunkOptions {
  /** Target chunk size in words. Default 120. */
  chunkSizeWords?: number;
  /** Overlap between consecutive chunks in words. Default 20. */
  overlapWords?: number;
  importanceScorer?: ImportanceScorer;
}

export interface TranscriptChunk {
  content: string;
  importance: number;
  chunkIndex: number;
}

/** Word-based chunking with overlap; each chunk scored for importance (sync or async scorer). */
export async function chunkText(text: string, options: ChunkOptions = {}): Promise<TranscriptChunk[]> {
  const { chunkSizeWords = 120, overlapWords = 20, importanceScorer = heuristicImportanceScorer } = options;
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const step = Math.max(1, chunkSizeWords - overlapWords);
  const out: TranscriptChunk[] = [];
  for (let start = 0, i = 0; start < words.length; start += step, i += 1) {
    const content = words.slice(start, start + chunkSizeWords).join(" ");
    const raw = await importanceScorer(content);
    out.push({ content, importance: Math.min(1, Math.max(0, raw)), chunkIndex: i });
    if (start + chunkSizeWords >= words.length) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export interface RetrievalWeights {
  recency?: number;
  relevance?: number;
  importance?: number;
}

export interface RetrievalOptions {
  k?: number;
  weights?: RetrievalWeights;
  /** Only these kinds. Default: all. */
  kinds?: readonly NodeKind[];
  /** Only interview / reflection nodes of these transcripts (walk nodes are matched by runId/personaKey). */
  transcriptIds?: readonly string[];
  /** Include this run's walk nodes (observation / thought / verdict) for this persona. */
  runId?: string;
  personaKey?: string;
  /** Return up to `k` nodes from EACH listed transcript (plus up to `k` walk nodes) instead of a global top-k. */
  perTranscript?: boolean;
  /** "now" for tests. Default Date.now(). */
  now?: number;
}

export interface ScoredNode {
  node: MemoryNode;
  score: number;
  recency: number;
  relevance: number;
  importance: number;
}

/** genagents memory-stream recency decay base (per hour). */
export const RECENCY_DECAY = 0.99;

export function recencyScore(lastRetrieved: number, now: number): number {
  const hours = Math.max(0, (now - lastRetrieved) / 3_600_000);
  return Math.pow(RECENCY_DECAY, hours);
}

export function combinedScore(s: { recency: number; relevance: number; importance: number }, weights: RetrievalWeights = {}): number {
  const wRec = weights.recency ?? 1;
  const wRel = weights.relevance ?? 1;
  const wImp = weights.importance ?? 1;
  const denom = wRec + wRel + wImp;
  return denom === 0 ? 0 : (wRec * s.recency + wRel * s.relevance + wImp * s.importance) / denom;
}

/** Does a node pass the scope filters? Interview/reflection nodes by transcript; walk nodes by run + persona. */
export function inScope(node: Pick<MemoryNode, "kind" | "transcriptId" | "runId" | "personaKey">, opts: RetrievalOptions): boolean {
  if (opts.kinds && !opts.kinds.includes(node.kind)) return false;
  const walkNode = node.kind === "observation" || node.kind === "thought" || node.kind === "verdict";
  if (walkNode) {
    if (opts.runId === undefined && opts.personaKey === undefined) return opts.transcriptIds === undefined;
    if (opts.runId !== undefined && node.runId !== opts.runId) return false;
    if (opts.personaKey !== undefined && node.personaKey !== opts.personaKey) return false;
    return true;
  }
  if (opts.transcriptIds === undefined) return opts.runId === undefined && opts.personaKey === undefined ? true : false;
  return node.transcriptId !== null && opts.transcriptIds.includes(node.transcriptId);
}

/** Global top-k, or top-k per transcript (+ top-k walk nodes) when perTranscript. */
export function selectTop(scored: ScoredNode[], opts: RetrievalOptions): ScoredNode[] {
  const k = Math.max(0, opts.k ?? 5);
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  if (!opts.perTranscript) return sorted.slice(0, k);
  const buckets = new Map<string, number>();
  const out: ScoredNode[] = [];
  for (const s of sorted) {
    const key = s.node.transcriptId ?? `walk:${s.node.runId ?? ""}`;
    const n = buckets.get(key) ?? 0;
    if (n >= k) continue;
    buckets.set(key, n + 1);
    out.push(s);
  }
  return out;
}

/**
 * The memory stream both the panel and the town read and write. Implemented
 * in memory (tests, InMemoryMemoryStore) and over Postgres + pgvector
 * (production, PgMemoryStore in lib/panel/store.server.ts).
 */
export interface MemoryStore {
  getTranscript(id: string): Promise<Transcript | undefined>;
  /** Store a transcript verbatim and chunk it into interview nodes. */
  addTranscript(transcript: Transcript, options?: ChunkOptions): Promise<MemoryNode[]>;
  addNode(node: NewMemoryNode): Promise<MemoryNode>;
  retrieve(focalQuery: string, options?: RetrievalOptions): Promise<ScoredNode[]>;
  /** Interview nodes of a transcript in order (derivation evidence). */
  transcriptNodes(transcriptId: string, kinds?: readonly NodeKind[]): Promise<MemoryNode[]>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private transcripts = new Map<string, Transcript>();
  private nodes: Array<MemoryNode & { vec: number[] }> = [];

  constructor(private readonly embed: EmbedFn = lexicalTestEmbedder) {}

  async getTranscript(id: string): Promise<Transcript | undefined> {
    return this.transcripts.get(id);
  }

  get transcriptCount(): number {
    return this.transcripts.size;
  }

  get nodeCount(): number {
    return this.nodes.length;
  }

  async addTranscript(transcript: Transcript, options: ChunkOptions = {}): Promise<MemoryNode[]> {
    if (!transcript.id || typeof transcript.text !== "string") throw new Error("Transcript must have an id and text");
    this.transcripts.set(transcript.id, { ...transcript });
    const chunks = await chunkText(transcript.text, options);
    const out: MemoryNode[] = [];
    for (const c of chunks) {
      out.push(
        await this.addNode({ id: `${transcript.id}:chunk:${c.chunkIndex}`, kind: "interview", transcriptId: transcript.id, content: c.content, importance: c.importance, chunkIndex: c.chunkIndex }),
      );
    }
    return out;
  }

  async addNode(node: NewMemoryNode): Promise<MemoryNode> {
    const now = Date.now();
    const full: MemoryNode = {
      ...node,
      transcriptId: node.transcriptId ?? null,
      runId: node.runId ?? null,
      personaKey: node.personaKey ?? null,
      importance: Math.min(1, Math.max(0, node.importance)),
      createdAt: now,
      lastRetrieved: now,
    };
    this.nodes.push({ ...full, vec: await this.embed(full.content) });
    return full;
  }

  async transcriptNodes(transcriptId: string, kinds: readonly NodeKind[] = ["interview"]): Promise<MemoryNode[]> {
    return this.nodes
      .filter((n) => n.transcriptId === transcriptId && kinds.includes(n.kind))
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map(({ vec: _v, ...n }) => n);
  }

  async retrieve(focalQuery: string, options: RetrievalOptions = {}): Promise<ScoredNode[]> {
    const now = options.now ?? Date.now();
    const q = await this.embed(focalQuery);
    const scored: ScoredNode[] = [];
    for (const n of this.nodes) {
      if (!inScope(n, options)) continue;
      const recency = recencyScore(n.lastRetrieved, now);
      const relevance = cosine(q, n.vec);
      const parts = { recency, relevance, importance: n.importance };
      const { vec: _v, ...node } = n;
      scored.push({ node, score: combinedScore(parts, options.weights), ...parts });
    }
    const top = selectTop(scored, options);
    const ids = new Set(top.map((s) => s.node.id));
    for (const n of this.nodes) if (ids.has(n.id)) n.lastRetrieved = now;
    return top.map((s) => ({ ...s, node: { ...s.node, lastRetrieved: now } }));
  }
}
