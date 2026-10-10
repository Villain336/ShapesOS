// ShapesOS — Phase 21A round 2 (WS=agentweb): Spotlight source "page_memory".
//
// A member's browsing memory (lib/agentweb/memory): pages an agent read FOR THEM during their
// research, kept only if they turned memory on. PERSONAL, like chat messages: only the member's own
// rows are ever returned, whatever their role, and nothing past its retention date. The answer
// engine's workspace source is Spotlight run as the asker, so the same rule applies there: a
// teammate's reading history never reaches an answer.

import { Prisma } from "@prisma/client";
import { tableSearch } from "../sql";
import type { SearchSource } from "../types";

export const pageMemory: SearchSource = {
  kind: "page_memory",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) => {
    if (!ctx.userId) return Promise.resolve([]);
    return tableSearch(tx, ctx, {
      from: "agentweb_memory t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId} AND t.user_id = ${ctx.userId} AND t.retention_until > now()`,
      select: "t.id, t.title AS title, t.url AS sub, t.origin AS extra, t.seen_count AS n, t.last_seen_at AS updated_at",
      nameMatch: "(t.title || ' ' || t.url)",
      nameSim: "t.title",
      fts: null,
      extra: {
        match: "to_tsvector('simple', t.title || ' ' || t.excerpt) @@ qq.tq",
        rank: "ts_rank_cd(to_tsvector('simple', t.title || ' ' || t.excerpt), qq.tq)",
      },
      snippetSource: "t.excerpt",
    });
  },
  hit: (r) => ({
    id: r.id,
    title: r.title ?? "Page",
    subtitle: r.sub ? r.sub.replace(/^https?:\/\//, "") : "Page you researched",
    href: `/dashboard/research?tab=memory&item=${encodeURIComponent(r.id)}`,
  }),
};
