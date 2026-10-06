// ShapesOS — global record search: Spotlight (Phase 4a; Phase 18.1).
//
// ONE search for people (⌘K, GET /api/search/records) and agents (the
// search_workspace tool, lib/search/tool.ts): same function, same
// permissions, same ranking.
//
// Sources: lib/search/sources (a registry; one file per area — how to add a
// source is written at the top of sources/index.ts). Every source runs in
// ONE withWorkspaceScope transaction, so FORCE-RLS tables are filtered by
// Postgres itself, and every statement also carries an explicit
// workspace_id predicate for the non-RLS tables.
//
// Three kinds of match, blended by lib/search/rank.ts:
//   name     ILIKE '%q%' over the expressions indexed with pg_trgm GIN
//            (migration 20261005300100_phase4a_record_search), scored by
//            trigram similarity;
//   text     Postgres full text — websearch_to_tsquery over 'simple' ||
//            'english' — on GIN expression indexes (lib/search/fts.ts,
//            migration 20261020200100_p18_find_spotlight), incl. the text
//            inside uploaded files and Office docs (search_text_chunks);
//   meaning  pgvector cosine over MiniLM embeddings of that text
//            (lib/search/semantic.ts), when the embedder is warm.
//
// Permissions are law: a source runs only for roles at or above its
// minRole (the read gate of the page its results open), and each source's
// SQL applies its own visibility rule (personal chats, draft apps).

import type { WorkspaceRole } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { roleAtLeast } from "@/lib/authz";
import { RECORD_KINDS, type MatchMode, type RecordKind } from "./kinds";
import { likePattern, normalizeQuery, parseQuery, MAX_QUERY_LENGTH, MIN_QUERY_LENGTH, type ParsedQuery } from "./query";
import { blend, MIN_SCORE, orderHits } from "./rank";
import { queryVector, type SemanticStatus } from "./semantic";
import { SOURCE_BY_KIND, SOURCES } from "./sources";
import type { HitFields, SearchCtx, SourceAction, Tx } from "./types";

export { RECORD_KINDS, RECORD_KIND_LABELS, type RecordKind } from "./kinds";
export { likePattern, normalizeQuery, parseQuery, MAX_QUERY_LENGTH, MIN_QUERY_LENGTH };

/** Minimum role per source (from the registry). Raise one there to hide it from lower roles. */
export const RECORD_MIN_ROLE: Record<RecordKind, WorkspaceRole> = Object.fromEntries(
  SOURCES.map((s) => [s.kind, s.minRole]),
) as Record<RecordKind, WorkspaceRole>;

export interface RecordHit {
  kind: RecordKind;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
  /** Blended rank score (lib/search/rank.ts). */
  score: number;
  /** How it matched: name, text, meaning. */
  match: MatchMode[];
  /** A short excerpt around the match, with ⟦marks⟧ (text inside records). */
  snippet: string | null;
  /** Ids "Ask about this" can attach (a file, an Office doc, a lead, a thread). */
  ref?: HitFields["ref"];
  /** "Act on it": the record's primary agent actions (tool + instruction). */
  actions?: readonly SourceAction[];
}

export interface SearchOptions {
  /** Results per record type (default 5, max 20). */
  perKind?: number;
  /** Restrict to these record types (intersected with kind: filters typed in the query). */
  kinds?: readonly RecordKind[];
  /** The person searching: personal records (assistant chats) are theirs only. */
  userId?: string | null;
  /** Meaning-search: "auto" (default — when the embedder is warm), "wait" (load it), "off". */
  semantic?: "auto" | "wait" | "off";
}

export interface SearchResult {
  query: ParsedQuery | null;
  hits: RecordHit[];
  semantic: SemanticStatus;
}

/**
 * Spotlight: search the workspace's records as a member with `role`.
 * Returns hits grouped by kind (the group with the best match first), best
 * match first within a group.
 */
export async function spotlight(
  workspaceId: string,
  role: WorkspaceRole | null | undefined,
  rawQuery: unknown,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const q = parseQuery(rawQuery);
  if (!q || !workspaceId || !role) return { query: q, hits: [], semantic: "skipped" };
  const perKind = Math.min(Math.max(Math.floor(opts.perKind ?? 5), 1), 20);
  const wanted = new Set<RecordKind>(q.kinds.length ? q.kinds : RECORD_KINDS);
  if (opts.kinds) for (const k of [...wanted]) if (!opts.kinds.includes(k)) wanted.delete(k);
  const sources = RECORD_KINDS.filter((k) => wanted.has(k))
    .map((k) => SOURCE_BY_KIND.get(k))
    .filter((s): s is NonNullable<typeof s> => !!s && roleAtLeast(role, s.minRole));
  if (sources.length === 0) return { query: q, hits: [], semantic: "skipped" };

  const wantsMeaning = sources.some((s) => s.modes.includes("meaning"));
  const sem =
    opts.semantic === "off" || !wantsMeaning
      ? { vector: null, status: (wantsMeaning ? "off" : "skipped") as SemanticStatus }
      : await queryVector([...q.terms, ...q.phrases].join(" ") || q.name, { wait: opts.semantic === "wait" });

  const ctx: SearchCtx = {
    workspaceId,
    role,
    userId: opts.userId ?? null,
    q,
    pattern: q.name ? likePattern(q.name) : null,
    limit: perKind,
    vector: sem.vector,
  };

  const hits = await withWorkspaceScope(workspaceId, async (tx) => {
    const out: RecordHit[] = [];
    for (const source of sources) {
      const rows = await source.query(tx as Tx, ctx);
      for (const r of rows) {
        const fields = source.hit(r);
        const scored = blend({
          title: fields.title,
          query: q.name,
          nameSim: Number(r.name_sim ?? 0),
          nameHit: !!r.name_hit,
          ftsRank: Number(r.fts_rank ?? 0),
          vsim: r.vsim === null || r.vsim === undefined ? null : Number(r.vsim),
        });
        if (scored.score < MIN_SCORE) continue;
        out.push({
          kind: source.kind,
          ...fields,
          score: scored.score,
          match: scored.match,
          snippet: r.snippet ? r.snippet.replace(/\s+/g, " ").trim().slice(0, 240) : null,
          ...(source.actions?.length ? { actions: source.actions } : {}),
          updatedAt: r.updated_at,
        } as RecordHit & { updatedAt: Date | null });
      }
    }
    return out;
  });
  const ordered = orderHits(hits as Array<RecordHit & { updatedAt: Date | null }>).map(({ updatedAt: _u, ...h }) => h as RecordHit);
  return { query: q, hits: ordered, semantic: sem.status };
}

/**
 * Back-compatible entry point (Phase 4a callers): the hits only. Results
 * are grouped by kind, the best group first.
 */
export async function searchRecords(
  workspaceId: string,
  role: WorkspaceRole | null | undefined,
  rawQuery: unknown,
  opts: SearchOptions = {},
): Promise<RecordHit[]> {
  if (!normalizeQuery(rawQuery)) return [];
  return (await spotlight(workspaceId, role, rawQuery, opts)).hits;
}
