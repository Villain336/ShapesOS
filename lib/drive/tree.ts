// ShapesOS — Phase 21B (WS=drive): reading the tree — what the Files app and the
// providers list. Every function takes the ACTOR and shows only what they may
// see: files and folders in someone else's private home never appear (admins
// included); a person's own home, the shared area and the system folders do.
//
// Paths in and out of this module are DISPLAY paths (the four system folders
// live under /shared: /shared/files/x is stored as /files/x — paths.ts).

import { Prisma, type WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { NotFoundError } from "@/lib/api/errors";
import { displayPath, folderChain, normalizeFolderPath, FS_ROOTS, basenameOf, collisionKey, type PathInfo } from "../filesystem/paths";
import { FsError } from "../filesystem/core";
import { ensureFolderChain } from "../filesystem/folders";
import { recordChanges } from "./changes";
import { lockDriveTree } from "./quota-store";
import { fileCan, type FileRole } from "../files/acl";
import { driveRoleFor, type DriveActor } from "./access";

export type DriveSort = "name" | "kind" | "size" | "modified" | "created";

export interface DriveItem {
  kind: "file" | "folder";
  id: string;
  name: string;
  /** Display path (system folders under /shared). */
  path: string;
  mimeType: string | null;
  sizeBytes: number | null;
  version: number | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  ownerUserId: string | null;
  tags: string[];
  color: string | null;
  system: boolean;
  favorite: boolean;
  /** What the actor may do here, at the level of the folder they are looking in. */
  canEdit: boolean;
}

export interface FolderListing {
  /** Display path of the folder. */
  path: string;
  breadcrumbs: Array<{ name: string; path: string }>;
  items: DriveItem[];
  total: number;
  limit: number;
  offset: number;
  canEdit: boolean;
  /** The folder's own row (null for virtual tops like /shared). */
  folder: { id: string; color: string | null; tags: string[]; system: boolean } | null;
}

export function breadcrumbsOf(display: string): Array<{ name: string; path: string }> {
  const segs = display.split("/").filter(Boolean);
  return segs.map((s, i) => ({ name: s, path: `/${segs.slice(0, i + 1).join("/")}` }));
}

const LEGACY = FS_ROOTS as readonly string[];

function sortSql(sort: DriveSort, dir: "asc" | "desc", table: "files" | "folders"): Prisma.Sql {
  const d = dir === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  const name = table === "files" ? Prisma.sql`lower(filename)` : Prisma.sql`lower(name)`;
  switch (sort) {
    case "size":
      return table === "files" ? Prisma.sql`size_bytes ${d}, ${name} ASC` : Prisma.sql`${name} ASC`;
    case "modified":
      return table === "files" ? Prisma.sql`coalesce(updated_at, created_at) ${d}, ${name} ASC` : Prisma.sql`updated_at ${d}, ${name} ASC`;
    case "created":
      return Prisma.sql`created_at ${d}, ${name} ASC`;
    case "kind":
      return table === "files" ? Prisma.sql`mime_type ${d}, ${name} ASC` : Prisma.sql`${name} ASC`;
    default:
      return Prisma.sql`${name} ${d}`;
  }
}

function toNum(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

/** Make the four system folders (and nothing else) exist as rows. Idempotent. */
export async function ensureSystemFolders(workspaceId: string, userId: string): Promise<void> {
  const existing = await withWorkspaceScope(workspaceId, (tx) => tx.workspaceFolder.count({ where: { workspaceId, system: true, path: { in: [...LEGACY] }, trashedAt: null } }));
  if (existing === LEGACY.length) return;
  await withWorkspaceScope(workspaceId, async (tx) => {
    await lockDriveTree(tx, workspaceId);
    const events = [];
    for (const root of LEGACY) events.push(...(await ensureFolderChain(tx, workspaceId, root, userId)).events);
    await recordChanges(tx, workspaceId, events);
  });
}

/** Make a person's home container exist (/home/<id>). Idempotent. */
export async function ensureHome(workspaceId: string, userId: string): Promise<void> {
  const path = `/home/${userId}`;
  const found = await withWorkspaceScope(workspaceId, (tx) => tx.workspaceFolder.findFirst({ where: { workspaceId, pathKey: collisionKey(path), trashedAt: null }, select: { id: true } }));
  if (found) return;
  await withWorkspaceScope(workspaceId, async (tx) => {
    await lockDriveTree(tx, workspaceId);
    const { events } = await ensureFolderChain(tx, workspaceId, path, userId);
    await recordChanges(tx, workspaceId, events);
  });
}

async function favoritesOf(workspaceId: string, userId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await withWorkspaceScope(workspaceId, (tx) => tx.workspaceDriveFavorite.findMany({ where: { workspaceId, userId, entityId: { in: ids } }, select: { entityId: true } }));
  return new Set(rows.map((r) => r.entityId));
}

/** The folder a listing is about: its parsed path, the actor's role there, and its row. */
async function resolveFolder(actor: DriveActor, canonical: string) {
  const info = normalizeFolderPath(canonical);
  if (!info.ok) throw new FsError("invalid_path", info.reason);
  const virtual = folderChain(info.path).length === 0 || (info.path === "/shared");
  const row = virtual ? null : await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceFolder.findFirst({ where: { workspaceId: actor.workspaceId, pathKey: collisionKey(info.path), trashedAt: null } }));
  // A folder that was never created (and is not a virtual top) does not exist.
  if (!virtual && !row) throw new NotFoundError("Folder not found.");
  const role = await driveRoleFor(actor, { path: row?.path ?? info.path, ownerUserId: info.ownerUserId, createdBy: row?.createdBy ?? null });
  if (!role) throw new NotFoundError("Folder not found.");
  return { info, row, role };
}

export async function listChildren(args: {
  actor: DriveActor;
  /** Display or canonical path of the folder. */
  path: string;
  sort?: DriveSort;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}): Promise<FolderListing> {
  const { actor } = args;
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 500)), 2000);
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const sort = args.sort ?? "name";
  const dir = args.dir ?? "asc";
  const { info, row, role } = await resolveFolder(actor, args.path);
  const prefix = `${row?.path ?? info.path}/`;
  const ws = actor.workspaceId;
  const me = actor.userId;
  const isSharedTop = info.path === "/shared";
  // Inside a private home that was shared with this person (resolveFolder proved they may look), its items are theirs to see.
  const sharedHome = info.ownerUserId ?? me;

  // ---- folders first (Finder shows folders before files), then files ----
  const folders = await withWorkspaceScope(ws, (tx) =>
    tx.$queryRaw<Array<{ id: string; path: string; name: string; owner_user_id: string | null; system: boolean; color: string | null; tags: string[]; created_by: string; created_at: Date; updated_at: Date }>>(Prisma.sql`
      SELECT id, path, name, owner_user_id, system, color, tags, created_by, created_at, updated_at
        FROM workspace_folders
       WHERE workspace_id = ${ws} AND trashed_at IS NULL
         AND starts_with(path, ${prefix})
         AND position('/' in substr(path, ${prefix.length + 1}::int)) = 0
         AND (owner_user_id IS NULL OR owner_user_id = ${me} OR owner_user_id = ${sharedHome})
       ORDER BY ${sortSql(sort, dir, "folders")}`),
  );
  const items: DriveItem[] = [];
  const seenFolderPaths = new Set<string>();
  const canEditHere = fileCan(role, "edit");
  const folderItem = (f: (typeof folders)[number]): DriveItem => ({
    kind: "folder", id: f.id, name: f.name, path: displayPath(f.path), mimeType: null, sizeBytes: null, version: null,
    createdAt: f.created_at.toISOString(), updatedAt: f.updated_at.toISOString(), createdBy: f.created_by, ownerUserId: f.owner_user_id,
    tags: f.tags, color: f.color, system: f.system, favorite: false, canEdit: canEditHere && !f.system,
  });
  for (const f of folders) {
    if (isSharedTop && LEGACY.includes(f.path)) continue; // shown below under /shared
    seenFolderPaths.add(f.path);
    items.push(folderItem(f));
  }
  if (isSharedTop) {
    // The four system folders appear under /shared (stored at /skills … /files).
    const sys = await withWorkspaceScope(ws, (tx) => tx.workspaceFolder.findMany({ where: { workspaceId: ws, trashedAt: null, path: { in: [...LEGACY] } } }));
    for (const root of LEGACY) {
      const f = sys.find((x) => x.path === root);
      const created = new Date(0).toISOString();
      items.push(
        f
          ? { ...folderItem({ ...f, owner_user_id: f.ownerUserId, created_by: f.createdBy, created_at: f.createdAt, updated_at: f.updatedAt }), path: displayPath(f.path), name: f.name }
          : { kind: "folder", id: `virtual:${root}`, name: basenameOf(root), path: displayPath(root), mimeType: null, sizeBytes: null, version: null, createdAt: created, updatedAt: created, createdBy: null, ownerUserId: null, tags: [], color: null, system: true, favorite: false, canEdit: false },
      );
    }
    items.sort((a, b) => (a.kind === b.kind ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : 0));
  }
  const folderCount = items.length;

  const [{ n: fileTotal }] = await prisma.$queryRaw<Array<{ n: bigint | number }>>(Prisma.sql`
    SELECT count(*) AS n FROM workspace_files
     WHERE workspace_id = ${ws} AND trashed_at IS NULL
       AND starts_with(logical_path, ${prefix})
       AND position('/' in substr(logical_path, ${prefix.length + 1}::int)) = 0
       AND (owner_user_id IS NULL OR owner_user_id = ${me} OR owner_user_id = ${sharedHome})`);
  const fileRows = await prisma.$queryRaw<Array<{ id: string; logical_path: string; filename: string; mime_type: string; size_bytes: number; version: number; created_by: string; created_at: Date; updated_at: Date | null; owner_user_id: string | null; tags: string[] }>>(Prisma.sql`
    SELECT id, logical_path, filename, mime_type, size_bytes, version, created_by, created_at, updated_at, owner_user_id, tags
      FROM workspace_files
     WHERE workspace_id = ${ws} AND trashed_at IS NULL
       AND starts_with(logical_path, ${prefix})
       AND position('/' in substr(logical_path, ${prefix.length + 1}::int)) = 0
       AND (owner_user_id IS NULL OR owner_user_id = ${me} OR owner_user_id = ${sharedHome})
     ORDER BY ${sortSql(sort, dir, "files")}, id
     LIMIT ${limit} OFFSET ${Math.max(0, offset - folderCount)}`);
  const favs = await favoritesOf(ws, me, [...fileRows.map((f) => f.id), ...items.map((i) => i.id)]);
  for (const i of items) i.favorite = favs.has(i.id);
  const fileItems: DriveItem[] = fileRows.map((f) => ({
    kind: "file", id: f.id, name: f.filename, path: displayPath(f.logical_path), mimeType: f.mime_type, sizeBytes: toNum(f.size_bytes), version: f.version,
    createdAt: f.created_at.toISOString(), updatedAt: (f.updated_at ?? f.created_at).toISOString(), createdBy: f.created_by, ownerUserId: f.owner_user_id,
    tags: f.tags, color: null, system: false, favorite: favs.has(f.id), canEdit: canEditHere,
  }));
  const paged = offset < folderCount ? [...items.slice(offset), ...fileItems] : fileItems;
  return {
    path: displayPath(row?.path ?? info.path),
    breadcrumbs: breadcrumbsOf(displayPath(row?.path ?? info.path)),
    items: paged.slice(0, limit),
    total: folderCount + toNum(fileTotal),
    limit,
    offset,
    canEdit: canEditHere,
    folder: row ? { id: row.id, color: row.color, tags: row.tags, system: row.system } : null,
  };
}

