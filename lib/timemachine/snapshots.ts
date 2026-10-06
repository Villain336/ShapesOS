// ShapesOS — Phase 18.3 (WS=flow): Time Machine workspace snapshots.
//
// A snapshot IS the GDPR workspace export (lib/gdpr/workspace-export.ts —
// every workspace-owned table from the live catalogue, RLS-scoped, secrets
// never included), gzipped and written to object storage (blob namespace
// "snapshots", <workspaceId>/<snapshotId>.json.gz). The workspace_snapshots
// row is its manifest: status, size, per-table row counts, who, when. No
// parallel snapshot store: whole-database backups stay the operator's
// scripts/ops/backup.sh.
//
//   createSnapshot()      admins (or the scheduler) — one at a time per workspace
//   runDueSnapshots()     the hourly cron: workspaces whose setting says daily /
//                         weekly and whose last snapshot is older than that
//   applyRetention()      keeps the newest N ready snapshots (setting, 1–60)
//   readSnapshot()        the gzipped bytes (download, restore)
//
// Restore lives in ./restore.ts and always goes into a NEW workspace.

import { gzipSync, gunzipSync } from "node:zlib";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { blobDelete, blobGet, blobPut } from "@/lib/filesystem/storage";
import { workspaceExport } from "@/lib/gdpr/workspace-export";
import { timeMachineAudit } from "./audit";
import { HttpError } from "@/lib/api/errors";

export const SNAPSHOT_SCHEDULES = ["off", "daily", "weekly"] as const;
export type SnapshotSchedule = (typeof SNAPSHOT_SCHEDULES)[number];
export const RETENTION_MIN = 1;
export const RETENTION_MAX = 60;
export const DEFAULT_RETENTION = 7;
/** A pending snapshot older than this is treated as dead (the process crashed). */
const STALE_PENDING_MS = 30 * 60_000;

export class SnapshotError extends HttpError {}

export function maxSnapshotBytes(env: NodeJS.ProcessEnv = process.env): number {
  const mb = Number(env.SNAPSHOT_MAX_MB);
  return (Number.isFinite(mb) && mb >= 1 ? Math.min(mb, 4096) : 256) * 1024 * 1024;
}

export function snapshotBlobPath(workspaceId: string, snapshotId: string): string {
  return `${workspaceId}/${snapshotId}.json.gz`;
}

export interface SnapshotView {
  id: string;
  status: "pending" | "ready" | "failed";
  trigger: "manual" | "scheduled";
  sizeBytes: number;
  tableCount: number;
  rowCount: number;
  tables: Record<string, number>;
  error: string | null;
  createdBy: string;
  createdAt: string;
  finishedAt: string | null;
  lastRestore: RestoreSummary | null;
}

export interface RestoreSummary {
  workspaceId: string;
  workspaceName: string;
  at: string;
  by: string;
  restoredRows: number;
  notRestored: number;
}

type Row = Prisma.WorkspaceSnapshotGetPayload<object>;

export function toSnapshotView(r: Row): SnapshotView {
  return {
    id: r.id,
    status: r.status as SnapshotView["status"],
    trigger: r.trigger as SnapshotView["trigger"],
    sizeBytes: r.sizeBytes,
    tableCount: r.tableCount,
    rowCount: r.rowCount,
    tables: (r.tables ?? {}) as Record<string, number>,
    error: r.error,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    lastRestore: (r.lastRestore ?? null) as RestoreSummary | null,
  };
}

/** Is a snapshot due? (PURE) daily = 24 h since the last one, weekly = 7 days; a little early slack for the hourly sweep. */
export function snapshotDue(schedule: string, last: Date | null, now: Date): boolean {
  if (schedule !== "daily" && schedule !== "weekly") return false;
  if (!last) return true;
  const every = (schedule === "daily" ? 24 : 24 * 7) * 3600_000;
  return now.getTime() - last.getTime() >= every - 15 * 60_000;
}

/** Which ready snapshots fall outside the retention window (newest first kept). PURE. */
export function snapshotsToPrune<T extends { status: string; createdAt: Date }>(rows: T[], keep: number): T[] {
  const ready = rows.filter((r) => r.status === "ready").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return ready.slice(Math.max(1, keep));
}

export interface SnapshotSettings {
  schedule: SnapshotSchedule;
  retention: number;
}

export async function getSnapshotSettings(workspaceId: string): Promise<SnapshotSettings> {
  const s = await prisma.workspaceSettings.findUnique({ where: { workspaceId }, select: { snapshotSchedule: true, snapshotRetention: true } });
  return { schedule: (s?.snapshotSchedule as SnapshotSchedule) ?? "off", retention: s?.snapshotRetention ?? DEFAULT_RETENTION };
}

