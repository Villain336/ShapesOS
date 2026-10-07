// ShapesOS — Phase 19B (WS=engine): a resident's memory stream during a run.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// The generative-agents memory stream the panel uses (lib/panel/memory.ts),
// on SIM time: observations ("saw the billboard", "Ana told me about it")
// and nightly reflections are scored by the panel's own recency × importance
// × relevance (recencyScore, heuristicImportanceScorer, combinedScore,
// tokenize) — with recency measured in simulated hours instead of the wall
// clock, so the same seed retrieves the same memories (determinism). The
// panel's PgMemoryStore keeps interview memory; this stream lives for one
// run and is persisted as sim_events (observations, reflections).

import { combinedScore, heuristicImportanceScorer, recencyScore, tokenize, type MemoryNode } from "@/lib/panel/memory";

export interface ResidentMemoryNode extends Pick<MemoryNode, "id" | "kind" | "content" | "importance"> {
  /** Sim minute it was written. */
  at: number;
  lastRetrieved: number;
}

const MS_PER_MINUTE = 60_000;

export class ResidentMemory {
  private nodes: ResidentMemoryNode[] = [];
  private seq = 0;

  constructor(private readonly residentId: string) {}

  get size(): number {
    return this.nodes.length;
  }

  add(kind: "observation" | "reflection", content: string, at: number): ResidentMemoryNode {
    const node: ResidentMemoryNode = { id: `${this.residentId}:m${++this.seq}`, kind, content, importance: heuristicImportanceScorer(content), at, lastRetrieved: at };
    this.nodes.push(node);
    return node;
  }

  /** Nodes written in [from, to) (sim minutes), oldest first. */
  between(from: number, to: number): ResidentMemoryNode[] {
    return this.nodes.filter((n) => n.at >= from && n.at < to);
  }

  /** Top-k by the panel's combined score (recency on sim time); ties keep the older first. */
  retrieve(query: string, now: number, k = 5): ResidentMemoryNode[] {
    const q = new Set(tokenize(query));
    const scored = this.nodes.map((n, i) => {
      const toks = tokenize(n.content);
      const shared = toks.filter((t) => q.has(t)).length;
      const relevance = q.size && toks.length ? shared / Math.sqrt(q.size * toks.length) : 0;
      const recency = recencyScore(n.lastRetrieved * MS_PER_MINUTE, now * MS_PER_MINUTE);
      return { n, i, score: combinedScore({ recency, relevance: Math.min(1, relevance), importance: n.importance }) };
    });
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    const top = scored.slice(0, k).map((s) => s.n);
    for (const n of top) n.lastRetrieved = now;
    return top;
  }
}
