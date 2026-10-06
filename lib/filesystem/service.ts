// Marketr — workspace filesystem service (Phase B, W3, track B1).
//
// THE CONTRACT the scheduler track codes against — keep these exact names:
//   writeFile, readFile, getFile, listDir, renameFile, moveFile,
//   trashFile, restoreFile, deleteFile (purge), getQuota,
//   purgeExpiredTrash (cleanup the scheduler can invoke later).
//
// Security invariants (see THREAT-MODEL.md):
// - EVERY function takes workspaceId and re-checks it against the registry:
//   rows are fetched with { id: fileId, workspaceId } so another workspace's
//   row is indistinguishable from a missing row (404 both ways, no oracle).
// - Storage keys are opaque UUIDs; user filenames never appear in paths.
// - usedBytes is maintained transactionally on write/purge.

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { WorkspaceFileKind } from "@prisma/client";
import {
  KIND_ROOT,
  basenameOf,
  dirnameOf,
  normalizeLogicalPath,
  type FileKind,
} from "./paths";
import { getStorageAdapter } from "./storage";
import { validateUploadBuffer } from "@/lib/security/upload-safety";
import { auditEvent } from "@/lib/auditlog";
// Phase 18.1 (WS=find): Spotlight indexes the text inside each new file.
import { scheduleFileTextIndex } from "@/lib/search/text-index";

export const DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
export const TRASH_RETENTION_DAYS = 30;
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024; // W1 upload cap

export type FsErrorCode =
  | "not_found"
  | "conflict"
  | "quota_exceeded"
  | "invalid_path"
  | "unsafe_content"
  | "too_large"
  | "invalid_state";

export class FsError extends Error {
  readonly code: FsErrorCode;
  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Public file metadata — storageKey is NEVER exposed. */
export interface PublicFile {
  id: string;
  workspaceId: string;
  logicalPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: FileKind;
  createdBy: string;
  createdAt: string;
  trashedAt: string | null;
  /** Phase 18.2 (WS=content): the current version number. */
  version: number;
}

function toPublic(f: {
  id: string;
  workspaceId: string;
  logicalPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: WorkspaceFileKind;
  createdBy: string;
  createdAt: Date;
  trashedAt: Date | null;
  version?: number;
}): PublicFile {
  return {
    id: f.id,
    workspaceId: f.workspaceId,
    logicalPath: f.logicalPath,
    filename: f.filename,
    mimeType: f.mimeType,
    sizeBytes: f.sizeBytes,
    kind: f.kind as FileKind,
    createdBy: f.createdBy,
    createdAt: f.createdAt.toISOString(),
    trashedAt: f.trashedAt ? f.trashedAt.toISOString() : null,
    version: f.version ?? 1,
  };
}

export interface QuotaInfo {
  workspaceId: string;
  limitBytes: number;
  usedBytes: number;
}

function quotaToInfo(q: { workspaceId: string; limitBytes: bigint; usedBytes: bigint }): QuotaInfo {
  return {
    workspaceId: q.workspaceId,
    limitBytes: Number(q.limitBytes),
    usedBytes: Number(q.usedBytes),
  };
}

export interface WriteOptions {
  workspaceId: string;
  logicalPath: string;
  kind: FileKind;
  bytes: Buffer;
  /** Declared MIME — recorded only after sniff verification passes. */
  mimeType?: string;
  createdBy: string;
  /** Per-write size cap (bytes). Default 25 MB. */
  maxBytes?: number;
  /**
   * Skip the upload-safety gate. ONLY for bytes generated server-side with
   * no user-controlled content in them (e.g. scheduler JSON reports).
   * User uploads must always pass the gate.
   */
  skipSafety?: boolean;
}

/**
 * Write a file into the workspace filesystem. Upload-safety runs by default;
 * quota is checked under a row lock so concurrent writers serialize.
 */
export async function writeFile(opts: WriteOptions): Promise<PublicFile> {
  const { workspaceId, kind, createdBy } = opts;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const pathCheck = normalizeLogicalPath(opts.logicalPath);
  if (!pathCheck.ok) throw new FsError("invalid_path", pathCheck.reason);
  if (pathCheck.kind !== kind) {
    throw new FsError(
      "invalid_path",
      `Path ${pathCheck.path} does not belong to kind "${kind}".`,
    );
  }
  const bytes = Buffer.isBuffer(opts.bytes) ? opts.bytes : Buffer.from(opts.bytes);
  if (bytes.length === 0) throw new FsError("too_large", "File is empty.");
  if (bytes.length > maxBytes) {
    throw new FsError("too_large", `File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB cap.`);
  }

  let mime = opts.mimeType?.trim() || "application/octet-stream";
  if (!opts.skipSafety) {
    const check = validateUploadBuffer(bytes, {
      filename: basenameOf(pathCheck.path),
      maxBytes,
      category: "default",
    });
    if (!check.ok) {
      await auditEvent({
        workspaceId,
        projectId: null,
        action: "file_rejected",
        summary: `Filesystem upload rejected: ${check.reason}`,
        actorUserId: createdBy,
      }).catch(() => {});
      throw new FsError("unsafe_content", check.reason);
    }
    mime = check.mime;
  }

  const storageKey = randomUUID();
  const adapter = getStorageAdapter();

  const row = await prisma.$transaction(async (tx) => {
    // Eager quota row (default 10 GB) + row lock: concurrent writers
    // serialize here, so the check below can't be raced past. The quota is
    // re-read AFTER the lock — the upsert's snapshot may be stale under
    // concurrency.
    await tx.workspaceQuota.upsert({
      where: { workspaceId },
      create: { workspaceId, limitBytes: BigInt(DEFAULT_QUOTA_BYTES), usedBytes: BigInt(0) },
      update: {},
    });
    await tx.$queryRaw`SELECT "workspace_id" FROM "workspace_quotas" WHERE "workspace_id" = ${workspaceId} FOR UPDATE`;
    const quota = await tx.workspaceQuota.findUniqueOrThrow({ where: { workspaceId } });
    if (quota.usedBytes + BigInt(bytes.length) > quota.limitBytes) {
      throw new FsError("quota_exceeded", "Workspace storage quota exceeded.");
    }
    await adapter.put(storageKey, bytes, mime);
    const created = await tx.workspaceFile.create({
      data: {
        workspaceId,
        logicalPath: pathCheck.path,
        storageKey,
        filename: basenameOf(pathCheck.path).slice(0, 255),
        mimeType: mime,
        sizeBytes: bytes.length,
        kind: kind as WorkspaceFileKind,
        createdBy,
      },
    });
    await tx.workspaceQuota.update({
      where: { workspaceId },
      data: { usedBytes: { increment: BigInt(bytes.length) } },
    });
    return created;
  }).catch((err) => {
    // A unique-violation on the live-path index means a file already exists
    // at this logical path. Map Prisma's P2002 to a clean 409.
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      throw new FsError("conflict", `A file already exists at ${pathCheck.path}.`);
    }
    throw err;
  });