export interface RootEntry {
  key: "home" | "shared" | "agents" | "apps" | "mounts" | "trash";
  name: string;
  path: string;
}

/** The tops of the tree this person sees. */
export async function listRoots(actor: DriveActor): Promise<RootEntry[]> {
  await Promise.all([ensureSystemFolders(actor.workspaceId, actor.userId), ensureHome(actor.workspaceId, actor.userId)]);
  const out: RootEntry[] = [
    { key: "home", name: "Home", path: `/home/${actor.userId}` },
    { key: "shared", name: "Shared", path: "/shared" },
  ];
  const has = async (prefix: string) =>
    (await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceFolder.count({ where: { workspaceId: actor.workspaceId, trashedAt: null, path: { startsWith: prefix } } }))) > 0;
  if (await has("/agents/")) out.push({ key: "agents", name: "Agents", path: "/agents" });
  if (await has("/apps/")) out.push({ key: "apps", name: "Apps", path: "/apps" });
  if (await has("/mounts/")) out.push({ key: "mounts", name: "Mounts", path: "/mounts" });
  out.push({ key: "trash", name: "Trash", path: "/trash" });
  return out;
}

export interface TrashItem {
  kind: "file" | "folder";
  id: string;
  name: string;
  path: string;
  sizeBytes: number | null;
  trashedAt: string;
}

