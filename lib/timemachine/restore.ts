// ShapesOS — Phase 18.3 (WS=flow): restore a Time Machine snapshot into a
// NEW workspace. Never over the live one.
//
// The importer for the export format (lib/gdpr/workspace-export.ts):
//   1. a new workspace is created through the normal path
//      (createWorkspaceForUser: the restorer is its owner; quotas and plan
//      rules apply — a snapshot never carries a plan or billing over);
//   2. every row gets a NEW primary key ("id" text keys re-keyed; serial keys
//      from the sequence); every value that names an old id — foreign keys,
//      soft references, ids inside JSON — is rewritten to the new id, and the
//      old workspace id to the new one;
//   3. tables are inserted parents first (foreign keys from the live
//      catalogue); a nullable forward / self reference is filled in after;
//      every write runs with the NEW workspace's RLS scope;
//   4. workspace files are re-linked: their bytes are copied to new storage
//      keys (a file whose bytes are gone is listed, not faked);
//   5. automations come back switched OFF (schedules paused, workflows /
//      autopilot rules / alert rules disabled) so nothing fires twice.
//
// What it can't bring back is listed honestly in the report: tables it
// skips on purpose (SKIPPED_TABLES: members, credentials, queues, billing
// and usage ledgers, hash-chained audit chains …), rows the database refused
// (with the first reason: a secret the export never had, a value that must
// be unique across workspaces, a parent that wasn't restored), and files
// whose bytes were missing. The export itself never contains secrets.

import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { WORKSPACE_GUC } from "@/lib/substrate/memory/rls";
import { loadCatalog, q, type Catalog, type TableInfo } from "@/lib/gdpr/catalog";
import { createWorkspaceForUser } from "@/lib/workspace/lifecycle";
import { getStorageAdapter } from "@/lib/filesystem/storage";
import { getSnapshot, parseSnapshot, readSnapshotBytes, SnapshotError, type RestoreSummary, type SnapshotDocument } from "./snapshots";
import { timeMachineAudit } from "./audit";

type Tx = Prisma.TransactionClient;

/** Tables restore leaves out on purpose, with the reason shown to the person. */
export const SKIPPED_TABLES: Readonly<Record<string, string>> = {
  workspace_members: "members",
  workspace_invites: "members",
  workspace_snapshots: "snapshots",
  workspace_lifecycle_events: "history",
  usage_events: "billing",
  credit_ledger_entries: "billing",
  credit_balances: "billing",
  agent_jobs: "queues",
  agent_job_events: "queues",
  webhook_deliveries: "queues",
  webhook_endpoints: "connections",
  connector_connections: "connections",
  composio_connections: "connections",
  rate_limit_buckets: "queues",
};

/** Name patterns skipped for the same reasons (queues, credentials, billing). */
const SKIPPED_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(_jobs|_job_runs|_deliveries|_outbox|_queue|_receipts|_locks)$/, reason: "queues" },
  { re: /(oauth|_tokens?$|_credentials?$|_secrets?$|_api_keys?$|_sessions$)/, reason: "connections" },
  { re: /^(usage_|metering_|credit_|billing_|stripe_)/, reason: "billing" },
];

/** Why a table isn't restored (null = it is). PURE. */
export function skipReason(table: TableInfo | string): string | null {
  const t = typeof table === "string" ? null : table;
  const name = typeof table === "string" ? table : table.name;
  if (SKIPPED_TABLES[name]) return SKIPPED_TABLES[name]!;
  if (t?.hashChained) return "audit_chain";
  for (const p of SKIPPED_PATTERNS) if (p.re.test(name)) return p.reason;
  return null;
}

export interface TableColumnMeta {
  notNull: Set<string>;
  generated: Set<string>;
  /** Columns with a sequence default (serial / identity): name → sequence. */
  sequences: Map<string, string>;
}

/** Topological order: referenced tables first; cycles broken deterministically (alphabetical). PURE. */
export function insertOrder(tables: string[], catalog: Catalog): string[] {
  const set = new Set(tables);
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    const info = catalog.get(t);
    deps.set(t, new Set((info?.foreignKeys ?? []).map((f) => f.refTable).filter((r) => r !== t && set.has(r))));
  }
  const out: string[] = [];
  const done = new Set<string>();
  const remaining = [...tables].sort();
  while (remaining.length) {
    const ready = remaining.filter((t) => [...deps.get(t)!].every((d) => done.has(d)));
    const pick = ready.length ? ready : [remaining.reduce((best, t) => ([...deps.get(t)!].filter((d) => !done.has(d)).length < [...deps.get(best)!].filter((d) => !done.has(d)).length ? t : best))];
    for (const t of pick) {
      out.push(t);
      done.add(t);
      remaining.splice(remaining.indexOf(t), 1);
    }
  }
  return out;
}

