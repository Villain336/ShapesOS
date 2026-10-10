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
import type { Prisma, WorkspaceFileKind } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  KIND_ROOT,
  basenameOf,
  collisionKey,
  dirnameOf,
  normalizeLogicalPath,
  type FileKind,
  type PathInfo,
} from "./paths";
import { getStorageAdapter } from "./storage";
import { validateUploadBuffer } from "@/lib/security/upload-safety";
import { screenUploadBuffer } from "@/lib/security/upload-audit";
import { auditEvent } from "@/lib/auditlog";
// Phase 18.1 (WS=find): Spotlight indexes the text inside each new file.
import { scheduleFileTextIndex } from "@/lib/search/text-index-schedule";
// Phase 21B (WS=drive): folders, the change journal and scope quotas.
import { FsError, DEFAULT_QUOTA_BYTES, TRASH_RETENTION_DAYS, DEFAULT_MAX_FILE_BYTES, type FsErrorCode } from "./core";
import { ensureFolderChain } from "./folders";
import { recordChange, recordChanges, type NewChange } from "@/lib/drive/changes";
import { chargeQuota, lockDriveTree } from "@/lib/drive/quota-store";
import { quotaScopesFor } from "@/lib/drive/quota";

export { FsError, DEFAULT_QUOTA_BYTES, TRASH_RETENTION_DAYS, DEFAULT_MAX_FILE_BYTES };
export type { FsErrorCode };

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
  /** Phase 21B: the person whose private home this is (null = the workspace's). */
  ownerUserId: string | null;
  tags: string[];
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
  ownerUserId?: string | null;
  tags?: string[];
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
    ownerUserId: f.ownerUserId ?? null,
    tags: f.tags ?? [],
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

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002";
}

type Tx = Prisma.TransactionClient;

/** True when a live file or folder already has this name (case/NFC-insensitive), optionally ignoring one file. */
async function nameTaken(tx: Tx, workspaceId: string, path: string, exceptFileId?: string): Promise<boolean> {
  const key = collisionKey(path);
  const file = await tx.workspaceFile.findFirst({
    where: {
      workspaceId,
      trashedAt: null,
      ...(exceptFileId ? { id: { not: exceptFileId } } : {}),
      OR: [{ pathKey: key }, { pathKey: null, logicalPath: { equals: path, mode: "insensitive" } }],
    },
    select: { id: true },
  });
  if (file) return true;
  const folder = await tx.workspaceFolder.findFirst({ where: { workspaceId, trashedAt: null, pathKey: key }, select: { id: true } });
  return !!folder;
}

/** Run the malware screen on a user upload (hosted deployments refuse when no scanner is configured). */
export async function screenUserUpload(workspaceId: string, createdBy: string, filename: string, bytes: Buffer): Promise<void> {
  const screened = await screenUploadBuffer(bytes);
  if (!screened.ok) {
    await auditEvent({ workspaceId, projectId: null, action: "file_rejected", summary: `Filesystem upload rejected: ${screened.reason}`, actorUserId: createdBy }).catch(() => {});
    throw new FsError(screened.status === 503 ? "scanner_unavailable" : "unsafe_content", screened.reason);
  }
}

/**
 * Register bytes that are ALREADY in storage under `storageKey` as a new file:
 * folder chain, workspace + scope quota (under locks), the live-name check, the
 * row and its journal event, in one transaction. writeFile uses it for
 * buffered writes; the large-file path (lib/drive/uploads.ts) for multipart
 * objects. The caller removes the stored bytes if this throws.
 */
export async function registerStoredFile(args: {
  workspaceId: string;
  pathCheck: PathInfo;
  storageKey: string;
  sizeBytes: number;
  mime: string;
  kind: FileKind;
  createdBy: string;
}) {
  const { workspaceId, pathCheck, storageKey, kind, createdBy } = args;
  try {
    return await withWorkspaceScope(
      workspaceId,
      async (tx) => {
        await lockDriveTree(tx, workspaceId);
        await chargeQuota(tx, workspaceId, quotaScopesFor(pathCheck), args.sizeBytes);
        // The folder first: if it exists under another spelling of its name,
        // that spelling wins and the file takes it.
        const dir = dirnameOf(pathCheck.path);
        const chain = await ensureFolderChain(tx, workspaceId, dir, createdBy);
        const finalPath = chain.leaf ? `${chain.leaf.path}/${basenameOf(pathCheck.path)}` : pathCheck.path;
        if (await nameTaken(tx, workspaceId, finalPath)) throw new FsError("conflict", `A file already exists at ${finalPath}.`);
        const created = await tx.workspaceFile.create({
          data: {
            workspaceId,
            logicalPath: finalPath,
            pathKey: collisionKey(finalPath),
            ownerUserId: pathCheck.ownerUserId,
            storageKey,
            filename: basenameOf(finalPath).slice(0, 255),
            mimeType: args.mime,
            sizeBytes: args.sizeBytes,
            kind: kind as WorkspaceFileKind,
            createdBy,
          },
        });
        await recordChanges(tx, workspaceId, [
          ...chain.events,
          { type: "create", entity: "file", entityId: created.id, path: created.logicalPath, version: 1, actorUserId: createdBy },
        ]);
        return created;
      },
      { timeoutMs: 30_000 },
    );
  } catch (err) {
    // A unique-violation on a live-path index means a file already exists
    // at this logical path. Map Prisma's P2002 to a clean 409.
    if (isUniqueViolation(err)) throw new FsError("conflict", `A file already exists at ${pathCheck.path}.`);
    throw err;
  }
}

