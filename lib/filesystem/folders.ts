// ShapesOS — Phase 21B (WS=drive): folders (part of the workspace filesystem
// service; files stay in lib/filesystem/service.ts).
//
// A folder is a row (workspace_folders, FORCE RLS) so empty folders, folder
// ACLs, colours and tags work. Paths are the canonical stored paths of
// lib/filesystem/paths.ts. Every mutation here:
//   - runs in ONE transaction under the workspace structure lock
//     (lib/drive/quota-store.ts lockDriveTree) and writes its change-journal
//     events in that transaction (lib/drive/changes.ts);
//   - treats names case/NFC-insensitively (path_key), so two folders or files
//     whose names differ only by case can never sit in one folder;
//   - never hard-deletes: removing a folder is trashing it (one batch id tags
//     the folder, its subfolders and its files, so restoring the folder brings
//     back exactly what the trash took). Permanent removal needs the folder to
//     be in the trash first (purgeTrashedFolder), like files.
// Authorization (who may do this) lives one layer up in lib/drive/ops.ts; this
// layer enforces invariants only.

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { collisionKey, folderChain, normalizeFolderPath, normalizeLogicalPath, basenameOf, dirnameOf, type PathInfo } from "./paths";
import { FsError } from "./core";
import { recordChanges, type NewChange } from "@/lib/drive/changes";
import { chargeQuota, lockDriveTree } from "@/lib/drive/quota-store";
import { quotaScopesFor } from "@/lib/drive/quota";

type Tx = Prisma.TransactionClient;

export interface PublicFolder {
  id: string;
  workspaceId: string;
  path: string;
  name: string;
  ownerUserId: string | null;
  system: boolean;
  color: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
}

type FolderRow = {
  id: string;
  workspaceId: string;
  path: string;
  name: string;
  ownerUserId: string | null;
  system: boolean;
  color: string | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  trashedAt: Date | null;
};

export function toPublicFolder(f: FolderRow): PublicFolder {
  return {
    id: f.id,
    workspaceId: f.workspaceId,
    path: f.path,
    name: f.name,
    ownerUserId: f.ownerUserId,
    system: f.system,
    color: f.color,
    tags: f.tags,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
    trashedAt: f.trashedAt ? f.trashedAt.toISOString() : null,
  };
}

function ownerOf(path: string): string | null {
  const m = /^\/home\/([^/]+)/.exec(path);
  return m ? m[1]! : null;
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002";
}

function folderPathOrThrow(input: string): PathInfo {
  const c = normalizeFolderPath(input);
  if (!c.ok) throw new FsError("invalid_path", c.reason);
  return c;
}

/** The live folder at this path (case/NFC-insensitive), or null. */
export async function findLiveFolder(tx: Tx, workspaceId: string, path: string) {
  return tx.workspaceFolder.findFirst({ where: { workspaceId, pathKey: collisionKey(path), trashedAt: null } });
}

/**
 * Make sure every folder above (and including) `folderPath` exists, creating
 * the missing ones. Returns the leaf (null for a virtual top such as /shared)
 * and the folders it had to create. If a folder already exists under a
 * different spelling of the same name (case/NFC), THAT spelling wins, so the
 * caller must build file paths from `leaf.path`.
 */
export async function ensureFolderChain(
  tx: Tx,
  workspaceId: string,
  folderPath: string,
  createdBy: string,
): Promise<{ leaf: FolderRow | null; created: FolderRow[]; events: NewChange[] }> {
  const chain = folderChain(folderPath);
  let parent: FolderRow | null = null;
  const created: FolderRow[] = [];
  const events: NewChange[] = [];
  let canonicalPrefix = "";
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i]!;
    // Build this level's path from the canonical spelling of the level above.
    const name = basenameOf(step.path);
    const path: string = parent ? `${parent.path}/${name}` : canonicalPrefix ? `${canonicalPrefix}/${name}` : step.path;
    let row: FolderRow | null = await findLiveFolder(tx, workspaceId, path);
    if (!row) {
      row = await tx.workspaceFolder.create({
        data: {
          workspaceId,
          path,
          pathKey: collisionKey(path),
          name,
          parentId: parent?.id ?? null,
          ownerUserId: ownerOf(path),
          system: step.system,
          createdBy,
        },
      });
      created.push(row);
      events.push({ type: "create", entity: "folder", entityId: row.id, path: row.path, actorUserId: createdBy });
    }
    parent = row;
    canonicalPrefix = row.path;
  }
  return { leaf: parent, created, events };
}