/** What is in the trash that this person could see (their own home's and the workspace's). */
export async function listTrash(actor: DriveActor): Promise<TrashItem[]> {
  const ws = actor.workspaceId;
  const files = await prisma.workspaceFile.findMany({
    where: { workspaceId: ws, trashedAt: { not: null }, OR: [{ ownerUserId: null }, { ownerUserId: actor.userId }] },
    orderBy: { trashedAt: "desc" },
    take: 500,
  });
  // A file trashed with its folder rides with the folder (one restore).
  const folders = await withWorkspaceScope(ws, (tx) => tx.workspaceFolder.findMany({ where: { workspaceId: ws, trashedAt: { not: null }, OR: [{ ownerUserId: null }, { ownerUserId: actor.userId }] }, orderBy: { trashedAt: "desc" }, take: 500 }));
  const topFolders = folders.filter((r) => !folders.some((o) => o.id !== r.id && o.trashBatch && o.trashBatch === r.trashBatch && r.path.startsWith(`${o.path}/`)));
  const folderBatches = new Set(topFolders.map((f) => f.trashBatch).filter(Boolean));
  const loose = files.filter((f) => !f.trashBatch || !folderBatches.has(f.trashBatch));
  const out: TrashItem[] = [
    ...topFolders.map((f): TrashItem => ({ kind: "folder", id: f.id, name: f.name, path: displayPath(f.path), sizeBytes: null, trashedAt: f.trashedAt!.toISOString() })),
    ...loose.map((f): TrashItem => ({ kind: "file", id: f.id, name: f.filename, path: displayPath(f.logicalPath), sizeBytes: f.sizeBytes, trashedAt: f.trashedAt!.toISOString() })),
  ];
  return out.sort((a, b) => (a.trashedAt < b.trashedAt ? 1 : -1));
}

