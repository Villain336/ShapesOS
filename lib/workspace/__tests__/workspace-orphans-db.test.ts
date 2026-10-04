// ShapesOS — Phase 4a: deleting a workspace leaves no rows behind.
//
// The table list is derived from the live catalog, never hand-maintained, so
// a table added by a future migration is covered automatically:
//   1. guard   every table with a workspace_id column has a foreign key to
//              workspaces with ON DELETE CASCADE (the one deliberate exception
//              is workspace_lifecycle_events, the record that survives).
//   2. proof   a workspace gets one synthesized row in EVERY table with a
//              workspace_id (parents created on demand through their foreign
//              keys), is deleted through the real delete path, and every
//              table is then checked for leftovers — under RLS scope, so
//              FORCE-RLS tables are counted too.
// Run it as the least-privilege app role (RLS + grants are the real ones):
//   DATABASE_URL=postgresql://<app_role>:…/<db> npx tsx --test lib/workspace/__tests__/workspace-orphans-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createWorkspaceForUser, deleteWorkspace, KEEP_ON_WORKSPACE_DELETE } from "../lifecycle";
import { postEntry } from "@/lib/ops/accounting";

type Tx = Prisma.TransactionClient;

const RUN = randomUUID().slice(0, 8);
const OWNER = `p4-orphan-owner-${RUN}`;
const SELF = {} as NodeJS.ProcessEnv;

interface Column {
  col: string;
  type: string;
  typtype: string;
  typid: number;
  notnull: boolean;
  hasdef: boolean;
}
interface ForeignKey {
  col: string;
  reftable: string;
  refcol: string;
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

async function workspaceTables(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ t: string }[]>`
    SELECT c.relname AS t
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     ORDER BY c.relname`;
  return rows.map((r) => r.t);
}

