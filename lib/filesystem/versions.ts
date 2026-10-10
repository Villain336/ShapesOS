// ShapesOS — Phase 18.2 (WS=content): file versions (server only).
//
// Every overwrite keeps the previous bytes: the current blob stays on
// workspace_files (storage key, size, mime, version N) and the bytes it
// replaces move to workspace_file_versions as version N-1 … — same opaque
// storage keys, same storage adapter (local disk or S3-compatible on hosted;
// lib/filesystem/storage.ts), never a second store. Restoring a version is
// itself an overwrite (history only grows). Every version counts against the
// workspace quota; the workspace's retention setting (workspace_quotas
// .version_retention, default 20) caps how many previous versions a file
// keeps — older ones are purged with their bytes, oldest first.
//
// Upload safety runs on every new version exactly like a first upload
// (validateUploadBuffer) unless the bytes are server-made. Spotlight
// re-indexes the file's text after each new version.
// workspace_file_versions is FORCE RLS: everything runs inside
// withWorkspaceScope (workspace_files / workspace_quotas are plain tables,
// filtered by workspaceId on every query, like lib/filesystem/service.ts).

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { validateUploadBuffer } from "@/lib/security/upload-safety";
import { auditEvent } from "@/lib/auditlog";
import { getStorageAdapter } from "./storage";
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_QUOTA_BYTES, FsError } from "./core";
import { screenUserUpload } from "./service";
import { normalizeLogicalPath } from "./paths";
import { recordChange } from "@/lib/drive/changes";
import { chargeQuota, lockDriveTree, releaseQuota } from "@/lib/drive/quota-store";
import { quotaScopesFor } from "@/lib/drive/quota";
import { scheduleFileTextIndex } from "@/lib/search/text-index-schedule";

export const DEFAULT_VERSION_RETENTION = 20;
export const MAX_VERSION_RETENTION = 200;

export interface FileVersionMeta {
  /** null for the current version (it lives on the file row). */
  id: string | null;
  version: number;
  current: boolean;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdBy: string;
  createdAt: string;
  replacedAt: string | null;
}

/** PURE: which previous versions to purge so at most `keep` remain (oldest first). */
export function versionsToPurge<T extends { version: number }>(previous: T[], keep: number): T[] {
  const k = Math.max(0, Math.floor(keep));
  const sorted = [...previous].sort((a, b) => b.version - a.version);
  return sorted.slice(k);
}

/** PURE: a valid retention value, or the reason it isn't. */
export function checkRetention(v: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_VERSION_RETENTION) return { ok: false, reason: `Keep between 1 and ${MAX_VERSION_RETENTION} previous versions.` };
  return { ok: true, value: n };
}

function scheduleIndex(workspaceId: string, fileId: string): void {
  // The light write hook (lib/search/text-index-schedule): the indexer loads
  // only when the job runs — never in a route bundle (bundle-size rule).
  scheduleFileTextIndex(workspaceId, fileId);
}

export interface OverwriteOptions {
  workspaceId: string;
  fileId: string;
  bytes: Buffer;
  mimeType?: string;
  /** Who wrote the new bytes. */
  userId: string;
  maxBytes?: number;
  /** Server-made bytes only (a restore re-uses bytes that already passed the gate). */
  skipSafety?: boolean;
  /** Audit wording: "version" (an upload) or "restore". */
  reason?: "version" | "restore";
  restoredFrom?: number;
}

export interface OverwriteResult {
  fileId: string;
  version: number;
  purgedVersions: number[];
}

/**
 * Write new bytes to an existing live file, keeping the bytes it had as the
 * previous version. Quota is checked (and charged) under the quota row lock.
 */