export async function setSnapshotSettings(workspaceId: string, userId: string, input: { schedule?: unknown; retention?: unknown }): Promise<SnapshotSettings> {
  const data: { snapshotSchedule?: string; snapshotRetention?: number } = {};
  if (input.schedule !== undefined) {
    if (!(SNAPSHOT_SCHEDULES as readonly unknown[]).includes(input.schedule)) throw new SnapshotError(400, "Schedule is off, daily or weekly.");
    data.snapshotSchedule = input.schedule as string;
  }
  if (input.retention !== undefined) {
    const n = Number(input.retention);
    if (!Number.isInteger(n) || n < RETENTION_MIN || n > RETENTION_MAX) throw new SnapshotError(400, `Keep between ${RETENTION_MIN} and ${RETENTION_MAX} snapshots.`);
    data.snapshotRetention = n;
  }
  const row = await prisma.workspaceSettings.upsert({
    where: { workspaceId },
    create: { workspaceId, updatedBy: userId, ...data },
    update: { updatedBy: userId, ...data },
    select: { snapshotSchedule: true, snapshotRetention: true },
  });
  await timeMachineAudit(workspaceId, "snapshot_settings_changed", `Time Machine: snapshots ${row.snapshotSchedule}, keep ${row.snapshotRetention}`, userId);
  if (data.snapshotRetention !== undefined) await applyRetention(workspaceId, row.snapshotRetention).catch(() => undefined);
  return { schedule: row.snapshotSchedule as SnapshotSchedule, retention: row.snapshotRetention };
}

export async function listSnapshots(workspaceId: string): Promise<SnapshotView[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) => tx.workspaceSnapshot.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 100 }));
  return rows.map(toSnapshotView);
}

export async function getSnapshot(workspaceId: string, id: string): Promise<SnapshotView | null> {
  const row = await withWorkspaceScope(workspaceId, (tx) => tx.workspaceSnapshot.findFirst({ where: { id, workspaceId } }));
  return row ? toSnapshotView(row) : null;
}

/** Read the export's manifest from its last chunk (`,"manifest":{…}}`). PURE. */
export function manifestFromTail(tail: string): { tables: Record<string, { rows: number }>; omittedTables: string[] } | null {
  const at = tail.indexOf('"manifest":');
  if (at < 0) return null;
  try {
    const json = tail.slice(at + '"manifest":'.length).replace(/\}\s*$/, "");
    const m = JSON.parse(json) as { tables?: Record<string, { rows: number }>; omittedTables?: string[] };
    return { tables: m.tables ?? {}, omittedTables: m.omittedTables ?? [] };
  } catch {
    return null;
  }
}

