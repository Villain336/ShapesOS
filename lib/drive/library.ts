// ShapesOS — Phase 21B (WS=drive): the personal side of the Files app — favourites,
// tags and smart folders (saved Spotlight queries). Favourites and smart folders
// belong to ONE person (nobody else sees them); tags live on the item and need edit
// access. Everything is workspace-scoped and FORCE RLS.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { FsError } from "../filesystem/core";
import { requireFileAction } from "../files/access";
import { displayPath } from "../filesystem/paths";
import { driveRoleFor, type DriveActor } from "./access";
import { fileCan } from "../files/acl";
import { NotFoundError } from "@/lib/api/errors";
import { recordChanges } from "./changes";
import { lockDriveTree } from "./quota-store";
import type { DriveItem } from "./tree";

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

/** PURE: normalise a tag list (NFC, trimmed, de-duplicated, no commas/control characters). */
export function cleanTags(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") continue;
    const tag = t.normalize("NFC").replace(/[\u0000-\u001f\u007f,]/g, "").trim().replace(/\s+/g, " ");
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) throw new FsError("invalid_path", `A tag is at most ${MAX_TAG_LENGTH} characters.`);
    if (!out.some((o) => o.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  if (out.length > MAX_TAGS) throw new FsError("invalid_path", `At most ${MAX_TAGS} tags.`);
  return out;
}

export async function setFileTags(actor: DriveActor, fileId: string, tags: unknown): Promise<string[]> {
  const clean = cleanTags(tags);
  const { file } = await requireFileAction(actor, fileId, "edit");
  await withWorkspaceScope(actor.workspaceId, async (tx) => {
    await lockDriveTree(tx, actor.workspaceId);
    await tx.workspaceFile.update({ where: { id: fileId, workspaceId: actor.workspaceId }, data: { tags: clean } });
    await recordChanges(tx, actor.workspaceId, [{ type: "update", entity: "file", entityId: fileId, path: file.logicalPath, version: file.version, actorUserId: actor.userId }]);
  });
  return clean;
}

export async function listTags(actor: DriveActor): Promise<Array<{ tag: string; count: number }>> {
  const rows = await prisma.$queryRaw<Array<{ tag: string; n: bigint | number }>>(Prisma.sql`
    SELECT t AS tag, count(*) AS n FROM workspace_files, unnest(tags) AS t
     WHERE workspace_id = ${actor.workspaceId} AND trashed_at IS NULL AND (owner_user_id IS NULL OR owner_user_id = ${actor.userId})
     GROUP BY t ORDER BY count(*) DESC, t ASC LIMIT 200`);
  return rows.map((r) => ({ tag: r.tag, count: Number(r.n) }));
}

export async function filesWithTag(actor: DriveActor, tag: string, limit = 200): Promise<DriveItem[]> {
  const rows = await prisma.workspaceFile.findMany({
    where: { workspaceId: actor.workspaceId, trashedAt: null, tags: { has: tag }, OR: [{ ownerUserId: null }, { ownerUserId: actor.userId }] },
    orderBy: { logicalPath: "asc" },
    take: limit,
  });
  return rows.map((f) => ({ kind: "file", id: f.id, name: f.filename, path: displayPath(f.logicalPath), mimeType: f.mimeType, sizeBytes: f.sizeBytes, version: f.version, createdAt: f.createdAt.toISOString(), updatedAt: (f.updatedAt ?? f.createdAt).toISOString(), createdBy: f.createdBy, ownerUserId: f.ownerUserId, tags: f.tags, color: null, system: false, favorite: false, canEdit: true }));
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

export async function setFavorite(actor: DriveActor, kind: "file" | "folder", id: string, on: boolean): Promise<void> {
  // You can only favourite what you can see.
  if (kind === "file") await requireFileAction(actor, id, "view");
  else {
    const f = await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceFolder.findFirst({ where: { id, workspaceId: actor.workspaceId, trashedAt: null } }));
    if (!f) throw new NotFoundError("Folder not found.");
    if (!(await driveRoleFor(actor, { path: f.path, ownerUserId: f.ownerUserId, createdBy: f.createdBy }))) throw new NotFoundError("Folder not found.");
  }
  await withWorkspaceScope(actor.workspaceId, async (tx) => {
    if (on) {
      const n = await tx.workspaceDriveFavorite.count({ where: { workspaceId: actor.workspaceId, userId: actor.userId } });
      if (n >= 200) throw new FsError("invalid_state", "You can have up to 200 favourites.");
      await tx.workspaceDriveFavorite.upsert({ where: { userId_entity_entityId: { userId: actor.userId, entity: kind, entityId: id } }, create: { workspaceId: actor.workspaceId, userId: actor.userId, entity: kind, entityId: id }, update: {} });
    } else {
      await tx.workspaceDriveFavorite.deleteMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId, entity: kind, entityId: id } });
    }
  });
}