export interface SharedWithMeItem {
  kind: "file" | "folder";
  id: string;
  name: string;
  path: string;
  role: FileRole;
  sharedBy: string;
  sharedAt: string;
  inPrivateHome: boolean;
}

/** Everything someone explicitly shared with this person (by folder or by file). */
export async function sharedWithMe(actor: DriveActor): Promise<SharedWithMeItem[]> {
  const ws = actor.workspaceId;
  const out: SharedWithMeItem[] = [];
  await withWorkspaceScope(ws, async (tx) => {
    const fa = await tx.workspaceFolderAcl.findMany({ where: { workspaceId: ws, userId: actor.userId, grantedBy: { not: actor.userId } }, include: { folder: true } });
    for (const a of fa) {
      if (a.folder.trashedAt) continue;
      out.push({ kind: "folder", id: a.folder.id, name: a.folder.name, path: displayPath(a.folder.path), role: a.role as FileRole, sharedBy: a.grantedBy, sharedAt: a.updatedAt.toISOString(), inPrivateHome: !!a.folder.ownerUserId });
    }
    const fl = await tx.workspaceFileAcl.findMany({ where: { workspaceId: ws, userId: actor.userId, grantedBy: { not: actor.userId } }, include: { file: true } });
    for (const a of fl) {
      if (a.file.trashedAt) continue;
      out.push({ kind: "file", id: a.file.id, name: a.file.filename, path: displayPath(a.file.logicalPath), role: a.role as FileRole, sharedBy: a.grantedBy, sharedAt: a.updatedAt.toISOString(), inPrivateHome: !!a.file.ownerUserId });
    }
  });
  return out.sort((a, b) => (a.sharedAt < b.sharedAt ? 1 : -1));
}