/** Take a snapshot now. Throws 409 when one is already running for this workspace. */
export async function createSnapshot(opts: { workspaceId: string; userId: string; trigger?: "manual" | "scheduled"; env?: NodeJS.ProcessEnv }): Promise<SnapshotView> {
  const { workspaceId, userId } = opts;
  const trigger = opts.trigger ?? "manual";
  const row = await withWorkspaceScope(workspaceId, async (tx) => {
    // One at a time: a pending row from the last 30 minutes blocks a second one.
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`snapshot:${workspaceId}`}))`;
    const running = await tx.workspaceSnapshot.findFirst({ where: { workspaceId, status: "pending", createdAt: { gt: new Date(Date.now() - STALE_PENDING_MS) } }, select: { id: true } });
    if (running) throw new SnapshotError(409, "A snapshot of this workspace is already being taken. Try again when it finishes.");
    return tx.workspaceSnapshot.create({ data: { workspaceId, status: "pending", trigger, createdBy: userId } });
  });
  const limit = maxSnapshotBytes(opts.env);
  try {
    const chunks: string[] = [];
    let tail = "";
    let size = 0;
    for await (const chunk of workspaceExport(workspaceId)) {
      chunks.push(chunk);
      tail = chunk;
      size += chunk.length;
      if (size > limit * 8) throw new SnapshotError(413, "This workspace is too large to snapshot here (raise SNAPSHOT_MAX_MB).");
    }
    const manifest = manifestFromTail(tail);
    if (!manifest) throw new Error("the export did not end with its manifest");
    const gz = gzipSync(Buffer.from(chunks.join(""), "utf8"), { level: 6 });
    if (gz.length > limit) throw new SnapshotError(413, "This workspace is too large to snapshot here (raise SNAPSHOT_MAX_MB).");
    const path = snapshotBlobPath(workspaceId, row.id);
    await blobPut("snapshots", path, gz, "application/gzip");
    const tables = Object.fromEntries(Object.entries(manifest.tables).map(([t, v]) => [t, v.rows]));
    const rowCount = Object.values(tables).reduce((a, b) => a + b, 0);
    const done = await withWorkspaceScope(workspaceId, (tx) =>
      tx.workspaceSnapshot.update({
        where: { id: row.id, workspaceId },
        data: { status: "ready", blobPath: path, sizeBytes: gz.length, tables, tableCount: Object.keys(tables).length, rowCount, finishedAt: new Date() },
      }),
    );
    await timeMachineAudit(
      workspaceId,
      "snapshot_created",
      `Time Machine snapshot ${row.id} (${trigger}): ${rowCount} rows in ${Object.keys(tables).length} tables, ${Math.ceil(gz.length / 1024)} KB`,
      trigger === "scheduled" ? null : userId,
    );
    const settings = await getSnapshotSettings(workspaceId);
    await applyRetention(workspaceId, settings.retention).catch(() => undefined);
    return toSnapshotView(done);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 480);
    await withWorkspaceScope(workspaceId, (tx) => tx.workspaceSnapshot.update({ where: { id: row.id, workspaceId }, data: { status: "failed", error: message, finishedAt: new Date() } })).catch(() => undefined);
    throw err;
  }
}

/** The gzipped snapshot bytes (null when missing). */
export async function readSnapshotBytes(workspaceId: string, id: string): Promise<{ view: SnapshotView; bytes: Buffer } | null> {
  const view = await getSnapshot(workspaceId, id);
  if (!view || view.status !== "ready") return null;
  const bytes = await blobGet("snapshots", snapshotBlobPath(workspaceId, id));
  return bytes ? { view, bytes } : null;
}

/** Parse a snapshot's export document (gunzip + JSON). */
export function parseSnapshot(bytes: Buffer, env: NodeJS.ProcessEnv = process.env): SnapshotDocument {
  const json = gunzipSync(bytes, { maxOutputLength: maxSnapshotBytes(env) * 12 }).toString("utf8");
  const doc = JSON.parse(json) as SnapshotDocument;
  if (doc.format !== "shapesos.workspace-export") throw new SnapshotError(400, "This is not a ShapesOS workspace snapshot.");
  return doc;
}

export interface SnapshotDocument {
  format: string;
  version: number;
  exportedAt: string;
  workspace: Record<string, unknown> | null;
  tables: Record<string, Array<Record<string, unknown>>>;
  manifest: { tables: Record<string, { rows: number; omittedColumns: string[] }>; omittedTables: string[]; notes: string[] };
}

export async function deleteSnapshot(workspaceId: string, id: string, userId: string | null): Promise<void> {
  const row = await withWorkspaceScope(workspaceId, (tx) => tx.workspaceSnapshot.findFirst({ where: { id, workspaceId } }));
  if (!row) throw new SnapshotError(404, "Snapshot not found.");
  if (row.status === "pending" && row.createdAt.getTime() > Date.now() - STALE_PENDING_MS) throw new SnapshotError(409, "This snapshot is still being taken.");
  if (row.blobPath) await blobDelete("snapshots", row.blobPath).catch(() => undefined);
  await withWorkspaceScope(workspaceId, (tx) => tx.workspaceSnapshot.delete({ where: { id: row.id, workspaceId } }));
  await timeMachineAudit(workspaceId, "snapshot_deleted", `Time Machine snapshot ${row.id} deleted${userId ? "" : " (retention)"}`, userId);
}

/** Keep the newest `keep` ready snapshots; delete the rest (blob + row). */
export async function applyRetention(workspaceId: string, keep: number): Promise<number> {
  const rows = await withWorkspaceScope(workspaceId, (tx) => tx.workspaceSnapshot.findMany({ where: { workspaceId }, select: { id: true, status: true, createdAt: true } }));
  const prune = snapshotsToPrune(rows, keep);
  for (const r of prune) await deleteSnapshot(workspaceId, r.id, null).catch(() => undefined);
  return prune.length;
}

/** The hourly sweep: snapshot every workspace whose schedule is due. */
export async function runDueSnapshots(now = new Date(), opts: { limit?: number } = {}): Promise<{ taken: string[]; failed: Array<{ workspaceId: string; error: string }> }> {
  const due = await prisma.workspaceSettings.findMany({
    where: { snapshotSchedule: { in: ["daily", "weekly"] } },
    select: { workspaceId: true, snapshotSchedule: true },
    take: 500,
  });
  const taken: string[] = [];
  const failed: Array<{ workspaceId: string; error: string }> = [];
  for (const s of due) {
    if (taken.length >= (opts.limit ?? 20)) break;
    const last = await withWorkspaceScope(s.workspaceId, (tx) =>
      tx.workspaceSnapshot.findFirst({ where: { workspaceId: s.workspaceId, status: { in: ["ready", "pending"] } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    );
    if (!snapshotDue(s.snapshotSchedule, last?.createdAt ?? null, now)) continue;
    try {
      await createSnapshot({ workspaceId: s.workspaceId, userId: "system:time-machine", trigger: "scheduled" });
      taken.push(s.workspaceId);
    } catch (err) {
      failed.push({ workspaceId: s.workspaceId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { taken, failed };
}