export async function listFavorites(actor: DriveActor): Promise<DriveItem[]> {
  const favs = await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceDriveFavorite.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId }, orderBy: { createdAt: "desc" } }));
  const out: DriveItem[] = [];
  const fileIds = favs.filter((f) => f.entity === "file").map((f) => f.entityId);
  const folderIds = favs.filter((f) => f.entity === "folder").map((f) => f.entityId);
  const files = fileIds.length ? await prisma.workspaceFile.findMany({ where: { workspaceId: actor.workspaceId, id: { in: fileIds }, trashedAt: null } }) : [];
  const folders = folderIds.length ? await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceFolder.findMany({ where: { workspaceId: actor.workspaceId, id: { in: folderIds }, trashedAt: null } })) : [];
  for (const fav of favs) {
    if (fav.entity === "file") {
      const f = files.find((x) => x.id === fav.entityId);
      if (!f) continue;
      const role = await driveRoleFor(actor, { path: f.logicalPath, ownerUserId: f.ownerUserId, createdBy: f.createdBy, fileId: f.id });
      if (!role) continue; // access was taken away: it quietly drops out
      out.push({ kind: "file", id: f.id, name: f.filename, path: displayPath(f.logicalPath), mimeType: f.mimeType, sizeBytes: f.sizeBytes, version: f.version, createdAt: f.createdAt.toISOString(), updatedAt: (f.updatedAt ?? f.createdAt).toISOString(), createdBy: f.createdBy, ownerUserId: f.ownerUserId, tags: f.tags, color: null, system: false, favorite: true, canEdit: fileCan(role, "edit") });
    } else {
      const f = folders.find((x) => x.id === fav.entityId);
      if (!f) continue;
      const role = await driveRoleFor(actor, { path: f.path, ownerUserId: f.ownerUserId, createdBy: f.createdBy });
      if (!role) continue;
      out.push({ kind: "folder", id: f.id, name: f.name, path: displayPath(f.path), mimeType: null, sizeBytes: null, version: null, createdAt: f.createdAt.toISOString(), updatedAt: f.updatedAt.toISOString(), createdBy: f.createdBy, ownerUserId: f.ownerUserId, tags: f.tags, color: f.color, system: f.system, favorite: true, canEdit: fileCan(role, "edit") && !f.system });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Smart folders: saved Spotlight queries
// ---------------------------------------------------------------------------

export interface SmartFolder {
  id: string;
  name: string;
  query: string;
  filters: Record<string, unknown>;
  createdAt: string;
}

export async function saveSmartFolder(actor: DriveActor, input: { name: string; query: string; filters?: Record<string, unknown> }): Promise<SmartFolder> {
  const name = input.name.normalize("NFC").trim();
  const query = input.query.normalize("NFC").trim();
  if (!name || name.length > 120) throw new FsError("invalid_path", "A smart folder needs a name of up to 120 characters.");
  if (!query || query.length > 500) throw new FsError("invalid_path", "A smart folder needs a search of up to 500 characters.");
  return withWorkspaceScope(actor.workspaceId, async (tx) => {
    const n = await tx.workspaceSmartFolder.count({ where: { workspaceId: actor.workspaceId, userId: actor.userId } });
    if (n >= 50) throw new FsError("invalid_state", "You can have up to 50 smart folders.");
    const r = await tx.workspaceSmartFolder.create({ data: { workspaceId: actor.workspaceId, userId: actor.userId, name, query, filters: (input.filters ?? {}) as never } });
    return { id: r.id, name: r.name, query: r.query, filters: r.filters as Record<string, unknown>, createdAt: r.createdAt.toISOString() };
  });
}

export async function listSmartFolders(actor: DriveActor): Promise<SmartFolder[]> {
  const rows = await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceSmartFolder.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId }, orderBy: { createdAt: "asc" } }));
  return rows.map((r) => ({ id: r.id, name: r.name, query: r.query, filters: r.filters as Record<string, unknown>, createdAt: r.createdAt.toISOString() }));
}

export async function deleteSmartFolder(actor: DriveActor, id: string): Promise<void> {
  const r = await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceSmartFolder.deleteMany({ where: { id, workspaceId: actor.workspaceId, userId: actor.userId } }));
  if (r.count === 0) throw new NotFoundError("Smart folder not found.");
}