export async function overwriteFile(opts: OverwriteOptions): Promise<OverwriteResult> {
  const { workspaceId, fileId, userId } = opts;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const bytes = Buffer.isBuffer(opts.bytes) ? opts.bytes : Buffer.from(opts.bytes);
  if (bytes.length === 0) throw new FsError("too_large", "File is empty.");
  if (bytes.length > maxBytes) throw new FsError("too_large", `File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB cap.`);
  const current = await prisma.workspaceFile.findFirst({ where: { id: fileId, workspaceId, trashedAt: null } });
  if (!current) throw new FsError("not_found", "File not found.");

  let mime = opts.mimeType?.trim() || current.mimeType;
  if (!opts.skipSafety) {
    const check = validateUploadBuffer(bytes, { filename: current.filename, maxBytes, category: "default" });
    if (!check.ok) {
      await auditEvent({ workspaceId, projectId: null, action: "file_rejected", summary: `New version of "${current.filename}" rejected: ${check.reason}`, actorUserId: userId }).catch(() => {});
      throw new FsError("unsafe_content", check.reason);
    }
    mime = check.mime;
    // Phase 21B: the malware scanner is REQUIRED on hosted deployments.
    await screenUserUpload(workspaceId, userId, current.filename, bytes);
  }

  const adapter = getStorageAdapter();
  const newKey = randomUUID();
  await adapter.put(newKey, bytes, mime);
  let purged: Array<{ version: number; storageKey: string; sizeBytes: number }> = [];
  let version = 0;
  try {
    const out = await withWorkspaceScope(workspaceId, async (tx) => {
      await lockDriveTree(tx, workspaceId);
      // Re-read the file under the lock (a concurrent overwrite bumps the version).
      const file = await tx.workspaceFile.findFirst({ where: { id: fileId, workspaceId, trashedAt: null } });
      if (!file) throw new FsError("not_found", "File not found.");
      const info = normalizeLogicalPath(file.logicalPath);
      const scopes = info.ok ? quotaScopesFor(info) : [];
      const quota = await tx.workspaceQuota.findUnique({ where: { workspaceId } });
      try {
        await chargeQuota(tx, workspaceId, scopes, bytes.length);
      } catch (e) {
        if (e instanceof FsError && e.code === "quota_exceeded" && /^Workspace/.test(e.message)) {
          throw new FsError("quota_exceeded", "Workspace storage quota exceeded. Delete old versions or files, or lower the version retention.");
        }
        throw e;
      }
      const retention = quota?.versionRetention ?? DEFAULT_VERSION_RETENTION;
      // Who wrote the current bytes, and when: the file's creator for version
      // 1, else whoever replaced the version before it (the file row keeps
      // its creator — that is its owner for per-file access).
      const latest = await tx.workspaceFileVersion.findFirst({ where: { workspaceId, fileId }, orderBy: { version: "desc" }, select: { replacedBy: true, replacedAt: true } });
      await tx.workspaceFileVersion.create({
        data: {
          workspaceId,
          fileId,
          version: file.version,
          storageKey: file.storageKey,
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          createdBy: latest?.replacedBy ?? file.createdBy,
          createdAt: latest?.replacedAt ?? file.createdAt,
          replacedBy: userId,
        },
      });
      const updated = await tx.workspaceFile.update({
        where: { id: fileId, workspaceId },
        data: { storageKey: newKey, mimeType: mime, sizeBytes: bytes.length, version: file.version + 1 },
        select: { version: true },
      });
      const previous = await tx.workspaceFileVersion.findMany({
        where: { workspaceId, fileId },
        select: { id: true, version: true, storageKey: true, sizeBytes: true },
      });
      const drop = versionsToPurge(previous, retention);
      if (drop.length) {
        await tx.workspaceFileVersion.deleteMany({ where: { workspaceId, id: { in: drop.map((d) => d.id) } } });
      }
      const freed = drop.reduce((n, d) => n + d.sizeBytes, 0);
      await releaseQuota(tx, workspaceId, scopes, freed);
      await recordChange(tx, workspaceId, { type: "update", entity: "file", entityId: fileId, path: file.logicalPath, version: updated.version, actorUserId: userId });
      return { version: updated.version, drop };
    });
    version = out.version;
    purged = out.drop;
  } catch (err) {
    await adapter.delete(newKey).catch(() => undefined);
    throw err;
  }
  for (const p of purged) await adapter.delete(p.storageKey).catch(() => undefined);
  await auditEvent({
    workspaceId,
    projectId: null,
    action: opts.reason === "restore" ? "file_version_restored" : "file_version_created",
    summary:
      opts.reason === "restore"
        ? `Restored "${current.filename}" to version ${opts.restoredFrom ?? "?"} (now version ${version})`
        : `New version ${version} of "${current.filename}" (${bytes.length} bytes)`,
    actorUserId: userId,
  }).catch(() => {});
  scheduleIndex(workspaceId, fileId);
  return { fileId, version, purgedVersions: purged.map((p) => p.version).sort((a, b) => a - b) };
}

