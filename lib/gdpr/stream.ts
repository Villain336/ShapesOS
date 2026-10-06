// ShapesOS — paged, RLS-scoped table reads for GDPR exports (Phase 4a).
//
// Rows are read a page at a time (keyset pagination on the primary key) in
// short transactions that set the tenant GUC, and serialized by Postgres
// (to_jsonb), so any column type round-trips and memory stays flat however
// large the workspace is.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { WORKSPACE_GUC } from "@/lib/substrate/memory/rls";
import { USER_GUC } from "@/lib/desktop/scope";
import { q, type ColumnInfo, type TableInfo } from "./catalog";

export const PAGE_SIZE = 500;

/**
 * Yield JSON text for each row of `table` matching `predicate` (SQL on alias
 * `t`, with $1 = scopeValue and optionally $2 = extraValue), projecting only
 * `columns`. Runs with app.workspace_id = gucWorkspaceId so RLS tables answer.
 */
export async function* scopedRows(opts: {
  table: TableInfo;
  columns: ColumnInfo[];
  predicate: string;
  params: unknown[];
  gucWorkspaceId: string | null;
  /** Phase 18.1: also set app.user_id (owner-only tables answer only to their member). */
  gucUserId?: string | null;
  pageSize?: number;
}): AsyncGenerator<string> {
  const { table, columns, predicate, params } = opts;
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const pk = table.primaryKey.length ? table.primaryKey : null;
  const pkCols = pk ? pk.map((name) => table.columns.find((c) => c.name === name)!) : [];
  const projection = columns.map((c) => `t.${q(c.name)}`).join(", ");
  const keyProjection = pkCols.map((c, i) => `t.${q(c.name)} AS "__k${i}"`).join(", ");
  const orderBy = pk ? pkCols.map((c) => `t.${q(c.name)}`).join(", ") : "t.ctid";
  let after: unknown[] | null = null;
  let offset = 0;
  for (;;) {
    const p = [...params];
    let keyset = "";
    if (pk && after) {
      const placeholders = pkCols.map((c, i) => {
        p.push(after![i]);
        return `$${p.length}::${c.type}`;
      });
      keyset = ` AND (${pkCols.map((c) => `t.${q(c.name)}`).join(", ")}) > (${placeholders.join(", ")})`;
    }
    const limitClause = pk ? `LIMIT ${pageSize}` : `LIMIT ${pageSize} OFFSET ${offset}`;
    const inner = `SELECT ${projection || "1 AS \"__empty\""}${keyProjection ? `, ${keyProjection}` : ""}
                     FROM ${q(table.name)} t WHERE (${predicate})${keyset} ORDER BY ${orderBy} ${limitClause}`;
    const strip = pkCols.map((_, i) => ` - '__k${i}'`).join("") + (projection ? "" : " - '__empty'");
    const keys = pkCols.map((_, i) => `x."__k${i}"::text AS "k${i}"`).join(", ");
    const sql = `SELECT (to_jsonb(x)${strip})::text AS j${keys ? `, ${keys}` : ""} FROM (${inner}) x`;
    const rows = await inScope(opts.gucWorkspaceId, opts.gucUserId ?? null, (tx) =>
      tx.$queryRawUnsafe<Record<string, string>[]>(sql, ...p),
    );
    for (const r of rows) yield r.j!;
    if (rows.length < pageSize) return;
    if (pk) {
      const last = rows[rows.length - 1]!;
      after = pkCols.map((_, i) => last[`k${i}`]);
    } else {
      offset += rows.length;
    }
  }
}

/** Run fn in a short transaction with the tenant GUC set (or unset). */
export async function inScope<T>(
  workspaceId: string | null,
  userId: string | null,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      if (workspaceId) await tx.$queryRaw`SELECT set_config(${WORKSPACE_GUC}, ${workspaceId}, true)`;
      // Phase 18.1 (WS=desk): the person GUC for owner-only tables (lib/desktop/scope.ts).
      if (userId) await tx.$queryRaw`SELECT set_config(${USER_GUC}, ${userId}, true)`;
      return fn(tx);
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

/** A ReadableStream of UTF-8 text from an async generator of strings. */
export function textStream(gen: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Batch small chunks so the stream isn't one enqueue per row.
        let buf = "";
        while (buf.length < 64 * 1024) {
          const { value, done } = await gen.next();
          if (done) {
            if (buf) controller.enqueue(enc.encode(buf));
            controller.close();
            return;
          }
          buf += value;
        }
        controller.enqueue(enc.encode(buf));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}