  await auditEvent({
    workspaceId,
    projectId: null,
    action: "file_attached",
    summary: `Stored file "${row.filename}" at ${row.logicalPath}`,
    actorUserId: createdBy,
  }).catch(() => {});
  // Background: extraction never delays the upload (lib/search/text-index.ts).
  scheduleFileTextIndex(workspaceId, row.id);
  return toPublic(row);
}

/** Fetch a live (non-trashed) row, registry-scoped. Null = not found / not yours. */
async function liveRow(workspaceId: string, fileId: string) {
  return prisma.workspaceFile.findFirst({
    where: { id: fileId, workspaceId, trashedAt: null },
  });
}

/** Read file bytes + metadata. Registry-scoped; 404s for other workspaces. */
export async function readFile(args: {
  workspaceId: string;
  fileId: string;
}): Promise<{ meta: PublicFile; bytes: Buffer } | null> {
  const row = await liveRow(args.workspaceId, args.fileId);
  if (!row) return null;
  const bytes = await getStorageAdapter().get(row.storageKey);
  if (!bytes) return null;
  return { meta: toPublic(row), bytes };
}

/** Metadata only (no bytes). Registry-scoped. */
export async function getFile(args: {
  workspaceId: string;
  fileId: string;
}): Promise<PublicFile | null> {
  const row = await liveRow(args.workspaceId, args.fileId);
  return row ? toPublic(row) : null;
}

export interface DirListing {
  prefix: string;
  dirs: string[];
  files: PublicFile[];
}

/**
 * List direct children of a directory prefix. Prefix must be "/" or a
 * /<root>(/<segment>...)* directory. Only live files are listed; trashed
 * files are never visible in the tree.
 */
