// ShapesOS — the live schema, as GDPR export/erasure needs it (Phase 4a).
//
// Read from pg_catalog at runtime instead of a hand-kept list, so a table
// added by a future migration is exported (and erased from) automatically:
//
//   scope       how a table's rows belong to a workspace: its own
//               workspace_id, or a foreign-key path (up to 4 hops) to a
//               table that has one.
//   secrets     columns never exported (credential ciphertext, token hashes,
//               passwords, signing secrets, hints), and whole tables that
//               hold nothing but live credentials.
//   user refs   text columns that name a person by their sign-in subject
//               (user_id, created_by, actor, *_by, …): what a user export
//               searches and what account deletion pseudonymizes.

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type Db = PrismaClient | Prisma.TransactionClient;

export interface ColumnInfo {
  name: string;
  /** format_type() output, usable as a cast target. */
  type: string;
}

export interface ForeignKeyInfo {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  hasWorkspaceId: boolean;
  /** Row-level security enabled: queries need the workspace GUC. */
  rls: boolean;
  /** Hash-chained audit table (event_hash/prev_hash): rows must not be rewritten. */
  hashChained: boolean;
  /** Has user triggers (e.g. usage_events' append-only guard). */
  hasTriggers: boolean;
}

export type Catalog = Map<string, TableInfo>;

// ── Classification rules (pure, unit-tested) ────────────────────────────────

/** Columns that never leave the database in an export. */
const SECRET_COLUMN =
  /(secret|password|passwd|token|_enc$|^enc_|encrypted|cipher|api_?key|key_hash|key_hint$|private_?key|credential|signature(_hash)?$|^otp|totp|recovery_code|webhook_url|dsn)/i;

export function isSecretColumn(column: string): boolean {
  return SECRET_COLUMN.test(column);
}

/** Tables whose rows are live credentials or one-time codes: never exported. */
export const SECRET_TABLES: readonly string[] = [
  "mcp_oauth_codes", // single-use authorization codes (the code is the primary key)
  "mcp_oauth_tokens", // access-token hashes (the hash is the primary key)
  "_prisma_migrations",
];

/** Columns omitted as data-volume noise rather than secrets. */
export function isBulkColumn(type: string): boolean {
  return type === "bytea" || type.startsWith("vector") || type === "tsvector";
}

/** Text columns that name a person by their sign-in subject id. */
const USER_REF_COLUMN =
  /^(user_id|owner_user_id|actor_user_id|actor_id|actor|author|author_id|owner_id|assignee|approver|approver_id|reviewer_id|signer_id|[a-z_]+_by)$/;

export function isUserRefColumn(column: string, type: string): boolean {
  return USER_REF_COLUMN.test(column) && /^(text|character varying)/.test(type);
}

export const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

// ── Loading ─────────────────────────────────────────────────────────────────

interface Row {
  table_name: string;
  column_name: string;
  type: string;
  is_pk: boolean;
  rls: boolean;
  has_triggers: boolean;
}

let cached: { at: number; catalog: Catalog } | null = null;
const CACHE_MS = 5 * 60_000;