const columnCache = new Map<string, Column[]>();
async function columns(table: string): Promise<Column[]> {
  const hit = columnCache.get(table);
  if (hit) return hit;
  const rows = await prisma.$queryRawUnsafe<Column[]>(
    `SELECT a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type, t.typtype::text AS typtype,
            a.atttypid::int AS typid, a.attnotnull AS notnull,
            (a.atthasdef OR a.attidentity <> '' OR a.attgenerated <> '') AS hasdef
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    `public.${q(table)}`,
  );
  columnCache.set(table, rows);
  return rows;
}

const fkCache = new Map<string, ForeignKey[]>();
async function foreignKeys(table: string): Promise<ForeignKey[]> {
  const hit = fkCache.get(table);
  if (hit) return hit;
  const rows = await prisma.$queryRawUnsafe<ForeignKey[]>(
    `SELECT a.attname AS col, cf.relname AS reftable, af.attname AS refcol
       FROM pg_constraint k
       JOIN pg_class cf ON cf.oid = k.confrelid
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
       JOIN pg_attribute af ON af.attrelid = k.confrelid AND af.attnum = k.confkey[1]
      WHERE k.contype = 'f' AND k.conrelid = $1::regclass`,
    `public.${q(table)}`,
  );
  fkCache.set(table, rows);
  return rows;
}

const enumCache = new Map<number, string>();
async function firstEnumLabel(typid: number): Promise<string> {
  const hit = enumCache.get(typid);
  if (hit !== undefined) return hit;
  const rows = await prisma.$queryRaw<{ l: string }[]>`
    SELECT enumlabel AS l FROM pg_enum WHERE enumtypid = ${typid}::oid ORDER BY enumsortorder LIMIT 1`;
  const label = rows[0]?.l ?? "";
  enumCache.set(typid, label);
  return label;
}

let counter = 0;
/** A value for a column of this type, as text (cast to the column type in SQL). */
async function valueFor(c: Column): Promise<string> {
  counter += 1;
  const t = c.type;
  if (t.endsWith("[]")) return "{}";
  if (c.typtype === "e") return firstEnumLabel(c.typid);
  if (/^(jsonb|json)$/.test(t)) return "{}";
  if (/^(integer|bigint|smallint|numeric|real|double precision)/.test(t)) return String(counter);
  if (t === "boolean") return "false";
  if (/^timestamp/.test(t)) return new Date().toISOString();
  if (t === "date") return new Date().toISOString().slice(0, 10);
  if (t === "uuid") return randomUUID();
  if (t === "bytea") return "\\x00";
  if (t === "inet") return "127.0.0.1";
  if (t === "interval") return "1 day";
  const vec = /^vector\((\d+)\)$/.exec(t);
  if (vec) return `[${Array.from({ length: Number(vec[1]) }, () => "0").join(",")}]`;
  if (/^(text|character varying|character|citext)/.test(t)) {
    const v = `o${counter}${RUN}`;
    const len = /\((\d+)\)/.exec(t);
    return len ? v.slice(0, Number(len[1])) : v;
  }
  throw new Error(`no synthetic value for type ${t} (${c.col})`);
}

// Columns whose CHECK constraint only accepts specific values (a synthetic
// string never passes them), keyed by table.
const FIXED_VALUES: Record<string, Record<string, string>> = {
  ops_accounting_links: { provider: "quickbooks" },
  ops_accounting_exports: { provider: "quickbooks" },
};

// Committed rows per table (one is enough; parents are shared).
const made = new Map<string, Record<string, unknown>>();
// Rows created in tables WITHOUT workspace_id (global parents), for cleanup.
const globalRows: { table: string; row: Record<string, unknown> }[] = [];

/**
 * Insert one row into `table` for workspace `ws` inside `tx`, creating the
 * rows its NOT NULL foreign keys need first. Returns the inserted row.
 */
async function synth(
  tx: Tx,
  table: string,
  ws: string,
  pending: Map<string, Record<string, unknown>>,
  depth = 0,
): Promise<Record<string, unknown>> {
  const existing = pending.get(table) ?? made.get(table);
  if (existing) return existing;
  if (table === "workspaces") return { id: ws };
  if (depth > 8) throw new Error(`foreign-key chain too deep at ${table}`);
  const cols = await columns(table);
  const fks = await foreignKeys(table);
  const attempt = async (fillAll: boolean) => {
    const names: string[] = [];
    const exprs: string[] = [];
    const params: unknown[] = [];
    for (const c of cols) {
      const fk = fks.find((f) => f.col === c.col);
      let v: unknown;
      if (c.col === "workspace_id") v = ws;
      else if (FIXED_VALUES[table]?.[c.col] !== undefined) v = FIXED_VALUES[table]![c.col];
      else if (fk && c.notnull && !c.hasdef) {
        const parent = fk.reftable === table ? null : await synth(tx, fk.reftable, ws, pending, depth + 1);
        if (!parent) throw new Error(`self-referencing NOT NULL key ${table}.${c.col}`);
        v = parent[fk.refcol];
      } else if (fk) continue; // optional link: leave null
      else if (c.notnull && !c.hasdef) v = await valueFor(c);
      else if (fillAll && !c.hasdef) v = await valueFor(c);
      else continue;
      names.push(q(c.col));
      params.push(v === null || v === undefined ? null : String(v));
      exprs.push(`$${params.length}::${c.type}`);
    }
    const sql = `INSERT INTO ${q(table)} (${names.join(", ")}) VALUES (${exprs.join(", ")}) RETURNING row_to_json(${q(table)}.*)::jsonb AS r`;
    // Savepoint so a CHECK failure can be retried inside the same transaction.
    await tx.$executeRawUnsafe(`SAVEPOINT synth_${depth}`);
    try {
      const rows = await tx.$queryRawUnsafe<{ r: Record<string, unknown> }[]>(sql, ...params);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT synth_${depth}`);
      return rows[0]!.r;
    } catch (err) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT synth_${depth}`);
      throw err;
    }
  };
  let row: Record<string, unknown>;
  try {
    row = await attempt(false);
  } catch (err) {
    // A CHECK constraint (e.g. "user_id or role") wants optional columns set.
    if (!/23514|check constraint/i.test(String(err))) throw err;
    row = await attempt(true);
  }
  pending.set(table, row);
  return row;
}

let keep = "";
let doomed = "";
let tables: string[] = [];
const failures: string[] = [];

before(async () => {
  keep = (await createWorkspaceForUser({ userId: OWNER, name: "Orphan keeper", env: SELF })).id;
  doomed = (await createWorkspaceForUser({ userId: OWNER, name: "Orphan doomed", env: SELF })).id;
  tables = await workspaceTables();
});

after(async () => {
  for (const { table, row } of globalRows.reverse()) {
    const keyCol = "id" in row ? "id" : Object.keys(row)[0]!;
    await prisma.$executeRawUnsafe(`DELETE FROM ${q(table)} WHERE ${q(keyCol)}::text = $1`, String(row[keyCol])).catch(() => {});
  }
  await prisma.workspace.deleteMany({ where: { ownerUserId: OWNER } });
  await prisma.workspaceLifecycleEvent.deleteMany({ where: { actorUserId: OWNER } });
  await prisma.$disconnect();
});

describe("catalog guard", () => {
  it("finds the workspace-owned tables", () => {
    assert.ok(tables.length > 250, `only ${tables.length} tables with workspace_id — catalog query broken?`);
  });

  it("every table with workspace_id cascades from workspaces (except the kept audit trail)", async () => {
    const rows = await prisma.$queryRaw<{ t: string }[]>`
      SELECT c.relname AS t
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
         AND NOT EXISTS (
           SELECT 1 FROM pg_constraint k
            WHERE k.contype = 'f' AND k.conrelid = c.oid
              AND k.confrelid = 'public.workspaces'::regclass
              AND k.conkey = ARRAY[a.attnum]::int2[]
              AND k.confdeltype = 'c')
       ORDER BY 1`;
    const missing = rows.map((r) => r.t).filter((t) => !KEEP_ON_WORKSPACE_DELETE.includes(t));
    assert.deepEqual(
      missing,
      [],
      "add a FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE in a migration (and the Prisma relation)",
    );
    for (const t of KEEP_ON_WORKSPACE_DELETE) assert.ok(tables.includes(t), `${t} is listed as kept but doesn't exist`);
  });
});

