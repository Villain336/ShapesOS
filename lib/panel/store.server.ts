// ShapesOS — Phase 19B (WS=panel): the memory stream over Postgres + pgvector.
// Commercial layer (entitlement dress_rehearsal). See lib/panel/README.md.
//
// PgMemoryStore implements lib/panel/memory.ts MemoryStore for one workspace:
// panel_transcripts (verbatim) + panel_memory_nodes (content, importance,
// recency, a 384-d embedding). Relevance = 1 − pgvector cosine distance; the
// recency / importance / weights / scope rules are the same pure functions
// the in-memory store uses (combinedScore, inScope, selectTop), so both
// stores rank identically. Every query runs under withWorkspaceScope (FORCE
// RLS; no GUC = no rows). The embedder is injected; the default is the local
// MiniLM model (lib/substrate/memory/embed.ts), imported lazily so routes
// that only list rows never load the model runtime.

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  chunkText,
  combinedScore,
  inScope,
  recencyScore,
  selectTop,
  type ChunkOptions,
  type EmbedFn,
  type MemoryNode,
  type MemoryStore,
  type NewMemoryNode,
  type NodeKind,
  type RetrievalOptions,
  type ScoredNode,
  type Transcript,
} from "./memory";

/** The production embedder: local MiniLM (lazy import). */
export const miniLmEmbed: EmbedFn = async (text) => {
  const { embedText } = await import("@/lib/substrate/memory/embed");
  return embedText(text);
};

function vectorLiteral(vec: readonly number[]): string {
  return `[${vec.map((v) => (Number.isFinite(v) ? v : 0)).join(",")}]`;
}

/** Candidate rows read per retrieval (scope-filtered, most similar first). */
const CANDIDATES = 2000;

interface NodeRow {
  node_key: string;
  kind: string;
  transcript_id: string | null;
  run_id: string | null;
  persona_key: string | null;
  lens: string | null;
  content: string;
  importance: number;
  chunk_index: number;
  created_at: Date;
  last_retrieved_at: Date;
  relevance: number | null;
}

function toNode(r: NodeRow): MemoryNode {
  return {
    id: r.node_key,
    kind: r.kind as NodeKind,
    transcriptId: r.transcript_id,
    runId: r.run_id,
    personaKey: r.persona_key,
    lens: r.lens,
    content: r.content,
    importance: r.importance,
    chunkIndex: r.chunk_index,
    createdAt: r.created_at.getTime(),
    lastRetrieved: r.last_retrieved_at.getTime(),
  };
}

export class PgMemoryStore implements MemoryStore {
  private readonly embed: EmbedFn;
  private readonly createdBy: string;

  constructor(
    readonly workspaceId: string,
    opts: { embed?: EmbedFn; createdBy?: string } = {},
  ) {
    this.embed = opts.embed ?? miniLmEmbed;
    this.createdBy = opts.createdBy ?? "system";
  }

  async getTranscript(id: string): Promise<Transcript | undefined> {
    const row = await withWorkspaceScope(this.workspaceId, (tx) => tx.panelTranscript.findFirst({ where: { id, workspaceId: this.workspaceId } }));
    if (!row) return undefined;
    return { id: row.id, text: row.text, title: row.title, ...(row.interviewee ? { interviewee: row.interviewee } : {}), createdAt: row.createdAt.getTime() };
  }

  /**
   * Store a transcript verbatim (creating its row when it doesn't exist yet)
   * and its chunks as interview nodes with embeddings.
   */
  async addTranscript(transcript: Transcript, options: ChunkOptions = {}, meta: { source?: string; sourceRef?: string | null } = {}): Promise<MemoryNode[]> {
    if (!transcript.id || typeof transcript.text !== "string") throw new Error("Transcript must have an id and text");
    const chunks = await chunkText(transcript.text, options);
    const vecs = await Promise.all(chunks.map((c) => this.embed(c.content)));
    await withWorkspaceScope(this.workspaceId, async (tx) => {
      const exists = await tx.panelTranscript.findFirst({ where: { id: transcript.id, workspaceId: this.workspaceId }, select: { id: true } });
      if (!exists) {
        await tx.panelTranscript.create({
          data: {
            id: transcript.id,
            workspaceId: this.workspaceId,
            title: (transcript.title ?? "Interview").slice(0, 200),
            interviewee: transcript.interviewee?.slice(0, 120) ?? null,
            source: meta.source ?? "upload",
            sourceRef: meta.sourceRef ?? null,
            text: transcript.text,
            charCount: transcript.text.length,
            createdBy: this.createdBy,
          },
        });
      }
    });
    const out: MemoryNode[] = [];
    for (const [i, c] of chunks.entries()) {
      out.push(await this.insertNode({ id: `${transcript.id}:chunk:${c.chunkIndex}`, kind: "interview", transcriptId: transcript.id, content: c.content, importance: c.importance, chunkIndex: c.chunkIndex }, vecs[i]!));
    }
    return out;
  }

  async addNode(node: NewMemoryNode): Promise<MemoryNode> {
    return this.insertNode(node, await this.embed(node.content));
  }