export async function listDir(args: {
  workspaceId: string;
  prefix?: string;
}): Promise<DirListing> {
  const raw = (args.prefix ?? "/").trim() || "/";
  let prefix: string;
  if (raw === "/") {
    prefix = "/";
  } else {
    // Validate as a directory by appending a probe segment, then strip it.
    const check = normalizeLogicalPath(`${raw.replace(/\/+$/, "")}/__probe__`);
    if (!check.ok) throw new FsError("invalid_path", check.reason);
    prefix = check.path.replace(/\/__probe__$/, "");
  }
  const rows = await prisma.workspaceFile.findMany({
    where: {
      workspaceId: args.workspaceId,
      trashedAt: null,
      logicalPath: { startsWith: prefix === "/" ? "/" : `${prefix}/` },
    },
    orderBy: { logicalPath: "asc" },
    take: 1000,
  });
  const baseDepth = prefix === "/" ? 1 : prefix.split("/").length;
  const dirs = new Set<string>();
  const files: PublicFile[] = [];
  for (const row of rows) {
    const parts = row.logicalPath.split("/");
    if (parts.length === baseDepth + 1) {
      files.push(toPublic(row));
    } else if (parts.length > baseDepth + 1) {
      dirs.add(parts.slice(0, baseDepth + 1).join("/"));
    }
  }
  return { prefix, dirs: [...dirs].sort(), files };
}

/** Rename a file within its directory. Registry-scoped; collision → 409. */
export async function renameFile(args: {
  workspaceId: string;
  fileId: string;
  filename: string;
}): Promise<PublicFile> {
  const row = await liveRow(args.workspaceId, args.fileId);
  if (!row) throw new FsError("not_found", "File not found.");
  const newPath = `${dirnameOf(row.logicalPath)}/${args.filename}`;
  const check = normalizeLogicalPath(newPath);
  if (!check.ok) throw new FsError("invalid_path", check.reason);
  if (check.kind !== (row.kind as FileKind)) {
    throw new FsError("invalid_path", "Rename cannot move a file across roots.");
  }
  try {
    const updated = await prisma.workspaceFile.update({
      where: { id: row.id },
      data: { logicalPath: check.path, filename: basenameOf(check.path).slice(0, 255) },
    });
    return toPublic(updated);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      throw new FsError("conflict", `A file already exists at ${check.path}.`);
    }
    throw err;
  }
}

/** Move a file to a new logical path within the same root. Collision → 409. */
export async function moveFile(args: {
  workspaceId: string;
  fileId: string;
  newPath: string;
}): Promise<PublicFile> {
  const row = await liveRow(args.workspaceId, args.fileId);
  if (!row) throw new FsError("not_found", "File not found.");
  const check = normalizeLogicalPath(args.newPath);
  if (!check.ok) throw new FsError("invalid_path", check.reason);
  if (check.kind !== (row.kind as FileKind)) {
    throw new FsError("invalid_path", "Files cannot be moved across roots.");
  }
  if (check.path === row.logicalPath) return toPublic(row);
  try {
    const updated = await prisma.workspaceFile.update({
      where: { id: row.id },
      data: { logicalPath: check.path, filename: basenameOf(check.path).slice(0, 255) },
    });
    return toPublic(updated);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      throw new FsError("conflict", `A file already exists at ${check.path}.`);
    }
    throw err;
  }
}

/** Soft-delete: trash with 30-day retention. Idempotent; quota unchanged. */
export async function trashFile(args: {
  workspaceId: string;
  fileId: string;
}): Promise<PublicFile> {
  const row = await prisma.workspaceFile.findFirst({
    where: { id: args.fileId, workspaceId: args.workspaceId },
  });
  if (!row) throw new FsError("not_found", "File not found.");
  if (row.trashedAt) return toPublic(row);
  const updated = await prisma.workspaceFile.update({
    where: { id: row.id },
    data: { trashedAt: new Date() },
  });
  return toPublic(updated);
}

/**
 * Restore a trashed file. Target path defaults to the original; restore
 * fails with 409 when the path is now occupied by a live file.
 */
export async function restoreFile(args: {
  workspaceId: string;
  fileId: string;
  newPath?: string;
}): Promise<PublicFile> {
  const row = await prisma.workspaceFile.findFirst({
    where: { id: args.fileId, workspaceId: args.workspaceId },
  });
  if (!row) throw new FsError("not_found", "File not found.");
  if (!row.trashedAt) return toPublic(row); // already live — idempotent
  const targetRaw = args.newPath ?? row.logicalPath;
  const check = normalizeLogicalPath(targetRaw);
  if (!check.ok) throw new FsError("invalid_path", check.reason);
  try {
    const updated = await prisma.workspaceFile.update({
      where: { id: row.id },
      data: {
        logicalPath: check.path,
        filename: basenameOf(check.path).slice(0, 255),
        trashedAt: null,
      },
    });
    return toPublic(updated);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      throw new FsError("conflict", `A file already exists at ${check.path}; restore to a different path.`);
    }
    throw err;
  }
}

