// ShapesOS — Phase 18.1 (WS=find): the one SQL shape every table source uses.
//
//   SELECT … FROM (
//     SELECT <select>, similarity(<nameSim>, q) AS name_sim,
//            (<nameMatch>) ILIKE p AS name_hit, ts_rank_cd(<vector>, tq) AS fts_rank, …
//       FROM <from> CROSS JOIN (SELECT <tsquery> AS tq) qq
//      WHERE <scope> AND ((<nameMatch>) ILIKE p OR <vector> @@ tq OR <orMatch>)
//      ORDER BY <pre-score> DESC, updated_at DESC, id LIMIT n
//   ) m
//
// <scope> always carries the tenant predicate (workspace_id = $ws) and the
// source's own visibility rule; the caller also runs inside
// withWorkspaceScope, so FORCE-RLS tables are filtered by Postgres too.
// Constant SQL fragments come from the source definitions (never from the
// request); every user value is a bound parameter.

import { Prisma } from "@prisma/client";
import { ftsVector, type FtsTable } from "./fts";
import { RANK_WEIGHTS } from "./rank";
import type { SearchCtx, SourceRow, Tx } from "./types";

const raw = Prisma.raw;

export interface TableSpec {
  /** e.g. "crm_leads t" (+ joins). */
  from: string;
  /** Tenant + visibility predicate (MUST include the workspace_id filter). */
  scope: Prisma.Sql;
  /** "t.id, … AS title, … AS sub, … AS extra, … AS n, t.updated_at AS updated_at" */
  select: string;
  /** Expression the name ILIKE runs on (null = this source has no name match). */
  nameMatch: string | null;
  /** Expression for trigram similarity (defaults to nameMatch). */
  nameSim?: string | null;
  /** The indexed full-text document (lib/search/fts.ts), with the alias used in `from`. */
  fts?: { table: FtsTable; alias: string } | null;
  /** Extra OR'ed match + its rank (e.g. ticket messages). Uses `qq.tq`. */
  extra?: { match: string; rank: string } | null;
  /** Text to build a snippet from (an expression over the inner row). */
  snippetSource?: string | null;
  /** Extra output columns of `select` to pass through (e.g. "lead_id"). */
  passthrough?: readonly string[];
}

/** websearch syntax in both configs, OR'ed. */
export function tsQuery(fts: string): Prisma.Sql {
  return Prisma.sql`(websearch_to_tsquery('simple', ${fts}) || websearch_to_tsquery('english', ${fts}))`;
}

/** Snippet marks: ⟦match⟧ (the palette renders them as emphasis; React escapes the rest). */
export const HEADLINE_OPTS = "MaxFragments=1, MaxWords=18, MinWords=6, ShortWord=2, StartSel=⟦, StopSel=⟧";

/** A source query over one table, scored and limited in SQL (pre-score ≈ the TS blend without meaning). */
export async function tableSearch(tx: Tx, ctx: SearchCtx, spec: TableSpec): Promise<SourceRow[]> {
  const nameOn = spec.nameMatch !== null && ctx.pattern !== null;
  const simExpr = spec.nameSim === undefined ? spec.nameMatch : spec.nameSim;
  const vec = spec.fts ? ftsVector(spec.fts.table, spec.fts.alias) : null;
  const ftsOn = vec !== null && ctx.q.fts.length > 0;

  const nameSim = simExpr && ctx.q.name ? Prisma.sql`similarity(${raw(simExpr)}, ${ctx.q.name})` : raw("0::real");
  const nameHit = nameOn ? Prisma.sql`((${raw(spec.nameMatch!)}) ILIKE ${ctx.pattern})` : raw("false");
  const ftsRank = ftsOn ? Prisma.sql`ts_rank_cd(${raw(vec!)}, qq.tq)` : raw("0::real");
  const extraRank = spec.extra && ctx.q.fts ? raw(`coalesce((${spec.extra.rank}), 0)`) : raw("0::real");
  const conds: Prisma.Sql[] = [];
  if (nameOn) conds.push(Prisma.sql`(${raw(spec.nameMatch!)}) ILIKE ${ctx.pattern}`);
  if (ftsOn) conds.push(Prisma.sql`${raw(vec!)} @@ qq.tq`);
  if (spec.extra && ctx.q.fts) conds.push(raw(spec.extra.match));
  if (conds.length === 0) return [];
  const snippetSrc = spec.snippetSource ? raw(spec.snippetSource) : raw("NULL::text");
  const pass = (spec.passthrough ?? []).filter((c) => /^[a-z_]+$/.test(c)).map((c) => `, m.${c}`).join("");

  return tx.$queryRaw<SourceRow[]>`
    SELECT m.id, m.title, m.sub, m.extra, m.n, m.updated_at, m.name_sim, m.name_hit,
           greatest(m.fts_rank, m.extra_rank)::real AS fts_rank, NULL::real AS vsim${raw(pass)},
           CASE WHEN m.snippet_src IS NOT NULL AND (m.fts_rank > 0 OR m.extra_rank > 0)
                THEN ts_headline('simple', left(m.snippet_src, 4000), qq.tq, ${HEADLINE_OPTS})
           END AS snippet
      FROM (
        SELECT ${raw(spec.select)},
               ${nameSim}::real AS name_sim,
               ${nameHit} AS name_hit,
               ${ftsRank}::real AS fts_rank,
               ${extraRank}::real AS extra_rank,
               ${snippetSrc} AS snippet_src
          FROM ${raw(spec.from)}
          CROSS JOIN (SELECT ${tsQuery(ctx.q.fts || ctx.q.name)} AS tq) qq
         WHERE ${spec.scope} AND (${Prisma.join(conds, " OR ")})
         ORDER BY (${RANK_WEIGHTS.name} * (CASE WHEN ${nameHit} THEN 0.55 + 0.45 * ${nameSim} ELSE ${nameSim} END)
                 + ${RANK_WEIGHTS.text} * (greatest(${ftsRank}, ${extraRank}) / (greatest(${ftsRank}, ${extraRank}) + 0.1))) DESC,
                  updated_at DESC NULLS LAST, id
         LIMIT ${ctx.limit}
      ) m
      CROSS JOIN (SELECT ${tsQuery(ctx.q.fts || ctx.q.name)} AS tq) qq`;
}