/** A new text id: same length class as cuid, never colliding with the old one. */
export function newTextId(): string {
  return `c${randomBytes(15).toString("base64url").replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(20, "0").slice(0, 24)}`;
}

/** Rewrite every string that names an old id (deep, JSON included). PURE given the map. */
export function remapValue(v: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof v === "string") return v.length >= 8 ? (ids.get(v) ?? v) : v;
  if (Array.isArray(v)) return v.map((x) => remapValue(x, ids));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = remapValue(x, ids);
    return out;
  }
  return v;
}

export interface RestoreTableReport {
  table: string;
  expected: number;
  restored: number;
  /** Rows the database refused / skipped, with the first reason. */
  notRestored: number;
  reason: string | null;
}

export interface RestoreReport {
  workspaceId: string;
  workspaceName: string;
  tables: RestoreTableReport[];
  skipped: Array<{ table: string; rows: number; reason: string }>;
  files: { copied: number; missing: number };
  automationsPaused: number;
  /** Runs that were queued / running / waiting in the snapshot, marked cancelled. */
  inFlightStopped: number;
  linksNotRestored: number;
  /** What a snapshot never contains (from the export's own manifest). */
  neverIncluded: string[];
}

async function columnMeta(tx: Tx, table: string): Promise<TableColumnMeta> {
  const rows = await tx.$queryRaw<Array<{ name: string; not_null: boolean; generated: string; seq: string | null }>>`
    SELECT a.attname AS name, a.attnotnull AS not_null, a.attgenerated::text AS generated,
           pg_get_serial_sequence(quote_ident(${table}), a.attname) AS seq
      FROM pg_attribute a
     WHERE a.attrelid = (quote_ident(${table}))::regclass AND a.attnum > 0 AND NOT a.attisdropped`;
  const meta: TableColumnMeta = { notNull: new Set(), generated: new Set(), sequences: new Map() };
  for (const r of rows) {
    if (r.not_null) meta.notNull.add(r.name);
    if (r.generated && r.generated !== "") meta.generated.add(r.name);
    if (r.seq) meta.sequences.set(r.name, r.seq);
  }
  return meta;
}