/** Files this person touched most recently (from the change journal), live and visible only. */
export async function recents(actor: DriveActor, limit = 30): Promise<DriveItem[]> {
  const ws = actor.workspaceId;
  const rows = await withWorkspaceScope(ws, (tx) =>
    tx.$queryRaw<Array<{ entity_id: string; last: Date }>>(Prisma.sql`
      SELECT entity_id, max(created_at) AS last FROM workspace_drive_changes
       WHERE workspace_id = ${ws} AND actor_user_id = ${actor.userId} AND entity = 'file' AND type IN ('create', 'update', 'move', 'restore')
       GROUP BY entity_id ORDER BY max(created_at) DESC LIMIT ${limit * 3}`),
  );
  if (rows.length === 0) return [];
  const files = await prisma.workspaceFile.findMany({
    where: { workspaceId: ws, id: { in: rows.map((r) => r.entity_id) }, trashedAt: null, OR: [{ ownerUserId: null }, { ownerUserId: actor.userId }] },
  });
  const byId = new Map(files.map((f) => [f.id, f]));
  const favs = await favoritesOf(ws, actor.userId, files.map((f) => f.id));
  const out: DriveItem[] = [];
  for (const r of rows) {
    const f = byId.get(r.entity_id);
    if (!f) continue;
    out.push({ kind: "file", id: f.id, name: f.filename, path: displayPath(f.logicalPath), mimeType: f.mimeType, sizeBytes: f.sizeBytes, version: f.version, createdAt: f.createdAt.toISOString(), updatedAt: r.last.toISOString(), createdBy: f.createdBy, ownerUserId: f.ownerUserId, tags: f.tags, color: null, system: false, favorite: favs.has(f.id), canEdit: true });
    if (out.length >= limit) break;
  }
  return out;
}

export interface StorageUsage {
  workspace: { usedBytes: number; limitBytes: number };
  personal: { usedBytes: number; limitBytes: number | null };
  byArea: Array<{ area: string; bytes: number; files: number }>;
}

/** Storage used: the workspace total, this person's home, and where the bytes are. */
export async function storageUsage(actor: DriveActor): Promise<StorageUsage> {
  const ws = actor.workspaceId;
  const q = await prisma.workspaceQuota.findUnique({ where: { workspaceId: ws } });
  const mine = await withWorkspaceScope(ws, (tx) => tx.workspaceDriveQuota.findUnique({ where: { workspaceId_scope: { workspaceId: ws, scope: `user:${actor.userId}` } } }));
  const rows = await prisma.$queryRaw<Array<{ area: string; bytes: bigint | number | null; files: bigint | number }>>(Prisma.sql`
    SELECT CASE WHEN owner_user_id = ${actor.userId} THEN 'home'
                WHEN owner_user_id IS NOT NULL THEN 'other'
                WHEN logical_path LIKE '/apps/%' THEN 'apps'
                WHEN logical_path LIKE '/agents/%' THEN 'agents'
                ELSE 'shared' END AS area,
           sum(size_bytes) AS bytes, count(*) AS files
      FROM workspace_files WHERE workspace_id = ${ws} AND trashed_at IS NULL GROUP BY 1`);
  return {
    workspace: { usedBytes: Number(q?.usedBytes ?? BigInt(0)), limitBytes: Number(q?.limitBytes ?? BigInt(10 * 1024 * 1024 * 1024)) },
    personal: { usedBytes: Number(mine?.usedBytes ?? BigInt(0)), limitBytes: mine?.limitBytes == null ? null : Number(mine.limitBytes) },
    // Other people's private bytes are folded into the workspace total, never itemised.
    byArea: rows.filter((r) => r.area !== "other").map((r) => ({ area: r.area, bytes: toNum(r.bytes), files: toNum(r.files) })),
  };
}

export type { PathInfo, WorkspaceRole };