describe("delete leaves nothing behind", () => {
  it("one row lands in every workspace-owned table", async () => {
    // Phase 10: the ledger only accepts balanced entries (a deferred trigger
    // checks each entry at commit), so the journal tables get a real
    // two-line entry instead of the generic one-row-per-table insert.
    await withWorkspaceScope(doomed, async (tx) => {
      const { entry } = await postEntry(tx as Tx, { workspaceId: doomed, userId: OWNER }, {
        sourceType: "manual",
        memo: "orphan check",
        lines: [
          { account: { key: "cash" }, debitCents: 100, creditCents: 0 },
          { account: { key: "ar" }, debitCents: 0, creditCents: 100 },
        ],
      });
      made.set("ops_journal_entries", { id: entry.id });
      made.set("ops_journal_lines", { entry_id: entry.id });
      const [account] = await (tx as Tx).$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM ops_accounts WHERE workspace_id = $1 LIMIT 1`,
        doomed,
      );
      made.set("ops_accounts", { id: account!.id, workspace_id: doomed });
    });
    for (const table of tables) {
      if (made.has(table)) continue;
      const pending = new Map<string, Record<string, unknown>>();
      try {
        await withWorkspaceScope(doomed, (tx) => synth(tx as Tx, table, doomed, pending));
        for (const [t, row] of pending) {
          made.set(t, row);
          if (!tables.includes(t)) globalRows.push({ table: t, row });
        }
      } catch (err) {
        failures.push(`${table}: ${String((err as Error).message ?? err).split("\n").slice(-1)[0]}`);
      }
    }
    assert.deepEqual(failures, [], "tables the generic row builder couldn't fill");
    for (const t of tables) assert.ok(made.has(t), `${t} has no row`);
  });

  it("the delete path removes every one of them", async () => {
    const r = await deleteWorkspace({ userId: OWNER, workspaceId: doomed, confirmName: "Orphan doomed" });
    assert.equal(r.deletedId, doomed);
    const leftovers: string[] = [];
    await withWorkspaceScope(doomed, async (tx) => {
      for (const table of tables) {
        const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${q(table)} WHERE "workspace_id" = $1`,
          doomed,
        );
        const n = rows[0]?.n ?? 0;
        if (KEEP_ON_WORKSPACE_DELETE.includes(table)) continue;
        if (n > 0) leftovers.push(`${table} (${n})`);
      }
    });
    assert.deepEqual(leftovers, [], "rows left behind after the workspace was deleted");
    const trail = await prisma.workspaceLifecycleEvent.count({ where: { workspaceId: doomed, action: "deleted" } });
    assert.equal(trail, 1, "the deletion record survives");
    assert.equal(await prisma.workspace.count({ where: { id: keep } }), 1, "the other workspace is untouched");
  });
});
