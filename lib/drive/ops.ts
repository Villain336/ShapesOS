// ShapesOS — Phase 21B (WS=drive): actor-aware Drive operations — the layer the
// routes, the Files app and the agent tools call. The mechanics (collisions,
// quotas, the journal) are lib/filesystem/{service,folders,versions}.ts; this
// layer decides WHO may do WHAT: the root policy (roots.ts), the person's role
// on the folder or file (acl.ts via access.ts: folder ACLs with inheritance and
// private homes), and nothing else. No operation here ever skips either.

import { ForbiddenError, NotFoundError } from "@/lib/api/errors";
import { normalizeFolderPath, type PathInfo } from "../filesystem/paths";
import { FsError } from "../filesystem/core";
import { fileCan, type FileAction, type FileRole } from "../files/acl";
import { driveRoleFor, type DriveActor } from "./access";
import { personMayWriteTo } from "./roots";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { collisionKey, dirnameOf, basenameOf, normalizeLogicalPath, sanitizeUploadName } from "../filesystem/paths";
import { deleteFile, moveFile, restoreFile, trashFile, writeFile, renameFile, screenUserUpload, type PublicFile } from "../filesystem/service";
import { moveFolder, restoreFolder, trashFolder, createFolder, type PublicFolder } from "../filesystem/folders";
import { overwriteFile } from "../filesystem/versions";
import { requireFileAction } from "../files/access";
import { extractZip, type SkippedEntry } from "./extract";

/** Validate a folder path and make sure this person may add to it. Returns its parsed path. */
export async function requireDirWrite(actor: DriveActor, dirPath: string): Promise<PathInfo> {
  const info = normalizeFolderPath(dirPath);
  if (!info.ok) throw new FsError("invalid_path", info.reason);
  const policy = personMayWriteTo(info, actor.userId);
  if (!policy.ok) {
    // Someone else's home does not exist as far as this person can tell.
    if (info.root === "/home") throw new NotFoundError("Folder not found.");
    throw new ForbiddenError(policy.reason);
  }
  const role = await driveRoleFor(actor, { path: info.path, ownerUserId: info.ownerUserId, createdBy: null });
  if (!role) throw new NotFoundError("Folder not found.");
  if (!fileCan(role, "edit")) throw new ForbiddenError("Your access to this folder doesn't allow adding files.");
  return info;
}

/** Throw unless the person's role on a folder allows `action` (404 when it is not theirs to see). */
export async function requireFolderAction(actor: DriveActor, folder: { path: string; ownerUserId: string | null; createdBy?: string | null }, action: FileAction): Promise<FileRole> {
  const role = await driveRoleFor(actor, { path: folder.path, ownerUserId: folder.ownerUserId, createdBy: folder.createdBy ?? null });
  if (!role) throw new NotFoundError("Folder not found.");
  if (!fileCan(role, action)) throw new ForbiddenError("Your access to this folder doesn't allow that.");
  return role;
}

// ---------------------------------------------------------------------------
// Actor-aware file and folder operations
// ---------------------------------------------------------------------------


/** The live file at this canonical path (case/NFC-insensitive), or null. */
export async function findLiveFileByPath(workspaceId: string, path: string) {
  const key = collisionKey(path);
  return prisma.workspaceFile.findFirst({
    where: { workspaceId, trashedAt: null, OR: [{ pathKey: key }, { pathKey: null, logicalPath: { equals: path, mode: "insensitive" } }] },
  });
}

export async function findLiveFolderByPath(workspaceId: string, path: string) {
  return withWorkspaceScope(workspaceId, (tx) => tx.workspaceFolder.findFirst({ where: { workspaceId, pathKey: collisionKey(path), trashedAt: null } }));
}

/**
 * Save bytes as a file in a folder: a new file, or (overwrite: true) a new
 * version of the file already there. The person needs write access to the
 * folder (new file) or the "version" right on the file (overwrite).
 */
