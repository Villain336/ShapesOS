// ShapesOS — shared "claim the next row" helper (Phase 8).
//
// The clip-job pattern (app/api/clipper/_pipeline.ts) generalised: ONE
// statement, run in a transaction with the tenant GUC pinned,
//
//   UPDATE <table> SET <set>
//    WHERE id IN (SELECT id FROM <table>
//                  WHERE workspace_id = $ws AND (<where>)
//                  ORDER BY <orderBy>
//                  FOR UPDATE SKIP LOCKED
//                  LIMIT <limit>)
//   RETURNING <returning>
//
// so exactly one claimer wins each row, even with many workers polling the
// same table: a row another transaction has locked is skipped, not waited
// on. Used by the clipper pipeline and the agent job queue
// (lib/agents/queue/store.ts).
//
// The table name and the SQL fragments are TRUSTED constants from the
// caller (never user input); values inside the fragments are bound
// parameters (Prisma.sql templates).

import { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export interface ClaimRowsOptions {
  workspaceId: string;
  /** Table name (a trusted constant: [a-z_]+). */
  table: string;
  /** Candidate predicate inside the locked sub-select (unqualified columns). */
  where: Prisma.Sql;
  orderBy: Prisma.Sql;
  /** The SET list applied to every claimed row. */
  set: Prisma.Sql;
  returning: Prisma.Sql;
  limit?: number;
}

const TABLE_RE = /^[a-z_][a-z0-9_]*$/;

/** Build the claim statement (PURE; exported for tests). */
export function claimRowsSql(opts: ClaimRowsOptions): Prisma.Sql {
  if (!TABLE_RE.test(opts.table)) throw new Error(`claimRows: invalid table name "${opts.table}"`);
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 1), 1000));
  const table = Prisma.raw(`"${opts.table}"`);
  return Prisma.sql`
    UPDATE ${table}
       SET ${opts.set}
     WHERE "id" IN (
       SELECT sub."id" FROM ${table} AS sub
        WHERE sub."workspace_id" = ${opts.workspaceId} AND (${opts.where})
        ORDER BY ${opts.orderBy}
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit})
    RETURNING ${opts.returning}`;
}

/** Claim up to `limit` rows of one workspace atomically; [] when none are due. */
export async function claimRows<T>(opts: ClaimRowsOptions): Promise<T[]> {
  const sql = claimRowsSql(opts);
  return withWorkspaceScope(opts.workspaceId, (tx) => tx.$queryRaw<T[]>(sql));
}

/** Current UTC time as a timestamp(3) without time zone (Prisma's DateTime columns). */
export const SQL_NOW_UTC = Prisma.sql`(now() AT TIME ZONE 'UTC')`;