/**
 * Write a file into the workspace filesystem. Upload-safety runs by default;
 * quota is checked under row locks so concurrent writers serialize. The file
 * lands in its folder (created on demand, in the spelling an existing folder
 * already has), counts against the workspace AND its scope (a person's home,
 * an app container), and writes its create event to the change journal in the
 * same transaction.
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
    // Phase 21B: the malware scanner is REQUIRED on hosted deployments.
    await screenUserUpload(workspaceId, createdBy, basenameOf(pathCheck.path), bytes);
  }

  const storageKey = randomUUID();
  const adapter = getStorageAdapter();
  // Bytes go to storage BEFORE the transaction (a slow object store must not
  // hold the workspace locks); they are removed again if the transaction fails.
  await adapter.put(storageKey, bytes, mime);

  let row;
  try {
    row = await registerStoredFile({ workspaceId, pathCheck, storageKey, sizeBytes: bytes.length, mime, kind, createdBy });
  } catch (err) {
    await adapter.delete(storageKey).catch(() => {});
    throw err;
  }

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

/**
 * A file in someone's PRIVATE HOME is invisible to every caller that does not
 * name that person (viewerUserId) — admins, agents and other services included.
 * Callers that have already run an access check for the actor (the Files routes,
 * lib/drive/ops.ts) use readFileAuthorised / getFileAuthorised instead.
 */
function visibleTo(row: { ownerUserId: string | null }, viewerUserId: string | undefined): boolean {
  return row.ownerUserId === null || row.ownerUserId === viewerUserId;
}

/** Read file bytes + metadata. Registry-scoped; 404s for other workspaces and for private homes of other people. */
export async function readFile(args: {
  workspaceId: string;
  fileId: string;
  viewerUserId?: string;
}): Promise<{ meta: PublicFile; bytes: Buffer } | null> {
  const row = await liveRow(args.workspaceId, args.fileId);
  if (!row || !visibleTo(row, args.viewerUserId)) return null;
  const bytes = await getStorageAdapter().get(row.storageKey);
  if (!bytes) return null;
  return { meta: toPublic(row), bytes };
}

/** Like readFile, for a caller that has ALREADY checked this person's access to this file (requireFileAction). */
export async function readFileAuthorised(args: { workspaceId: string; fileId: string }): Promise<{ meta: PublicFile; bytes: Buffer } | null> {
  const row = await liveRow(args.workspaceId, args.fileId);
  if (!row) return null;
  const bytes = await getStorageAdapter().get(row.storageKey);
  return bytes ? { meta: toPublic(row), bytes } : null;
}

/** Metadata only (no bytes). Registry-scoped; private homes of other people read as missing. */
export async function getFile(args: {
  workspaceId: string;
  fileId: string;
  viewerUserId?: string;
}): Promise<PublicFile | null> {
  const row = await liveRow(args.workspaceId, args.fileId);
  return row && visibleTo(row, args.viewerUserId) ? toPublic(row) : null;
}