function friendlyError(err: unknown): string {
  const m = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ");
  const pg = /(violates [^"]+"[^"]+"|null value in column "[^"]+"|invalid input [^:]+|value too long[^.]*)/.exec(m);
  return (pg?.[1] ?? m).slice(0, 200);
}

const BATCH = 300;

/**
 * Restore one snapshot into a new workspace owned by `userId`. Admins of the
 * snapshot's workspace only (the caller checks the role). Returns the report.
 */
export async function restoreSnapshot(opts: { workspaceId: string; snapshotId: string; userId: string; name?: string | null; env?: NodeJS.ProcessEnv }): Promise<RestoreReport> {
  const src = await readSnapshotBytes(opts.workspaceId, opts.snapshotId);
  if (!src) throw new SnapshotError(404, "That snapshot isn't available (it may still be running, or its file is gone).");
  const doc = parseSnapshot(src.bytes, opts.env);
  const oldWs = opts.workspaceId;
  const sourceName = typeof doc.workspace?.name === "string" ? doc.workspace.name : "Workspace";
  const name = (opts.name ?? "").trim() || `${sourceName} (restored ${doc.exportedAt.slice(0, 10)})`;
  const ws = await createWorkspaceForUser({ userId: opts.userId, name: name.slice(0, 80) });
  try {
    const report = await importDocument(doc, { oldWorkspaceId: oldWs, newWorkspaceId: ws.id, newWorkspaceName: ws.name });
    const summary: RestoreSummary = {
      workspaceId: ws.id,
      workspaceName: ws.name,
      at: new Date().toISOString(),
      by: opts.userId,
      restoredRows: report.tables.reduce((a, t) => a + t.restored, 0),
      notRestored: report.tables.reduce((a, t) => a + t.notRestored, 0) + report.skipped.reduce((a, s) => a + s.rows, 0),
    };
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config(${WORKSPACE_GUC}, ${oldWs}, true)`;
      await tx.workspaceSnapshot.update({ where: { id: opts.snapshotId }, data: { lastRestore: summary as unknown as Prisma.InputJsonValue } });
    });
    const line = `Time Machine: snapshot ${opts.snapshotId} restored into new workspace ${ws.id} — ${summary.restoredRows} rows restored, ${summary.notRestored} not restored`;
    await timeMachineAudit(oldWs, "snapshot_restored", line, opts.userId);
    await timeMachineAudit(ws.id, "snapshot_restored", `${line} (from workspace ${oldWs})`, opts.userId);
    return report;
  } catch (err) {
    // A half-restored workspace is worse than none: remove it (cascade).
    await prisma.workspace.delete({ where: { id: ws.id } }).catch(() => undefined);
    throw err;
  }
}

/** The importer proper (exported for the round-trip test). */
export async function importDocument(doc: SnapshotDocument, ids: { oldWorkspaceId: string; newWorkspaceId: string; newWorkspaceName: string }): Promise<RestoreReport> {
  const catalog = await loadCatalog(prisma, { fresh: true });
  const report: RestoreReport = {
    workspaceId: ids.newWorkspaceId,
    workspaceName: ids.newWorkspaceName,
    tables: [],
    skipped: [],
    files: { copied: 0, missing: 0 },
    automationsPaused: 0,
    inFlightStopped: 0,
    linksNotRestored: 0,
    neverIncluded: doc.manifest?.omittedTables ?? [],
  };
  const restoreTables: string[] = [];
  for (const [table, rows] of Object.entries(doc.tables ?? {})) {
    const info = catalog.get(table);
    if (!info) {
      report.skipped.push({ table, rows: rows.length, reason: "unknown_table" });
      continue;
    }
    const why = skipReason(info);
    if (why) {
      report.skipped.push({ table, rows: rows.length, reason: why });
      continue;
    }
    restoreTables.push(table);
  }
  const order = insertOrder(restoreTables, catalog);

  // ── 1. New ids for every row (so references anywhere can be rewritten) ────
  const idMap = new Map<string, string>([[ids.oldWorkspaceId, ids.newWorkspaceId]]);
  const intMaps = new Map<string, Map<string, number>>(); // "<table>" → old int pk → new
  const metas = new Map<string, TableColumnMeta>();
  await prisma.$transaction(async (tx) => {
    for (const table of order) {
      const meta = await columnMeta(tx, table);
      metas.set(table, meta);
      const info = catalog.get(table)!;
      if (info.primaryKey.length !== 1) continue;
      const pk = info.primaryKey[0]!;
      const pkType = info.columns.find((c) => c.name === pk)?.type ?? "text";
      const rows = doc.tables[table]!;
      if (pk === "id" && /^(text|character varying)/.test(pkType)) {
        for (const r of rows) if (typeof r.id === "string") idMap.set(r.id, newTextId());
      } else if (pk === "id" && pkType === "uuid") {
        for (const r of rows) if (typeof r.id === "string") idMap.set(r.id, randomUUID());
      } else if (meta.sequences.has(pk) && rows.length) {
        const seq = meta.sequences.get(pk)!;
        const fresh = await tx.$queryRawUnsafe<Array<{ v: bigint | number }>>(`SELECT nextval($1::regclass) AS v FROM generate_series(1, $2::int)`, seq, rows.length);
        const m = new Map<string, number>();
        rows.forEach((r, i) => m.set(String(r[pk]), Number(fresh[i]!.v)));
        intMaps.set(table, m);
      }
    }
  });

  // ── 2. Files: copy bytes to new storage keys (outside the DB transaction) ──
  const storage = getStorageAdapter();
  const copiedKeys: string[] = [];
  const missingFileRows = new Map<string, Set<number>>();
  for (const table of ["workspace_files", "workspace_file_versions"]) {
    const rows = order.includes(table) ? doc.tables[table]! : [];
    for (const [i, r] of rows.entries()) {
      const oldKey = r.storage_key;
      if (typeof oldKey !== "string") continue;
      const bytes = await storage.get(oldKey).catch(() => null);
      if (!bytes) {
        report.files.missing++;
        if (!missingFileRows.has(table)) missingFileRows.set(table, new Set());
        missingFileRows.get(table)!.add(i);
        idMap.delete(oldKey);
        continue;
      }
      const newKey = randomUUID();
      await storage.put(newKey, bytes, typeof r.mime_type === "string" ? r.mime_type : "application/octet-stream");
      copiedKeys.push(newKey);
      idMap.set(oldKey, newKey);
      report.files.copied++;
    }
  }

  // ── 3. Insert, parents first, under the new workspace's RLS scope ─────────
  const inserted = new Set<string>();
  const fixups: Array<{ table: string; pk: string; pkValue: unknown; column: string; value: unknown }> = [];
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config(${WORKSPACE_GUC}, ${ids.newWorkspaceId}, true)`;
        for (const table of order) {
          const info = catalog.get(table)!;
          const meta = metas.get(table)!;
          const rows = doc.tables[table]!;
          const intMap = intMaps.get(table);
          const pk = info.primaryKey.length === 1 ? info.primaryKey[0]! : null;
          const deferrable = info.foreignKeys.filter((f) => (f.refTable === table || (restoreTables.includes(f.refTable) && !inserted.has(f.refTable))) && !meta.notNull.has(f.column));
          const missing = missingFileRows.get(table) ?? new Set<number>();
          const prepared: Array<Record<string, unknown>> = [];
          let refused = 0;
          let firstReason: string | null = null;
          rows.forEach((raw, i) => {
            if (missing.has(i)) {
              refused++;
              firstReason ??= "file bytes missing";
              return;
            }
            const row: Record<string, unknown> = {};
            for (const [col, val] of Object.entries(raw)) {
              if (meta.generated.has(col)) continue;
              row[col] = remapValue(val, idMap);
            }
            // Serial keys and int foreign keys into re-keyed serial tables.
            if (pk && intMap && raw[pk] !== undefined) row[pk] = intMap.get(String(raw[pk])) ?? row[pk];
            for (const f of info.foreignKeys) {
              const m = intMaps.get(f.refTable);
              if (m && raw[f.column] !== null && raw[f.column] !== undefined) row[f.column] = m.get(String(raw[f.column])) ?? row[f.column];
            }
            if (info.hasWorkspaceId) row.workspace_id = ids.newWorkspaceId;
            if (pk) {
              for (const f of deferrable) {
                if (row[f.column] === null || row[f.column] === undefined) continue;
                fixups.push({ table, pk, pkValue: row[pk], column: f.column, value: row[f.column] });
                row[f.column] = null;
              }
            }
            prepared.push(row);
          });
          let restored = 0;
          for (let i = 0; i < prepared.length; i += BATCH) {
            const batch = prepared.slice(i, i + BATCH);
            const r = await insertBatch(tx, table, batch);
            restored += r.inserted;
            refused += r.refused;
            firstReason ??= r.reason;
          }
          inserted.add(table);
          report.tables.push({ table, expected: rows.length, restored, notRestored: rows.length - restored, reason: rows.length - restored > 0 ? (firstReason ?? "conflicts with a record elsewhere") : null });
        }
        // Forward / self references, now that every parent exists.
        for (const f of fixups) {
          await tx.$executeRawUnsafe("SAVEPOINT fx");
          try {
            const n = await tx.$executeRawUnsafe(`UPDATE ${q(f.table)} SET ${q(f.column)} = $1 WHERE ${q(f.pk)} = $2`, f.value, f.pkValue);
            await tx.$executeRawUnsafe("RELEASE SAVEPOINT fx");
            if (n === 0) report.linksNotRestored++;
          } catch {
            await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT fx");
            report.linksNotRestored++;
          }
        }
        // Automations come back OFF: nothing fires twice.
        report.automationsPaused += await tx.$executeRaw`UPDATE "scheduled_skills" SET "status" = 'paused' WHERE "workspace_id" = ${ids.newWorkspaceId} AND "status" = 'active'`;
        report.automationsPaused += await tx.$executeRaw`UPDATE "alert_rules" SET "enabled" = false WHERE "workspace_id" = ${ids.newWorkspaceId} AND "enabled"`;
        report.automationsPaused += await tx.$executeRaw`UPDATE "workflows" SET "enabled" = false WHERE "enabled" AND "project_id" IN (SELECT "id" FROM "projects" WHERE "workspace_id" = ${ids.newWorkspaceId})`;
        report.automationsPaused += await tx.$executeRaw`UPDATE "autopilot_rules" SET "enabled" = false WHERE "enabled" AND "project_id" IN (SELECT "id" FROM "projects" WHERE "workspace_id" = ${ids.newWorkspaceId})`;
        await tx.$executeRaw`UPDATE "workspace_settings" SET "snapshot_schedule" = 'off' WHERE "workspace_id" = ${ids.newWorkspaceId}`;
        // Work that was in flight in the snapshot is history here, never resumed.
        report.inFlightStopped += await tx.$executeRaw`UPDATE "agent_runs" SET "status" = 'cancelled', "ended_at" = COALESCE("ended_at", now()) WHERE "workspace_id" = ${ids.newWorkspaceId} AND "status" IN ('queued', 'running', 'awaiting_confirmation')`;
        report.inFlightStopped += await tx.$executeRaw`UPDATE "skill_runs" SET "status" = 'cancelled', "finished_at" = COALESCE("finished_at", now()) WHERE "workspace_id" = ${ids.newWorkspaceId} AND "status" IN ('pending', 'awaiting_approval', 'approved', 'running')`;
        report.inFlightStopped += await tx.$executeRaw`UPDATE "workflow_runs" SET "status" = 'cancelled', "finished_at" = COALESCE("finished_at", now()) WHERE "status" IN ('queued', 'running', 'waiting_approval') AND "project_id" IN (SELECT "id" FROM "projects" WHERE "workspace_id" = ${ids.newWorkspaceId})`;
      },
      { maxWait: 30_000, timeout: 10 * 60_000 },
    );
  } catch (err) {
    for (const k of copiedKeys) await storage.delete(k).catch(() => undefined);
    throw err;
  }
  report.tables.sort((a, b) => a.table.localeCompare(b.table));
  return report;
}