  private async insertNode(node: NewMemoryNode, vec: number[]): Promise<MemoryNode> {
    const importance = Math.min(1, Math.max(0, node.importance));
    const rows = await withWorkspaceScope(this.workspaceId, (tx) =>
      tx.$queryRaw<NodeRow[]>`
        INSERT INTO "panel_memory_nodes" ("id", "workspace_id", "kind", "transcript_id", "run_id", "persona_key", "lens", "node_key", "content", "importance", "chunk_index", "embedding")
        VALUES (${randomUUID()}, ${this.workspaceId}, ${node.kind}, ${node.transcriptId ?? null}, ${node.runId ?? null}, ${node.personaKey ?? null}, ${node.lens ?? null},
                ${node.id}, ${node.content}, ${importance}, ${node.chunkIndex}, ${vectorLiteral(vec)}::vector)
        ON CONFLICT ("workspace_id", "node_key") DO UPDATE SET "content" = EXCLUDED."content", "importance" = EXCLUDED."importance", "embedding" = EXCLUDED."embedding"
        RETURNING "node_key", "kind", "transcript_id", "run_id", "persona_key", "lens", "content", "importance", "chunk_index", "created_at", "last_retrieved_at", NULL::float8 AS "relevance"`,
    );
    return toNode(rows[0]!);
  }

  async transcriptNodes(transcriptId: string, kinds: readonly NodeKind[] = ["interview"]): Promise<MemoryNode[]> {
    const rows = await withWorkspaceScope(this.workspaceId, (tx) =>
      tx.$queryRaw<NodeRow[]>`
        SELECT "node_key", "kind", "transcript_id", "run_id", "persona_key", "lens", "content", "importance", "chunk_index", "created_at", "last_retrieved_at", NULL::float8 AS "relevance"
        FROM "panel_memory_nodes"
        WHERE "workspace_id" = ${this.workspaceId} AND "transcript_id" = ${transcriptId} AND "kind" IN (${Prisma.join([...kinds])})
        ORDER BY "chunk_index" ASC, "created_at" ASC`,
    );
    return rows.map(toNode);
  }

  async retrieve(focalQuery: string, options: RetrievalOptions = {}): Promise<ScoredNode[]> {
    const now = options.now ?? Date.now();
    const q = vectorLiteral(await this.embed(focalQuery));
    const conds: Prisma.Sql[] = [Prisma.sql`"workspace_id" = ${this.workspaceId}`];
    if (options.kinds) conds.push(Prisma.sql`"kind" IN (${Prisma.join([...options.kinds])})`);
    const scoped = options.transcriptIds !== undefined || options.runId !== undefined || options.personaKey !== undefined;
    if (scoped) {
      const parts: Prisma.Sql[] = [];
      if (options.transcriptIds !== undefined && options.transcriptIds.length > 0) parts.push(Prisma.sql`"transcript_id" IN (${Prisma.join([...options.transcriptIds])})`);
      if (options.runId !== undefined || options.personaKey !== undefined) {
        const walk: Prisma.Sql[] = [Prisma.sql`"kind" IN ('observation', 'thought', 'verdict')`];
        if (options.runId !== undefined) walk.push(Prisma.sql`"run_id" = ${options.runId}`);
        if (options.personaKey !== undefined) walk.push(Prisma.sql`"persona_key" = ${options.personaKey}`);
        parts.push(Prisma.sql`(${Prisma.join(walk, " AND ")})`);
      }
      if (parts.length === 0) return [];
      conds.push(Prisma.sql`(${Prisma.join(parts, " OR ")})`);
    }
    const rows = await withWorkspaceScope(this.workspaceId, (tx) =>
      tx.$queryRaw<NodeRow[]>`
        SELECT "node_key", "kind", "transcript_id", "run_id", "persona_key", "lens", "content", "importance", "chunk_index", "created_at", "last_retrieved_at",
               CASE WHEN "embedding" IS NULL THEN 0 ELSE 1 - ("embedding" <=> ${q}::vector) END AS "relevance"
        FROM "panel_memory_nodes"
        WHERE ${Prisma.join(conds, " AND ")}
        ORDER BY "relevance" DESC NULLS LAST
        LIMIT ${CANDIDATES}`,
    );
    const scoredAll: ScoredNode[] = [];
    for (const r of rows) {
      const node = toNode(r);
      if (!inScope(node, options)) continue;
      const rel = Number(r.relevance);
      const relevance = Number.isFinite(rel) ? Math.min(1, Math.max(0, rel)) : 0;
      const parts = { recency: recencyScore(node.lastRetrieved, now), relevance, importance: node.importance };
      scoredAll.push({ node, score: combinedScore(parts, options.weights), ...parts });
    }
    const top = selectTop(scoredAll, options);
    if (top.length > 0) {
      const keys = top.map((s) => s.node.id);
      await withWorkspaceScope(this.workspaceId, (tx) =>
        tx.$executeRaw`UPDATE "panel_memory_nodes" SET "last_retrieved_at" = ${new Date(now)} WHERE "workspace_id" = ${this.workspaceId} AND "node_key" IN (${Prisma.join(keys)})`,
      );
    }
    return top.map((s) => ({ ...s, node: { ...s.node, lastRetrieved: now } }));
  }
}