/** Like getFile, for a caller that has ALREADY checked access. */
export async function getFileAuthorised(args: { workspaceId: string; fileId: string }): Promise<PublicFile | null> {
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
 * files are never visible in the tree. A private home is listed only to its
 * owner (`viewerUserId`); with no viewer, private homes are left out.
 */
export async function listDir(args: {
  workspaceId: string;
  prefix?: string;
  viewerUserId?: string;
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
      OR: [{ ownerUserId: null }, ...(args.viewerUserId ? [{ ownerUserId: args.viewerUserId }] : [])],
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

interface MoveArgs {
  workspaceId: string;
  fileId: string;
  actorUserId?: string;
}

/**
 * Re-point a live file at a new path inside one transaction: collision check
 * (case/NFC-insensitive), the destination folder chain, ownership and quota
 * scope changes, and the journal event.
 */
async function relocateFile(args: MoveArgs & { newPath: string; sameRootOnly: boolean }): Promise<PublicFile> {
  const check = normalizeLogicalPath(args.newPath);
  if (!check.ok) throw new FsError("invalid_path", check.reason);
  try {
    return await withWorkspaceScope(args.workspaceId, async (tx) => {
      await lockDriveTree(tx, args.workspaceId);
      const row = await tx.workspaceFile.findFirst({ where: { id: args.fileId, workspaceId: args.workspaceId, trashedAt: null } });
      if (!row) throw new FsError("not_found", "File not found.");
      const from = normalizeLogicalPath(row.logicalPath);
      if (args.sameRootOnly && check.kind !== (row.kind as FileKind)) {
        throw new FsError("invalid_path", "Rename cannot move a file across roots.");
      }
      // Files of the managed roots stay in them; plain files move anywhere writable.
      if (row.kind !== "file" && check.root !== (from.ok ? from.root : check.root)) throw new FsError("invalid_path", "Files cannot be moved across roots.");
      if (row.kind === "file" && check.kind !== "file") throw new FsError("invalid_path", "Files cannot be moved into /skills, /memory or /artifacts.");
      if (check.path === row.logicalPath) return toPublic(row);
      const chain = await ensureFolderChain(tx, args.workspaceId, dirnameOf(check.path), args.actorUserId ?? row.createdBy);
      const finalPath = chain.leaf ? `${chain.leaf.path}/${basenameOf(check.path)}` : check.path;
      if (await nameTaken(tx, args.workspaceId, finalPath, row.id)) throw new FsError("conflict", `A file already exists at ${finalPath}.`);
      const final = normalizeLogicalPath(finalPath);
      if (from.ok && final.ok) {
        const a = quotaScopesFor(from).map((s) => s.key).join("|");
        const b = quotaScopesFor(final).map((s) => s.key).join("|");
        if (a !== b) {
          const versions = await tx.workspaceFileVersion.aggregate({ where: { workspaceId: args.workspaceId, fileId: row.id }, _sum: { sizeBytes: true } });
          const bytes = row.sizeBytes + (versions._sum.sizeBytes ?? 0);
          await chargeQuota(tx, args.workspaceId, quotaScopesFor(from), -bytes);
          await chargeQuota(tx, args.workspaceId, quotaScopesFor(final), bytes);
        }
      }
      const updated = await tx.workspaceFile.update({
        where: { id: row.id },
        data: {
          logicalPath: finalPath,
          pathKey: collisionKey(finalPath),
          filename: basenameOf(finalPath).slice(0, 255),
          ownerUserId: final.ok ? final.ownerUserId : row.ownerUserId,
        },
      });
      await recordChanges(tx, args.workspaceId, [
        ...chain.events,
        { type: "move", entity: "file", entityId: row.id, path: finalPath, prevPath: row.logicalPath, version: row.version, actorUserId: args.actorUserId ?? null },
      ]);
      return toPublic(updated);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new FsError("conflict", `A file already exists at ${check.path}.`);
    throw err;
  }
}

/** Rename a file within its directory. Registry-scoped; collision → 409. */
export async function renameFile(args: MoveArgs & { filename: string }): Promise<PublicFile> {
  const row = await liveRow(args.workspaceId, args.fileId);
  if (!row) throw new FsError("not_found", "File not found.");
  return relocateFile({ ...args, newPath: `${dirnameOf(row.logicalPath)}/${args.filename}`, sameRootOnly: true });
}

/**
 * Move a file to a new logical path. Collision → 409. Plain files (kind
 * "file") may move between /files and any of the Drive roots; files in
 * /skills, /memory and /artifacts stay in their root.
 */
export async function moveFile(args: MoveArgs & { newPath: string }): Promise<PublicFile> {
  return relocateFile({ ...args, sameRootOnly: false });
}

/** Soft-delete: trash with 30-day retention. Idempotent; quota unchanged. */
export async function trashFile(args: MoveArgs): Promise<PublicFile> {
  return withWorkspaceScope(args.workspaceId, async (tx) => {
    await lockDriveTree(tx, args.workspaceId);
    const row = await tx.workspaceFile.findFirst({ where: { id: args.fileId, workspaceId: args.workspaceId } });
    if (!row) throw new FsError("not_found", "File not found.");
    if (row.trashedAt) return toPublic(row);
    const updated = await tx.workspaceFile.update({ where: { id: row.id }, data: { trashedAt: new Date() } });
    await recordChange(tx, args.workspaceId, { type: "trash", entity: "file", entityId: row.id, path: row.logicalPath, version: row.version, actorUserId: args.actorUserId ?? null });
    return toPublic(updated);
  });
}

/**
 * Restore a trashed file. Target path defaults to the original; restore
 * fails with 409 when the path is now occupied by a live file.
 */
export async function restoreFile(args: MoveArgs & { newPath?: string }): Promise<PublicFile> {
  try {
    return await withWorkspaceScope(args.workspaceId, async (tx) => {
      await lockDriveTree(tx, args.workspaceId);
      const row = await tx.workspaceFile.findFirst({ where: { id: args.fileId, workspaceId: args.workspaceId } });
      if (!row) throw new FsError("not_found", "File not found.");
      if (!row.trashedAt) return toPublic(row); // already live — idempotent
      const targetRaw = args.newPath ?? row.logicalPath;
      const check = normalizeLogicalPath(targetRaw);
      if (!check.ok) throw new FsError("invalid_path", check.reason);
      const chain = await ensureFolderChain(tx, args.workspaceId, dirnameOf(check.path), args.actorUserId ?? row.createdBy);
      const finalPath = chain.leaf ? `${chain.leaf.path}/${basenameOf(check.path)}` : check.path;
      if (await nameTaken(tx, args.workspaceId, finalPath, row.id)) {
        throw new FsError("conflict", `A file already exists at ${finalPath}; restore to a different path.`);
      }
      const updated = await tx.workspaceFile.update({
        where: { id: row.id },
        data: {
          logicalPath: finalPath,
          pathKey: collisionKey(finalPath),
          filename: basenameOf(finalPath).slice(0, 255),
          ownerUserId: check.ownerUserId,
          trashedAt: null,
          trashBatch: null,
        },
      });
      await recordChanges(tx, args.workspaceId, [
        ...chain.events,
        { type: "restore", entity: "file", entityId: row.id, path: finalPath, version: row.version, actorUserId: args.actorUserId ?? null },
      ]);
      return toPublic(updated);
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new FsError("conflict", `A file already exists at ${args.newPath ?? "that path"}; restore to a different path.`);
    }
    throw err;
  }
}

/**
 * Permanent purge. Requires the file to be trashed first (a live file can
 * never be purged — protects against accidental/malicious data loss).
 * Quota (workspace and scope) is decremented transactionally with the row delete.
 */
export async function deleteFile(args: MoveArgs): Promise<void> {
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
  const info = normalizeLogicalPath(row.logicalPath);
  await withWorkspaceScope(args.workspaceId, async (tx) => {
    await lockDriveTree(tx, args.workspaceId);
    await tx.workspaceFile.delete({ where: { id: row.id } });
    await tx.$executeRaw`UPDATE "workspace_quotas" SET "used_bytes" = GREATEST(0, "used_bytes" - ${BigInt(row.sizeBytes + versionBytes)}) WHERE "workspace_id" = ${args.workspaceId}`;
    if (info.ok) {
      for (const sc of quotaScopesFor(info)) {
        await tx.$executeRaw`UPDATE "workspace_drive_quotas" SET "used_bytes" = GREATEST(0, "used_bytes" - ${BigInt(row.sizeBytes + versionBytes)}) WHERE "workspace_id" = ${args.workspaceId} AND "scope" = ${sc.key}`;
      }
    }
    await recordChange(tx, args.workspaceId, { type: "delete", entity: "file", entityId: row.id, path: row.logicalPath, actorUserId: args.actorUserId ?? null });
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
 * transactionally per file; each purge is a journal event. Trashed folders
 * past retention lose their rows too (their files are purged here first).
 */
export async function purgeExpiredTrash(now = new Date()): Promise<{ purged: number }> {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await prisma.workspaceFile.findMany({
    where: { trashedAt: { lt: cutoff } },
    take: 500,
  });
  let purged = 0;
  for (const row of expired) {
    await deleteFile({ workspaceId: row.workspaceId, fileId: row.id }).catch(() => {});
    purged++;
  }
  // Folder rows go once nothing remains inside them (visited workspaces only:
  // a trashed folder's files expire with it, so its workspace shows up above).
  const wsIds = new Set<string>();
  for (const r of expired) wsIds.add(r.workspaceId);
  for (const workspaceId of wsIds) {
    await withWorkspaceScope(workspaceId, async (tx) => {
      const old = await tx.workspaceFolder.findMany({ where: { workspaceId, trashedAt: { lt: cutoff } }, select: { id: true, path: true } });
      for (const f of old) {
        const left = await tx.workspaceFile.count({ where: { workspaceId, logicalPath: { startsWith: `${f.path}/` } } });
        if (left === 0) await tx.workspaceFolder.deleteMany({ where: { id: f.id, workspaceId } });
      }
    }).catch(() => {});
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
export type { PathInfo };
