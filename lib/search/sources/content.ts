// ShapesOS — Spotlight source: the text INSIDE workspace files and Office
// docs (lib/search/text-index.ts extracts and chunks it on upload / save).
//
// Two kinds of match over the chunks, both index-backed:
//   text     search_tsv @@ query            (GIN, generated column)
//   meaning  embedding <=> query embedding   (HNSW cosine, partial index;
//            only when semantic search runs — the query was embedded)
// The best chunk per record wins; one hit per file / doc, with a snippet
// from the best text chunk (or the closest chunk for a meaning-only match).
// Viewer reads (Files and Office pages); trashed files never show. Phase 18.2:
// notes (univer_docs kind "note") are the "note" source's, never matched here.

import { Prisma } from "@prisma/client";
import { HEADLINE_OPTS, tsQuery } from "../sql";
import { RANK_WEIGHTS } from "../rank";
import type { SearchSource, SourceRow } from "../types";

/** Nearest chunks considered per query (before grouping by record). */
export const SEMANTIC_CANDIDATES = 40;

export const fileContent: SearchSource = {
  kind: "file_content",
  minRole: "viewer",
  modes: ["text", "meaning"],
  query: (tx, ctx) => {
    const ws = ctx.workspaceId;
    const text = ctx.q.fts || ctx.q.name;
    const semantic = ctx.vector
      ? Prisma.sql`
        UNION ALL
        SELECT s.search_text_id, s.id AS chunk_id, 0::real AS fts_rank, s.vsim
          FROM (
            SELECT c.search_text_id, c.id, (1 - (c.embedding <=> ${ctx.vector}::vector))::real AS vsim
              FROM search_text_chunks c
             WHERE c.workspace_id = ${ws} AND c.embedding IS NOT NULL
             ORDER BY c.embedding <=> ${ctx.vector}::vector
             LIMIT ${SEMANTIC_CANDIDATES}
          ) s`
      : Prisma.empty;
    // -excluded words drop the whole record (any chunk), for text AND meaning matches.
    const excluded = ctx.q.excluded.length
      ? Prisma.sql`AND NOT EXISTS (SELECT 1 FROM search_text_chunks x
            WHERE x.search_text_id = b.search_text_id AND x.workspace_id = ${ws}
              AND x.search_tsv @@ ${tsQuery(ctx.q.excluded.join(" or "))})`
      : Prisma.empty;
    // Phase 21B (WS=drive): text inside a file in someone's private home is theirs alone to find.
    const ownerFilter = ctx.userId
      ? Prisma.sql`AND (f.owner_user_id IS NULL OR f.owner_user_id = ${ctx.userId})`
      : Prisma.sql`AND f.owner_user_id IS NULL`;
    return tx.$queryRaw<SourceRow[]>`
      WITH qq AS (SELECT ${tsQuery(text)} AS tq),
      cand AS (
        SELECT c.search_text_id, c.id AS chunk_id, ts_rank_cd(c.search_tsv, qq.tq)::real AS fts_rank, NULL::real AS vsim
          FROM search_text_chunks c CROSS JOIN qq
         WHERE c.workspace_id = ${ws} AND c.search_tsv @@ qq.tq
        ${semantic}
      ),
      best AS (
        SELECT search_text_id,
               max(fts_rank) AS fts_rank,
               max(vsim) AS vsim,
               (array_agg(chunk_id ORDER BY fts_rank DESC) FILTER (WHERE fts_rank > 0))[1] AS text_chunk,
               (array_agg(chunk_id ORDER BY vsim DESC NULLS LAST) FILTER (WHERE vsim IS NOT NULL))[1] AS meaning_chunk
          FROM cand
         GROUP BY search_text_id
      ),
      hits AS (
        SELECT coalesce(f.id, d.id) AS id,
               coalesce(f.filename, d.title) AS title,
               CASE WHEN st.source = 'file' THEN f.logical_path ELSE 'Office · ' || d.kind END AS sub,
               st.source AS extra,
               NULL::int AS n,
               coalesce(f.created_at, d.updated_at) AS updated_at,
               similarity(coalesce(f.filename, d.title), ${ctx.q.name})::real AS name_sim,
               false AS name_hit,
               b.fts_rank, b.vsim, b.text_chunk, b.meaning_chunk
          FROM best b
          JOIN search_texts st ON st.id = b.search_text_id AND st.workspace_id = ${ws}
          LEFT JOIN workspace_files f ON f.id = st.file_id AND f.workspace_id = st.workspace_id AND f.trashed_at IS NULL
               ${ownerFilter}
          LEFT JOIN univer_docs d ON d.id = st.univer_doc_id AND d.workspace_id = st.workspace_id
         WHERE ((st.source = 'file' AND f.id IS NOT NULL) OR (st.source = 'doc' AND d.id IS NOT NULL AND d.kind <> 'note')) ${excluded}
         ORDER BY (${RANK_WEIGHTS.text} * (coalesce(b.fts_rank, 0) / (coalesce(b.fts_rank, 0) + 0.1))
                 + ${RANK_WEIGHTS.meaning} * greatest(coalesce(b.vsim, 0) - 0.25, 0) / 0.75) DESC,
                  updated_at DESC, id
         LIMIT ${ctx.limit}
      )
      SELECT h.id, h.title, h.sub, h.extra, h.n, h.updated_at, h.name_sim, h.name_hit, h.fts_rank, h.vsim,
             CASE
               WHEN h.text_chunk IS NOT NULL THEN
                 (SELECT ts_headline('simple', left(c.body, 4000), qq.tq, ${HEADLINE_OPTS}) FROM search_text_chunks c WHERE c.id = h.text_chunk)
               WHEN h.meaning_chunk IS NOT NULL THEN
                 (SELECT left(regexp_replace(c.body, '[[:space:]]+', ' ', 'g'), 160) FROM search_text_chunks c WHERE c.id = h.meaning_chunk)
             END AS snippet
        FROM hits h CROSS JOIN qq`;
  },
  hit: (r) =>
    r.extra === "doc"
      ? { id: r.id, title: r.title ?? "Untitled", subtitle: r.sub, href: `/dashboard/office?open=${encodeURIComponent(r.id)}`, ref: { docId: r.id } }
      : { id: r.id, title: r.title ?? "File", subtitle: r.sub, href: `/dashboard/files?file=${encodeURIComponent(r.id)}`, ref: { fileId: r.id } },
  actions: [{ id: "summarize", tool: "create_content_draft", instruction: "Read this and summarize it in five bullet points." }],
};