export async function writeFileAs(
  actor: DriveActor,
  args: { dir: string; filename: string; bytes: Buffer; mimeType?: string; overwrite?: boolean; maxBytes?: number; baseVersion?: number },
): Promise<{ file: PublicFile; created: boolean; version: number }> {
  const dir = await requireDirWrite(actor, args.dir);
  const name = sanitizeUploadName(args.filename);
  const target = normalizeLogicalPath(`${dir.path}/${name}`);
  if (!target.ok) throw new FsError("invalid_path", target.reason);
  const existing = await findLiveFileByPath(actor.workspaceId, target.path);
  if (args.baseVersion !== undefined && !existing) {
    throw new FsError("stale_version", "This file no longer exists on the server (moved or in the Trash).", { currentVersion: null });
  }
  if (existing) {
    if (!args.overwrite && args.baseVersion === undefined) throw new FsError("conflict", `A file already exists at ${existing.logicalPath}.`);
    await requireFileAction(actor, existing.id, "version");
    const res = await overwriteFile({ workspaceId: actor.workspaceId, fileId: existing.id, bytes: args.bytes, mimeType: args.mimeType, userId: actor.userId, maxBytes: args.maxBytes, expectVersion: args.baseVersion });
    const row = await prisma.workspaceFile.findFirstOrThrow({ where: { id: existing.id, workspaceId: actor.workspaceId } });
    const { getFileAuthorised } = await import("../filesystem/service");
    return { file: (await getFileAuthorised({ workspaceId: actor.workspaceId, fileId: row.id }))!, created: false, version: res.version };
  }
  const file = await writeFile({ workspaceId: actor.workspaceId, logicalPath: target.path, kind: target.kind, bytes: args.bytes, mimeType: args.mimeType, createdBy: actor.userId, maxBytes: args.maxBytes });
  return { file, created: true, version: 1 };
}

export async function createFolderAs(actor: DriveActor, path: string): Promise<PublicFolder> {
  const info = await requireDirWrite(actor, dirnameOf(path) === "/" ? path : dirnameOf(path));
  const full = normalizeFolderPath(path);
  if (!full.ok) throw new FsError("invalid_path", full.reason);
  void info;
  return createFolder({ workspaceId: actor.workspaceId, path: full.path, createdBy: actor.userId });
}

async function folderRow(actor: DriveActor, folderId: string, includeTrashed = false) {
  const f = await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceFolder.findFirst({ where: { id: folderId, workspaceId: actor.workspaceId, ...(includeTrashed ? {} : { trashedAt: null }) } }));
  if (!f) throw new NotFoundError("Folder not found.");
  return f;
}

/** Move or rename a file or folder to a new full path. */
export async function moveItemAs(actor: DriveActor, args: { kind: "file" | "folder"; id: string; to: string }): Promise<PublicFile | PublicFolder> {
  const dest = normalizeFolderPath(dirnameOf(args.to));
  if (!dest.ok) throw new FsError("invalid_path", dest.reason);
  await requireDirWrite(actor, dest.path);
  if (args.kind === "file") {
    await requireFileAction(actor, args.id, "edit");
    return moveFile({ workspaceId: actor.workspaceId, fileId: args.id, newPath: args.to, actorUserId: actor.userId });
  }
  const f = await folderRow(actor, args.id);
  await requireFolderAction(actor, f, "edit");
  return moveFolder({ workspaceId: actor.workspaceId, folderId: args.id, newPath: args.to, actorUserId: actor.userId });
}

export async function renameItemAs(actor: DriveActor, args: { kind: "file" | "folder"; id: string; name: string }): Promise<PublicFile | PublicFolder> {
  if (args.kind === "file") {
    await requireFileAction(actor, args.id, "edit");
    return renameFile({ workspaceId: actor.workspaceId, fileId: args.id, filename: args.name, actorUserId: actor.userId });
  }
  const f = await folderRow(actor, args.id);
  await requireFolderAction(actor, f, "edit");
  return moveFolder({ workspaceId: actor.workspaceId, folderId: args.id, newPath: `${dirnameOf(f.path)}/${args.name}`, actorUserId: actor.userId });
}