/** Insert a batch; on any error fall back to row by row so one bad row only costs itself. */
async function insertBatch(tx: Tx, table: string, rows: Array<Record<string, unknown>>): Promise<{ inserted: number; refused: number; reason: string | null }> {
  if (!rows.length) return { inserted: 0, refused: 0, reason: null };
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const list = cols.map(q).join(", ");
  const sql = `WITH ins AS (INSERT INTO ${q(table)} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${q(table)}, $1::jsonb) ON CONFLICT DO NOTHING RETURNING 1) SELECT count(*)::int AS n FROM ins`;
  await tx.$executeRawUnsafe("SAVEPOINT rb");
  try {
    const r = await tx.$queryRawUnsafe<Array<{ n: number }>>(sql, JSON.stringify(rows));
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT rb");
    const n = Number(r[0]?.n ?? 0);
    return { inserted: n, refused: rows.length - n, reason: n < rows.length ? "a value must be unique across workspaces (kept with the original)" : null };
  } catch {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT rb");
  }
  let inserted = 0;
  let refused = 0;
  let reason: string | null = null;
  for (const row of rows) {
    await tx.$executeRawUnsafe("SAVEPOINT rr");
    try {
      const r = await tx.$queryRawUnsafe<Array<{ n: number }>>(sql, JSON.stringify([row]));
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT rr");
      if (Number(r[0]?.n ?? 0) === 1) inserted++;
      else {
        refused++;
        reason ??= "a value must be unique across workspaces (kept with the original)";
      }
    } catch (err) {
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT rr");
      refused++;
      reason ??= friendlyError(err);
    }
  }
  return { inserted, refused, reason };
}

/** Rows per table in a workspace (for the round-trip check and the report). */
export async function countRows(workspaceId: string, tables: string[]): Promise<Record<string, number>> {
  const catalog = await loadCatalog();
  const { workspaceScopePredicate } = await import("@/lib/gdpr/catalog");
  const out: Record<string, number> = {};
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config(${WORKSPACE_GUC}, ${workspaceId}, true)`;
    for (const t of tables) {
      const pred = workspaceScopePredicate(catalog, t);
      if (!pred) continue;
      const r = await tx.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${q(t)} t WHERE ${pred}`, workspaceId);
      out[t] = Number(r[0]?.n ?? 0);
    }
  });
  return out;
}

export { getSnapshot };