/** Current version first, then previous versions, newest first. */
export async function listFileVersions(workspaceId: string, fileId: string): Promise<FileVersionMeta[] | null> {
  const file = await prisma.workspaceFile.findFirst({ where: { id: fileId, workspaceId, trashedAt: null } });
  if (!file) return null;
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceFileVersion.findMany({ where: { workspaceId, fileId }, orderBy: { version: "desc" } }),
  );
  const latest = rows[0];
  return [
    {
      id: null,
      version: file.version,
      current: true,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      createdBy: latest?.replacedBy ?? file.createdBy,
      createdAt: (latest?.replacedAt ?? file.createdAt).toISOString(),
      replacedAt: null,
    },
    ...rows.map((r) => ({
      id: r.id,
      version: r.version,
      current: false,
      filename: r.filename,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      replacedAt: r.replacedAt.toISOString(),
    })),
  ];
}

/** The bytes of one version (the current one when `version` is the file's). Null = not found. */
export async function readFileVersion(
  workspaceId: string,
  fileId: string,
  version: number,
): Promise<{ bytes: Buffer; filename: string; mimeType: string; version: number; current: boolean } | null> {
  const file = await prisma.workspaceFile.findFirst({ where: { id: fileId, workspaceId, trashedAt: null } });
  if (!file) return null;
  const adapter = getStorageAdapter();
  if (version === file.version) {
    const bytes = await adapter.get(file.storageKey);
    return bytes ? { bytes, filename: file.filename, mimeType: file.mimeType, version, current: true } : null;
  }
  const row = await withWorkspaceScope(workspaceId, (tx) => tx.workspaceFileVersion.findFirst({ where: { workspaceId, fileId, version } }));
  if (!row) return null;
  const bytes = await adapter.get(row.storageKey);
  return bytes ? { bytes, filename: row.filename, mimeType: row.mimeType, version, current: false } : null;
}

/** Restore = write that version's bytes as a NEW version (the current one is kept). */
export async function restoreFileVersion(workspaceId: string, fileId: string, version: number, userId: string): Promise<OverwriteResult> {
  const v = await readFileVersion(workspaceId, fileId, version);
  if (!v) throw new FsError("not_found", "Version not found.");
  if (v.current) throw new FsError("invalid_state", "That is already the current version.");
  return overwriteFile({ workspaceId, fileId, bytes: v.bytes, mimeType: v.mimeType, userId, skipSafety: true, reason: "restore", restoredFrom: version, maxBytes: Math.max(v.bytes.length, DEFAULT_MAX_FILE_BYTES) });
}

export async function getVersionRetention(workspaceId: string): Promise<number> {
  const q = await prisma.workspaceQuota.findUnique({ where: { workspaceId }, select: { versionRetention: true } });
  return q?.versionRetention ?? DEFAULT_VERSION_RETENTION;
}

/** Admin setting. Lowering it purges the extra versions of every file now. */
export async function setVersionRetention(workspaceId: string, keep: number): Promise<{ keep: number; purged: number }> {
  const c = checkRetention(keep);
  if (!c.ok) throw new FsError("invalid_path", c.reason);
  await prisma.workspaceQuota.upsert({
    where: { workspaceId },
    create: { workspaceId, limitBytes: BigInt(DEFAULT_QUOTA_BYTES), usedBytes: BigInt(0), versionRetention: c.value },
    update: { versionRetention: c.value },
  });
  const all = await withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceFileVersion.findMany({ where: { workspaceId }, select: { id: true, fileId: true, version: true, storageKey: true, sizeBytes: true } }),
  );
  const byFile = new Map<string, typeof all>();
  for (const r of all) byFile.set(r.fileId, [...(byFile.get(r.fileId) ?? []), r]);
  const drop = [...byFile.values()].flatMap((list) => versionsToPurge(list, c.value));
  if (drop.length) {
    await withWorkspaceScope(workspaceId, async (tx) => {
      await tx.workspaceFileVersion.deleteMany({ where: { workspaceId, id: { in: drop.map((d) => d.id) } } });
      await tx.workspaceQuota.update({ where: { workspaceId }, data: { usedBytes: { decrement: BigInt(drop.reduce((n, d) => n + d.sizeBytes, 0)) } } });
    });
    const adapter = getStorageAdapter();
    for (const d of drop) await adapter.delete(d.storageKey).catch(() => undefined);
  }
  return { keep: c.value, purged: drop.length };
}

/**
 * The previous versions of files about to be purged: their bytes and size.
 * lib/filesystem/service.ts deleteFile / purgeExpiredTrash call this so a
 * purge frees every version's bytes and quota, not just the current one.
 */
export async function versionBlobsOf(workspaceId: string, fileIds: string[]): Promise<Array<{ storageKey: string; sizeBytes: number }>> {
  if (fileIds.length === 0) return [];
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceFileVersion.findMany({ where: { workspaceId, fileId: { in: fileIds } }, select: { storageKey: true, sizeBytes: true } }),
  );
}
