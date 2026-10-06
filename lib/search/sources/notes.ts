// ShapesOS — Phase 18.2 (WS=content): Spotlight source "note".
//
// Notes are univer_docs rows of kind "note" (lib/notes/service.ts). Two kinds
// of match: the title (name ILIKE + the univer_docs title full text index)
// and the words inside the note (search_text_chunks, which
// lib/search/text-index.ts fills on every save). Visibility is the note's
// own rule: a "private" note is its maker's alone; shared notes are every
// member's (viewer+). Office docs and file contents never return notes (they
// exclude kind "note"), so a note shows once, opening the Notes app.

import { Prisma } from "@prisma/client";
import { tableSearch } from "../sql";
import type { SearchSource } from "../types";

/** Best text chunk of the note matching the query (rank + existence), over the note's search_texts row. */
const CHUNKS = `search_text_chunks c JOIN search_texts st ON st.id = c.search_text_id
       WHERE st.univer_doc_id = t.id AND st.workspace_id = t.workspace_id AND c.workspace_id = t.workspace_id`;

export const note: SearchSource = {
  kind: "note",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "univer_docs t",
      scope: ctx.userId
        ? Prisma.sql`t.workspace_id = ${ctx.workspaceId} AND t.kind = 'note' AND (t.share_state <> 'private' OR t.created_by = ${ctx.userId})`
        : Prisma.sql`t.workspace_id = ${ctx.workspaceId} AND t.kind = 'note' AND t.share_state <> 'private'`,
      select: "t.id, t.title AS title, t.folder AS sub, t.share_state AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "t.title",
      fts: { table: "univer_docs", alias: "t" },
      extra: {
        match: `EXISTS (SELECT 1 FROM ${CHUNKS} AND c.search_tsv @@ qq.tq)`,
        rank: `(SELECT max(ts_rank_cd(c.search_tsv, qq.tq)) FROM ${CHUNKS} AND c.search_tsv @@ qq.tq)`,
      },
      snippetSource: `(SELECT c.body FROM ${CHUNKS} AND c.search_tsv @@ qq.tq ORDER BY ts_rank_cd(c.search_tsv, qq.tq) DESC LIMIT 1)`,
    }),
  hit: (r) => ({
    id: r.id,
    title: r.title ?? "Untitled note",
    subtitle: r.sub ? `Note · ${r.sub}` : "Note",
    href: `/dashboard/notes?note=${encodeURIComponent(r.id)}`,
    ref: { docId: r.id },
  }),
  actions: [{ id: "summarize", tool: "read_note", instruction: "Read this note and summarize it in five bullet points." }],
};