/** Send to the Trash (reversible for 30 days). */
export async function trashItemAs(actor: DriveActor, args: { kind: "file" | "folder"; id: string }): Promise<{ trashed: number }> {
  if (args.kind === "file") {
    await requireFileAction(actor, args.id, "trash");
    await trashFile({ workspaceId: actor.workspaceId, fileId: args.id, actorUserId: actor.userId });
    return { trashed: 1 };
  }
  const f = await folderRow(actor, args.id);
  await requireFolderAction(actor, f, "trash");
  const r = await trashFolder({ workspaceId: actor.workspaceId, folderId: args.id, actorUserId: actor.userId });
  return { trashed: 1 + r.files + r.folders };
}

async function trashedFileRole(actor: DriveActor, fileId: string) {
  const row = await prisma.workspaceFile.findFirst({ where: { id: fileId, workspaceId: actor.workspaceId, trashedAt: { not: null } } });
  if (!row) throw new NotFoundError("File not found in the trash.");
  const role = await driveRoleFor(actor, { path: row.logicalPath, ownerUserId: row.ownerUserId, createdBy: row.createdBy, fileId: row.id });
  if (!role) throw new NotFoundError("File not found in the trash.");
  return { row, role };
}

/** Put something back from the Trash where it was. */
export async function restoreItemAs(actor: DriveActor, args: { kind: "file" | "folder"; id: string }): Promise<PublicFile | { folder: PublicFolder; files: number; folders: number }> {
  if (args.kind === "file") {
    const { role } = await trashedFileRole(actor, args.id);
    if (!fileCan(role, "trash")) throw new ForbiddenError("Your access to this file doesn't allow restoring it.");
    return restoreFile({ workspaceId: actor.workspaceId, fileId: args.id, actorUserId: actor.userId });
  }
  const f = await folderRow(actor, args.id, true);
  await requireFolderAction(actor, f, "trash");
  return restoreFolder({ workspaceId: actor.workspaceId, folderId: args.id, actorUserId: actor.userId });
}

/** Delete one trashed file for good. Its owner or an admin only; it must already be in the Trash. */
export async function removeFromTrashAs(actor: DriveActor, fileId: string): Promise<void> {
  const { role } = await trashedFileRole(actor, fileId);
  if (!fileCan(role, "manageAccess")) throw new ForbiddenError("Only the file's owner or an admin can remove it for good.");
  await deleteFile({ workspaceId: actor.workspaceId, fileId, actorUserId: actor.userId });
}

export { basenameOf };

// ---------------------------------------------------------------------------
// Upload a .zip and unpack it here
// ---------------------------------------------------------------------------


export interface ExtractIntoReport {
  created: Array<{ path: string; fileId: string }>;
  /** Refused by the archive rules (names, symlinks, bomb limits …). */
  skippedByArchive: SkippedEntry[];
  /** Refused by the normal upload gate, the quota, or because the name is taken. */
  rejected: Array<{ path: string; reason: string }>;
}

/**
 * Unpack an uploaded zip into a folder. The archive is checked as a whole by the malware
 * scanner (refused on hosted without one), its entries by lib/drive/extract.ts, and every
 * file then goes through the same gate as any upload (sniff, quota, versions). An existing
 * file is never overwritten.
 */
export async function extractZipInto(actor: DriveActor, args: { dir: string; zip: Buffer }): Promise<ExtractIntoReport> {
  const dir = await requireDirWrite(actor, args.dir);
  await screenUserUpload(actor.workspaceId, actor.userId, "archive.zip", args.zip);
  let result;
  try {
    result = extractZip(args.zip);
  } catch (err) {
    throw new FsError("unsafe_content", err instanceof Error ? err.message : "That is not a zip archive.");
  }
  const report: ExtractIntoReport = { created: [], skippedByArchive: result.skipped, rejected: [] };
  for (const f of result.files) {
    const target = `${dir.path}/${f.path}`;
    try {
      const { file, created } = await writeFileAs(actor, { dir: dirnameOf(target), filename: basenameOf(target), bytes: f.bytes, overwrite: false });
      if (created) report.created.push({ path: file.logicalPath, fileId: file.id });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "could not be saved";
      report.rejected.push({ path: f.path, reason });
      if (err instanceof FsError && (err.code === "quota_exceeded" || err.code === "scanner_unavailable")) break;
    }
  }
  return report;
}