export async function loadCatalog(db: Db = prisma, opts: { fresh?: boolean } = {}): Promise<Catalog> {
  if (!opts.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.catalog;
  const rows = await db.$queryRaw<Row[]>`
    SELECT c.relname AS table_name, a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS type,
           COALESCE(a.attnum = ANY(pk.conkey), false) AS is_pk,
           c.relrowsecurity AS rls,
           EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal) AS has_triggers
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_constraint pk ON pk.conrelid = c.oid AND pk.contype = 'p'
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
     ORDER BY c.relname, a.attnum`;
  const fks = await db.$queryRaw<{ table_name: string; column: string; ref_table: string; ref_column: string }[]>`
    SELECT c.relname AS table_name, a.attname AS column, cf.relname AS ref_table, af.attname AS ref_column
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_class cf ON cf.oid = k.confrelid
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      JOIN pg_attribute af ON af.attrelid = k.confrelid AND af.attnum = k.confkey[1]
     WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace
       AND array_length(k.conkey, 1) = 1`;
  const catalog: Catalog = new Map();
  for (const r of rows) {
    let t = catalog.get(r.table_name);
    if (!t) {
      t = {
        name: r.table_name,
        columns: [],
        primaryKey: [],
        foreignKeys: [],
        hasWorkspaceId: false,
        rls: r.rls,
        hashChained: false,
        hasTriggers: r.has_triggers,
      };
      catalog.set(r.table_name, t);
    }
    t.columns.push({ name: r.column_name, type: r.type });
    if (r.is_pk) t.primaryKey.push(r.column_name);
    if (r.column_name === "workspace_id") t.hasWorkspaceId = true;
    if (r.column_name === "event_hash" || r.column_name === "prev_hash") t.hashChained = true;
  }
  for (const f of fks) {
    catalog.get(f.table_name)?.foreignKeys.push({ column: f.column, refTable: f.ref_table, refColumn: f.ref_column });
  }
  cached = { at: Date.now(), catalog };
  return catalog;
}

// ── Workspace scope ─────────────────────────────────────────────────────────

/**
 * SQL predicate (on alias `t`) selecting a table's rows that belong to the
 * workspace bound to $1, or null when the table isn't workspace-owned.
 * Direct: workspace_id = $1. Indirect: a foreign key into a workspace-owned
 * table, shortest path first, at most `maxDepth` hops.
 */
export function workspaceScopePredicate(catalog: Catalog, table: string, alias = "t", maxDepth = 4): string | null {
  if (table === "workspaces") return `${alias}."id" = $1`;
  const t = catalog.get(table);
  if (!t) return null;
  if (t.hasWorkspaceId) return `${alias}."workspace_id" = $1`;
  if (maxDepth <= 0) return null;
  // Breadth-first: try every FK at this depth before going deeper.
  for (let depth = 1; depth <= maxDepth; depth++) {
    for (const fk of t.foreignKeys) {
      if (fk.refTable === table) continue;
      const parentAlias = `${alias}_${depth}`;
      const inner = depthLimitedScope(catalog, fk.refTable, parentAlias, depth - 1, new Set([table]));
      if (inner) {
        return `${alias}.${q(fk.column)} IN (SELECT ${parentAlias}.${q(fk.refColumn)} FROM ${q(fk.refTable)} ${parentAlias} WHERE ${inner})`;
      }
    }
  }
  return null;
}

function depthLimitedScope(catalog: Catalog, table: string, alias: string, remaining: number, seen: Set<string>): string | null {
  if (table === "workspaces") return `${alias}."id" = $1`;
  const t = catalog.get(table);
  if (!t) return null;
  if (t.hasWorkspaceId) return `${alias}."workspace_id" = $1`;
  if (remaining <= 0 || seen.has(table)) return null;
  const next = new Set(seen).add(table);
  for (const fk of t.foreignKeys) {
    if (fk.refTable === table) continue;
    const parentAlias = `${alias}_p`;
    const inner = depthLimitedScope(catalog, fk.refTable, parentAlias, remaining - 1, next);
    if (inner) {
      return `${alias}.${q(fk.column)} IN (SELECT ${parentAlias}.${q(fk.refColumn)} FROM ${q(fk.refTable)} ${parentAlias} WHERE ${inner})`;
    }
  }
  return null;
}

/** Columns of `t` that an export may include (secrets and bulk blobs left out). */
export function exportableColumns(t: TableInfo): { include: ColumnInfo[]; omitted: string[] } {
  const include: ColumnInfo[] = [];
  const omitted: string[] = [];
  for (const c of t.columns) {
    if (isSecretColumn(c.name) || isBulkColumn(c.type)) omitted.push(c.name);
    else include.push(c);
  }
  return { include, omitted };
}