/** Create a folder (and any missing parents). Conflict if that exact folder already exists. */
export async function createFolder(args: { workspaceId: string; path: string; createdBy: string }): Promise<PublicFolder> {
  const info = folderPathOrThrow(args.path);
  if (folderChain(info.path).length === 0) throw new FsError("invalid_path", "That is a top-level place, not a folder you can create.");
  try {
    return await withWorkspaceScope(args.workspaceId, async (tx) => {
      await lockDriveTree(tx, args.workspaceId);
      const existing = await findLiveFolder(tx, args.workspaceId, info.path);
      if (existing) throw new FsError("conflict", `A folder already exists at ${existing.path}.`);
      const clash = await tx.workspaceFile.findFirst({ where: { workspaceId: args.workspaceId, trashedAt: null, pathKey: collisionKey(info.path) }, select: { id: true } });
      if (clash) throw new FsError("conflict", "A file with that name already exists here.");
      const { leaf, events } = await ensureFolderChain(tx, args.workspaceId, info.path, args.createdBy);
      await recordChanges(tx, args.workspaceId, events);
      return toPublicFolder(leaf!);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new FsError("conflict", `A folder already exists at ${info.path}.`);
    throw err;
  }
}

export async function getFolder(workspaceId: string, folderId: string): Promise<PublicFolder | null> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const f = await tx.workspaceFolder.findFirst({ where: { id: folderId, workspaceId } });
    return f ? toPublicFolder(f) : null;
  });
}

export async function updateFolderMeta(args: { workspaceId: string; folderId: string; color?: string | null; tags?: string[]; actorUserId: string }): Promise<PublicFolder> {
  if (args.color != null && !/^[a-z][a-z-]{0,15}$/.test(args.color)) throw new FsError("invalid_path", "Pick one of the named folder colours.");
  const tags = args.tags?.map((t) => t.trim().normalize("NFC")).filter(Boolean);
  if (tags && (tags.length > 20 || tags.some((t) => t.length > 40))) throw new FsError("invalid_path", "Up to 20 tags of 40 characters.");
  return withWorkspaceScope(args.workspaceId, async (tx) => {
    await lockDriveTree(tx, args.workspaceId);
    const f = await tx.workspaceFolder.findFirst({ where: { id: args.folderId, workspaceId: args.workspaceId, trashedAt: null } });
    if (!f) throw new FsError("not_found", "Folder not found.");
    const updated = await tx.workspaceFolder.update({
      where: { id: f.id },
      data: { ...(args.color !== undefined ? { color: args.color } : {}), ...(tags ? { tags: Array.from(new Set(tags)) } : {}) },
    });
    await recordChanges(tx, args.workspaceId, [{ type: "update", entity: "folder", entityId: f.id, path: f.path, actorUserId: args.actorUserId }]);
    return toPublicFolder(updated);
  });
}

// ---------------------------------------------------------------------------
// Rename / move
// ---------------------------------------------------------------------------

const LEGACY_OTHER_ROOTS = new Set(["/skills", "/memory", "/artifacts"]);

/** Files in /skills, /memory and /artifacts belong to the app that manages them: they cannot leave their root. */
function assertMoveAllowed(from: PathInfo, to: PathInfo): void {
  const fromLegacy = LEGACY_OTHER_ROOTS.has(from.root);
  const toLegacy = LEGACY_OTHER_ROOTS.has(to.root);
  if ((fromLegacy || toLegacy) && from.root !== to.root) {
    throw new FsError("invalid_path", "Files in /skills, /memory and /artifacts are managed by ShapesOS and cannot be moved in or out of those folders.");
  }
  if (from.root === "/agents" && to.root !== "/agents") {
    // An agent's work product may be moved out by a person; allowed (the person decides).
  }
}