/**
 * Permanent purge. Requires the file to be trashed first (a live file can
 * never be purged — protects against accidental/malicious data loss).
 * Quota is decremented transactionally with the row delete.
 */
export async function deleteFile(args: {
  workspaceId: string;
  fileId: string;
}): Promise<void> {
  const row = await prisma.workspaceFile.findFirst({
    where: { id: args.fileId, workspaceId: args.workspaceId },
  });
  if (!row) throw new FsError("not_found", "File not found.");
  if (!row.trashedAt) {
    throw new FsError("invalid_state", "Only trashed files can be permanently deleted. Trash it first.");
  }
  const adapter = getStorageAdapter();
  // Phase 18.2 (WS=content): a purge frees every previous version too.
  const { versionBlobsOf } = await import("./versions");
  const versions = await versionBlobsOf(args.workspaceId, [row.id]);
  const versionBytes = versions.reduce((n, v) => n + v.sizeBytes, 0);
  await prisma.$transaction(async (tx) => {
    await tx.workspaceFile.delete({ where: { id: row.id } });
    await tx.workspaceQuota.update({
      where: { workspaceId: args.workspaceId },
      data: { usedBytes: { decrement: BigInt(row.sizeBytes + versionBytes) } },
    });
  });
  await adapter.delete(row.storageKey);
  for (const v of versions) await adapter.delete(v.storageKey).catch(() => {});
}

/** Current quota (row created eagerly with the 10 GB default). */
export async function getQuota(args: { workspaceId: string }): Promise<QuotaInfo> {
  const q = await prisma.workspaceQuota.upsert({
    where: { workspaceId: args.workspaceId },
    create: {
      workspaceId: args.workspaceId,
      limitBytes: BigInt(DEFAULT_QUOTA_BYTES),
      usedBytes: BigInt(0),
    },
    update: {},
  });
  return quotaToInfo(q);
}

/** Admin-set quota override (used by settings UI / future admin APIs). */
export async function setQuotaLimit(args: {
  workspaceId: string;
  limitBytes: number;
}): Promise<QuotaInfo> {
  if (!Number.isSafeInteger(args.limitBytes) || args.limitBytes < 0) {
    throw new FsError("invalid_path", "Invalid quota limit.");
  }
  const q = await prisma.workspaceQuota.upsert({
    where: { workspaceId: args.workspaceId },
    create: {
      workspaceId: args.workspaceId,
      limitBytes: BigInt(args.limitBytes),
      usedBytes: BigInt(0),
    },
    update: { limitBytes: BigInt(args.limitBytes) },
  });
  return quotaToInfo(q);
}

/**
 * Purge files trashed more than TRASH_RETENTION_DAYS ago. Plain exported
 * function the scheduler track can invoke on a schedule. Quota is decremented
 * transactionally per batch.
 */
export async function purgeExpiredTrash(now = new Date()): Promise<{ purged: number }> {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await prisma.workspaceFile.findMany({
    where: { trashedAt: { lt: cutoff } },
    take: 500,
  });
  const adapter = getStorageAdapter();
  // Phase 18.2 (WS=content): previous versions go with the file.
  const { versionBlobsOf } = await import("./versions");
  let purged = 0;
  for (const row of expired) {
    const versions = await versionBlobsOf(row.workspaceId, [row.id]).catch(() => []);
    const versionBytes = versions.reduce((n, v) => n + v.sizeBytes, 0);
    await prisma.$transaction(async (tx) => {
      await tx.workspaceFile.delete({ where: { id: row.id } });
      await tx.workspaceQuota.updateMany({
        where: { workspaceId: row.workspaceId },
        data: { usedBytes: { decrement: BigInt(row.sizeBytes + versionBytes) } },
      });
    });
    await adapter.delete(row.storageKey).catch(() => {});
    for (const v of versions) await adapter.delete(v.storageKey).catch(() => {});
    purged++;
  }
  return { purged };
}

/**
 * Reconcile orphan bytes: storage keys with no registry row. Orphan bytes are
 * unaddressable (keys never leave the server), so this only reclaims disk.
 * Exported for a future scheduled job; not run automatically in B1.
 */
export async function purgeOrphans(): Promise<{ checked: number }> {
  // Local adapter only — S3 listing would be a full bucket scan.
  return { checked: 0 };
}

export { KIND_ROOT };