async function rewriteSubtree(
  tx: Tx,
  workspaceId: string,
  oldPrefix: string,
  newPrefix: string,
  newOwner: string | null,
): Promise<{ files: Array<{ id: string; from: string; to: string; version: number }>; folders: Array<{ id: string; from: string; to: string }>; bytes: number }> {
  const files = await tx.workspaceFile.findMany({
    where: { workspaceId, trashedAt: null, logicalPath: { startsWith: `${oldPrefix}/` } },
    select: { id: true, logicalPath: true, sizeBytes: true, version: true },
  });
  const folders = await tx.workspaceFolder.findMany({
    where: { workspaceId, trashedAt: null, path: { startsWith: `${oldPrefix}/` } },
    select: { id: true, path: true },
  });
  const fileMoves = files.map((f) => ({ id: f.id, from: f.logicalPath, to: newPrefix + f.logicalPath.slice(oldPrefix.length), version: f.version }));
  const folderMoves = folders.map((f) => ({ id: f.id, from: f.path, to: newPrefix + f.path.slice(oldPrefix.length) }));
  for (const m of [...fileMoves]) {
    const ok = normalizeLogicalPath(m.to);
    if (!ok.ok) throw new FsError("invalid_path", `Moving would make "${m.to.slice(0, 80)}…" invalid: ${ok.reason}`);
  }
  const BATCH = 2000;
  for (let i = 0; i < fileMoves.length; i += BATCH) {
    const b = fileMoves.slice(i, i + BATCH);
    await tx.$executeRaw`
      UPDATE "workspace_files" f SET "logical_path" = v.p, "path_key" = v.k, "owner_user_id" = ${newOwner}
      FROM unnest(${b.map((m) => m.id)}::text[], ${b.map((m) => m.to)}::text[], ${b.map((m) => collisionKey(m.to))}::text[]) AS v(id, p, k)
      WHERE f."id" = v.id AND f."workspace_id" = ${workspaceId}`;
  }
  for (let i = 0; i < folderMoves.length; i += BATCH) {
    const b = folderMoves.slice(i, i + BATCH);
    await tx.$executeRaw`
      UPDATE "workspace_folders" f SET "path" = v.p, "path_key" = v.k, "owner_user_id" = ${newOwner}, "updated_at" = now()
      FROM unnest(${b.map((m) => m.id)}::text[], ${b.map((m) => m.to)}::text[], ${b.map((m) => collisionKey(m.to))}::text[]) AS v(id, p, k)
      WHERE f."id" = v.id AND f."workspace_id" = ${workspaceId}`;
  }
  let bytes = 0;
  if (files.length) {
    bytes += files.reduce((n, f) => n + f.sizeBytes, 0);
    const v = await tx.workspaceFileVersion.aggregate({ where: { workspaceId, fileId: { in: files.map((f) => f.id) } }, _sum: { sizeBytes: true } });
    bytes += v._sum.sizeBytes ?? 0;
  }
  return { files: fileMoves, folders: folderMoves, bytes };
}

async function shiftScopes(tx: Tx, workspaceId: string, from: PathInfo, to: PathInfo, bytes: number): Promise<void> {
  const a = quotaScopesFor(from).map((s) => s.key).join("|");
  const b = quotaScopesFor(to).map((s) => s.key).join("|");
  if (a === b || bytes === 0) return;
  await chargeQuota(tx, workspaceId, quotaScopesFor(from), -bytes);
  await chargeQuota(tx, workspaceId, quotaScopesFor(to), bytes);
}

/** Move (or rename) a folder to `newPath`. The destination must not exist. */
export async function moveFolder(args: { workspaceId: string; folderId: string; newPath: string; actorUserId: string }): Promise<PublicFolder> {
  const dst = folderPathOrThrow(args.newPath);
  if (folderChain(dst.path).length === 0) throw new FsError("invalid_path", "That destination is not a folder.");
  try {
    return await withWorkspaceScope(
      args.workspaceId,
      async (tx) => {
        await lockDriveTree(tx, args.workspaceId);
        const f = await tx.workspaceFolder.findFirst({ where: { id: args.folderId, workspaceId: args.workspaceId, trashedAt: null } });
        if (!f) throw new FsError("not_found", "Folder not found.");
        if (f.system) throw new FsError("invalid_state", "System folders cannot be moved or renamed.");
        const src = folderPathOrThrow(f.path);
        if (collisionKey(dst.path) === collisionKey(f.path) && dst.path === f.path) return toPublicFolder(f);
        if (collisionKey(dst.path).startsWith(`${collisionKey(f.path)}/`)) throw new FsError("invalid_path", "A folder cannot be moved into itself.");
        assertMoveAllowed(src, dst);
        // Destination must be free (a case-only rename of itself is fine).
        const sameKey = collisionKey(dst.path) === f.pathKey;
        if (!sameKey) {
          const existing = await findLiveFolder(tx, args.workspaceId, dst.path);
          if (existing) throw new FsError("conflict", `A folder already exists at ${existing.path}.`);
          const fileClash = await tx.workspaceFile.findFirst({ where: { workspaceId: args.workspaceId, trashedAt: null, pathKey: collisionKey(dst.path) }, select: { id: true } });
          if (fileClash) throw new FsError("conflict", "A file with that name already exists there.");
        }
        // Make the destination's parents exist, then re-point.
        const parentPath = dirnameOf(dst.path);
        const parentChain = folderChain(parentPath).length ? await ensureFolderChain(tx, args.workspaceId, parentPath, args.actorUserId) : { leaf: null, events: [] as NewChange[] };
        const canonicalDst = parentChain.leaf ? `${parentChain.leaf.path}/${basenameOf(dst.path)}` : dst.path;
        const newOwner = ownerOf(canonicalDst);
        const moved = await rewriteSubtree(tx, args.workspaceId, f.path, canonicalDst, newOwner);
        const updated = await tx.workspaceFolder.update({
          where: { id: f.id },
          data: { path: canonicalDst, pathKey: collisionKey(canonicalDst), name: basenameOf(canonicalDst), parentId: parentChain.leaf?.id ?? null, ownerUserId: newOwner },
        });
        await shiftScopes(tx, args.workspaceId, src, dst, moved.bytes);
        const events: NewChange[] = [
          ...parentChain.events,
          { type: "move", entity: "folder", entityId: f.id, path: canonicalDst, prevPath: f.path, actorUserId: args.actorUserId },
          ...moved.folders.map((m): NewChange => ({ type: "move", entity: "folder", entityId: m.id, path: m.to, prevPath: m.from, actorUserId: args.actorUserId })),
          ...moved.files.map((m): NewChange => ({ type: "move", entity: "file", entityId: m.id, path: m.to, prevPath: m.from, version: m.version, actorUserId: args.actorUserId })),
        ];
        await recordChanges(tx, args.workspaceId, events);
        return toPublicFolder(updated);
      },
      { timeoutMs: 120_000 },
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new FsError("conflict", `Something already exists at ${dst.path}.`);
    throw err;
  }
}

export async function renameFolder(args: { workspaceId: string; folderId: string; name: string; actorUserId: string }): Promise<PublicFolder> {
  const f = await getFolder(args.workspaceId, args.folderId);
  if (!f || f.trashedAt) throw new FsError("not_found", "Folder not found.");
  return moveFolder({ workspaceId: args.workspaceId, folderId: args.folderId, newPath: `${dirnameOf(f.path)}/${args.name}`, actorUserId: args.actorUserId });
}

// ---------------------------------------------------------------------------
// Trash / restore / purge
// ---------------------------------------------------------------------------

/** Send a folder, its subfolders and its files to the trash (one batch). Reversible for 30 days. */
export async function trashFolder(args: { workspaceId: string; folderId: string; actorUserId: string }): Promise<{ folder: PublicFolder; files: number; folders: number; batch: string }> {
  return withWorkspaceScope(
    args.workspaceId,
    async (tx) => {
      await lockDriveTree(tx, args.workspaceId);
      const f = await tx.workspaceFolder.findFirst({ where: { id: args.folderId, workspaceId: args.workspaceId, trashedAt: null } });
      if (!f) throw new FsError("not_found", "Folder not found.");
      if (f.system) throw new FsError("invalid_state", "System folders cannot be removed.");
      const batch = randomUUID();
      const now = new Date();
      const files = await tx.workspaceFile.findMany({ where: { workspaceId: args.workspaceId, trashedAt: null, logicalPath: { startsWith: `${f.path}/` } }, select: { id: true, logicalPath: true, version: true } });
      const subs = await tx.workspaceFolder.findMany({ where: { workspaceId: args.workspaceId, trashedAt: null, path: { startsWith: `${f.path}/` } }, select: { id: true, path: true } });
      if (files.length) await tx.workspaceFile.updateMany({ where: { workspaceId: args.workspaceId, id: { in: files.map((x) => x.id) } }, data: { trashedAt: now, trashBatch: batch } });
      if (subs.length) await tx.workspaceFolder.updateMany({ where: { workspaceId: args.workspaceId, id: { in: subs.map((x) => x.id) } }, data: { trashedAt: now, trashBatch: batch } });
      const trashed = await tx.workspaceFolder.update({ where: { id: f.id }, data: { trashedAt: now, trashBatch: batch } });
      await recordChanges(tx, args.workspaceId, [
        { type: "trash", entity: "folder", entityId: f.id, path: f.path, actorUserId: args.actorUserId },
        ...subs.map((s): NewChange => ({ type: "trash", entity: "folder", entityId: s.id, path: s.path, actorUserId: args.actorUserId })),
        ...files.map((x): NewChange => ({ type: "trash", entity: "file", entityId: x.id, path: x.logicalPath, version: x.version, actorUserId: args.actorUserId })),
      ]);
      return { folder: toPublicFolder(trashed), files: files.length, folders: subs.length, batch };
    },
    { timeoutMs: 120_000 },
  );
}

/**
 * Bring a trashed folder back with everything its trash took. 409 when a live
 * folder or file now has its name (rename that one first).
 */
export async function restoreFolder(args: { workspaceId: string; folderId: string; actorUserId: string }): Promise<{ folder: PublicFolder; files: number; folders: number }> {
  try {
    return await withWorkspaceScope(
      args.workspaceId,
      async (tx) => {
        await lockDriveTree(tx, args.workspaceId);
        const f = await tx.workspaceFolder.findFirst({ where: { id: args.folderId, workspaceId: args.workspaceId, trashedAt: { not: null } } });
        if (!f) throw new FsError("not_found", "Folder not found in the trash.");
        const clash = await findLiveFolder(tx, args.workspaceId, f.path);
        if (clash) throw new FsError("conflict", `A folder already exists at ${clash.path}; rename or move it first.`);
        const fileClash = await tx.workspaceFile.findFirst({ where: { workspaceId: args.workspaceId, trashedAt: null, pathKey: f.pathKey }, select: { id: true } });
        if (fileClash) throw new FsError("conflict", "A file with that name now exists there; rename it first.");
        const parentPath = dirnameOf(f.path);
        const parent = folderChain(parentPath).length ? await ensureFolderChain(tx, args.workspaceId, parentPath, args.actorUserId) : { leaf: null, events: [] as NewChange[] };
        const batchWhere = f.trashBatch ? { trashBatch: f.trashBatch } : {};
        const files = f.trashBatch ? await tx.workspaceFile.findMany({ where: { workspaceId: args.workspaceId, trashedAt: { not: null }, ...batchWhere }, select: { id: true, logicalPath: true, version: true } }) : [];
        const subs = f.trashBatch ? await tx.workspaceFolder.findMany({ where: { workspaceId: args.workspaceId, trashedAt: { not: null }, ...batchWhere, id: { not: f.id } }, select: { id: true, path: true } }) : [];
        if (files.length) await tx.workspaceFile.updateMany({ where: { workspaceId: args.workspaceId, id: { in: files.map((x) => x.id) } }, data: { trashedAt: null, trashBatch: null } });
        if (subs.length) await tx.workspaceFolder.updateMany({ where: { workspaceId: args.workspaceId, id: { in: subs.map((x) => x.id) } }, data: { trashedAt: null, trashBatch: null } });
        const restored = await tx.workspaceFolder.update({ where: { id: f.id }, data: { trashedAt: null, trashBatch: null, parentId: parent.leaf?.id ?? null } });
        await recordChanges(tx, args.workspaceId, [
          ...parent.events,
          { type: "restore", entity: "folder", entityId: f.id, path: f.path, actorUserId: args.actorUserId },
          ...subs.map((s): NewChange => ({ type: "restore", entity: "folder", entityId: s.id, path: s.path, actorUserId: args.actorUserId })),
          ...files.map((x): NewChange => ({ type: "restore", entity: "file", entityId: x.id, path: x.logicalPath, version: x.version, actorUserId: args.actorUserId })),
        ]);
        return { folder: toPublicFolder(restored), files: files.length, folders: subs.length };
      },
      { timeoutMs: 120_000 },
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new FsError("conflict", "Something already exists at that path; rename it first.");
    throw err;
  }
}

/** The folder rows currently in the trash (top-level only: a trashed folder's subfolders ride with it). */
export async function listTrashedFolders(workspaceId: string): Promise<PublicFolder[]> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const rows = await tx.workspaceFolder.findMany({ where: { workspaceId, trashedAt: { not: null } }, orderBy: { trashedAt: "desc" }, take: 500 });
    const top = rows.filter((r) => !rows.some((o) => o.id !== r.id && o.trashBatch && o.trashBatch === r.trashBatch && r.path.startsWith(`${o.path}/`)));
    return top.map(toPublicFolder);
  });
}
