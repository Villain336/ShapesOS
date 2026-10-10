// ShapesOS — Phase 21B (WS=drive): per-app storage. Each app install gets
// /apps/<appId>/<install> as its OWN container with its own quota (default
// 1 GiB), and nothing else. Two seams, no app platform yet (21C fills them in):
//
//   appContainer(install)   a service limited to that subtree: every path an app
//                           gives is relative to its root, validated by the
//                           Drive path rules, and re-checked to be inside it.
//                           It cannot name another install, a person's home or
//                           the shared tree. Writes go through the normal gate
//                           (upload-safety, scanner, quota) and the change
//                           journal.
//   pickFileForApp / openHandle   the file-picker handle model: the person picks
//                           ONE file for ONE app install and the app gets an
//                           opaque handle (lib/drive/handles.ts) to that file —
//                           never the tree. Using it re-checks the person's
//                           current access.
//
// There is no human actor inside a container: its files are created by
// "app:<appId>/<install>" and are workspace-visible (an admin can see what an
// app stores) but apps reach them only through this API.

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { FsError, DEFAULT_MAX_FILE_BYTES } from "../filesystem/core";
import { collisionKey, normalizeFolderPath, normalizeLogicalPath } from "../filesystem/paths";
import { getStorageAdapter } from "../filesystem/storage";
import { deleteFile, trashFile, writeFile } from "../filesystem/service";
import { overwriteFile } from "../filesystem/versions";
import { ensureFolderChain } from "../filesystem/folders";
import { recordChanges } from "./changes";
import { lockDriveTree, getScopeUsage, setScopeLimit } from "./quota-store";
import { DEFAULT_APP_QUOTA_BYTES } from "./quota";
import { driveRoleFor, type DriveActor } from "./access";
import { fileCan } from "../files/acl";
import { HANDLE_DEFAULT_TTL_MS, handleSecret, signHandle, verifyHandle } from "./handles";
import { findLiveFileByPath } from "./ops";

export interface AppInstallRef {
  workspaceId: string;
  appId: string;
  install: string;
}

const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INSTALL_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function containerRoot(i: Pick<AppInstallRef, "appId" | "install">): string {
  return `/apps/${i.appId}/${i.install}`;
}

export interface AppEntry {
  path: string;
  kind: "file" | "folder";
  sizeBytes: number | null;
  version: number | null;
  updatedAt: string;
}

export interface AppContainer {
  readonly root: string;
  /** Create the container folder (idempotent) and its quota row. */
  ensure(): Promise<void>;
  write(relPath: string, bytes: Buffer, opts?: { mimeType?: string; overwrite?: boolean }): Promise<{ path: string; version: number; created: boolean }>;
  read(relPath: string): Promise<{ bytes: Buffer; mimeType: string; version: number } | null>;
  list(relDir?: string): Promise<AppEntry[]>;
  /** Move a file to the Trash (the container's own files only). */
  trash(relPath: string): Promise<void>;
  usage(): Promise<{ usedBytes: number; limitBytes: number }>;
  /** Admin-set limit for this install (bytes). */
  setLimit(limitBytes: number): Promise<void>;
}

/** The app-side relative path -> the absolute path, or throws if it would leave the container. */
export function resolveInContainer(i: Pick<AppInstallRef, "appId" | "install">, rel: string): string {
  if (typeof rel !== "string" || rel.includes("\0") || rel.includes("\\")) throw new FsError("invalid_path", "Invalid path.");
  const root = containerRoot(i);
  const joined = `${root}/${rel.replace(/^\/+/, "")}`.replace(/\/+$/, "");
  const parsed = normalizeLogicalPath(joined);
  const folder = parsed.ok ? parsed : normalizeFolderPath(joined);
  if (!folder.ok) throw new FsError("invalid_path", folder.reason);
  const key = collisionKey(folder.path);
  if (key !== collisionKey(root) && !key.startsWith(`${collisionKey(root)}/`)) throw new FsError("invalid_path", "That path is outside the app's own storage.");
  if (!folder.app || folder.app.appId !== i.appId || folder.app.install !== i.install) throw new FsError("invalid_path", "That path is outside the app's own storage.");
  return folder.path;
}

export function appContainer(install: AppInstallRef): AppContainer {
  if (!APP_ID_RE.test(install.appId) || !INSTALL_RE.test(install.install)) throw new FsError("invalid_path", "Invalid app install.");
  const root = containerRoot(install);
  const by = `app:${install.appId}/${install.install}`;
  const scope = `app:${install.appId}/${install.install}`;
  const ws = install.workspaceId;

  const self: AppContainer = {
    root,
    async ensure() {
      await withWorkspaceScope(ws, async (tx) => {
        await lockDriveTree(tx, ws);
        const { events } = await ensureFolderChain(tx, ws, root, by);
        await recordChanges(tx, ws, events);
        await tx.workspaceDriveQuota.upsert({ where: { workspaceId_scope: { workspaceId: ws, scope } }, create: { workspaceId: ws, scope, limitBytes: BigInt(DEFAULT_APP_QUOTA_BYTES), usedBytes: BigInt(0) }, update: {} });
      });
    },
    async write(relPath, bytes, opts = {}) {
      const abs = resolveInContainer(install, relPath);
      const info = normalizeLogicalPath(abs);
      if (!info.ok) throw new FsError("invalid_path", info.reason);
      const existing = await findLiveFileByPath(ws, info.path);
      if (existing) {
        if (!opts.overwrite) throw new FsError("conflict", "A file already exists at that path.");
        const res = await overwriteFile({ workspaceId: ws, fileId: existing.id, bytes, mimeType: opts.mimeType, userId: by, maxBytes: DEFAULT_MAX_FILE_BYTES });
        return { path: existing.logicalPath.slice(root.length), version: res.version, created: false };
      }
      const f = await writeFile({ workspaceId: ws, logicalPath: info.path, kind: info.kind, bytes, mimeType: opts.mimeType, createdBy: by, maxBytes: DEFAULT_MAX_FILE_BYTES });
      return { path: f.logicalPath.slice(root.length), version: 1, created: true };
    },
    async read(relPath) {
      const abs = resolveInContainer(install, relPath);
      const f = await findLiveFileByPath(ws, abs);
      if (!f) return null;
      const bytes = await getStorageAdapter().get(f.storageKey);
      return bytes ? { bytes, mimeType: f.mimeType, version: f.version } : null;
    },
    async list(relDir = "/") {
      const dir = resolveInContainer(install, relDir === "/" ? "" : relDir);
      const prefix = `${dir}/`;
      const [files, folders] = await Promise.all([
        prisma.workspaceFile.findMany({ where: { workspaceId: ws, trashedAt: null, logicalPath: { startsWith: prefix } }, orderBy: { logicalPath: "asc" }, take: 1000 }),
        withWorkspaceScope(ws, (tx) => tx.workspaceFolder.findMany({ where: { workspaceId: ws, trashedAt: null, path: { startsWith: prefix } }, orderBy: { path: "asc" }, take: 1000 })),
      ]);
      const direct = (p: string) => !p.slice(prefix.length).includes("/");
      return [
        ...folders.filter((f) => direct(f.path)).map((f): AppEntry => ({ path: f.path.slice(root.length), kind: "folder", sizeBytes: null, version: null, updatedAt: f.updatedAt.toISOString() })),
        ...files.filter((f) => direct(f.logicalPath)).map((f): AppEntry => ({ path: f.logicalPath.slice(root.length), kind: "file", sizeBytes: f.sizeBytes, version: f.version, updatedAt: (f.updatedAt ?? f.createdAt).toISOString() })),
      ];
    },
    async trash(relPath) {
      const abs = resolveInContainer(install, relPath);
      const f = await findLiveFileByPath(ws, abs);
      if (!f) throw new FsError("not_found", "File not found.");
      await trashFile({ workspaceId: ws, fileId: f.id, actorUserId: undefined });
    },
    async usage() {
      const u = await withWorkspaceScope(ws, (tx) => getScopeUsage(tx, ws, scope));
      return { usedBytes: u.usedBytes, limitBytes: u.limitBytes ?? DEFAULT_APP_QUOTA_BYTES };
    },
    async setLimit(limitBytes) {
      if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) throw new FsError("invalid_path", "Invalid limit.");
      await withWorkspaceScope(ws, (tx) => setScopeLimit(tx, ws, scope, limitBytes));
    },
  };
  return self;
}

/** Remove an uninstalled app's container for good: every file in it, and its quota row. */
export async function purgeAppContainer(install: AppInstallRef): Promise<{ files: number }> {
  const root = containerRoot(install);
  const rows = await prisma.workspaceFile.findMany({ where: { workspaceId: install.workspaceId, logicalPath: { startsWith: `${root}/` } }, select: { id: true, trashedAt: true } });
  for (const r of rows) {
    if (!r.trashedAt) await trashFile({ workspaceId: install.workspaceId, fileId: r.id });
    await deleteFile({ workspaceId: install.workspaceId, fileId: r.id });
  }
  return { files: rows.length };
}

// ---------------------------------------------------------------------------
// The picker handle model
// ---------------------------------------------------------------------------

export interface PickedFile {
  handle: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  mode: "read" | "readwrite";
  expiresAt: string;
}

/** A person picks ONE file for ONE app install. The app gets a handle, not a path. */
export async function pickFileForApp(args: { actor: DriveActor; app: Pick<AppInstallRef, "appId" | "install">; fileId: string; mode?: "read" | "readwrite"; ttlMs?: number }): Promise<PickedFile> {
  const secret = handleSecret();
  if (!secret) throw new FsError("invalid_state", "File handles are off: no signing secret is configured.");
  const mode = args.mode ?? "read";
  const file = await prisma.workspaceFile.findFirst({ where: { id: args.fileId, workspaceId: args.actor.workspaceId, trashedAt: null } });
  if (!file) throw new FsError("not_found", "File not found.");
  const role = await driveRoleFor(args.actor, { path: file.logicalPath, ownerUserId: file.ownerUserId, createdBy: file.createdBy, fileId: file.id });
  if (!role) throw new FsError("not_found", "File not found.");
  if (!fileCan(role, mode === "readwrite" ? "edit" : "view")) throw new FsError("forbidden", "Your access to this file doesn't allow that.");
  const ttl = args.ttlMs ?? HANDLE_DEFAULT_TTL_MS;
  const handle = signHandle({ ws: args.actor.workspaceId, app: `${args.app.appId}/${args.app.install}`, file: file.id, by: args.actor.userId, mode }, secret, { ttlMs: ttl });
  return { handle, name: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, mode, expiresAt: new Date(Date.now() + Math.min(ttl, 24 * 3600_000)).toISOString() };
}

export interface OpenedHandle {
  name: string;
  mimeType: string;
  version: number;
  read(): Promise<Buffer>;
  /** Only for a readwrite handle: a new version of exactly this file. */
  write(bytes: Buffer): Promise<{ version: number }>;
}

/** An app uses the handle it was given. Re-checks that the person who picked it still has the access. */
export async function openHandle(app: AppInstallRef, handle: string): Promise<OpenedHandle> {
  const secret = handleSecret();
  if (!secret) throw new FsError("invalid_state", "File handles are off: no signing secret is configured.");
  const v = verifyHandle(handle, secret, { app: `${app.appId}/${app.install}` });
  if (!v.ok || v.claims.ws !== app.workspaceId) throw new FsError("forbidden", "This file handle isn't valid for this app.");
  const c = v.claims;
  const file = await prisma.workspaceFile.findFirst({ where: { id: c.file, workspaceId: c.ws, trashedAt: null } });
  if (!file) throw new FsError("not_found", "The file is gone.");
  const member = await prisma.workspaceMember.findFirst({ where: { workspaceId: c.ws, userId: c.by }, select: { role: true } });
  if (!member) throw new FsError("forbidden", "The person who picked this file no longer has access.");
  const role = await driveRoleFor({ workspaceId: c.ws, userId: c.by, role: member.role }, { path: file.logicalPath, ownerUserId: file.ownerUserId, createdBy: file.createdBy, fileId: file.id });
  if (!role || !fileCan(role, c.mode === "readwrite" ? "edit" : "view")) throw new FsError("forbidden", "The person who picked this file no longer has access.");
  return {
    name: file.filename,
    mimeType: file.mimeType,
    version: file.version,
    async read() {
      const bytes = await getStorageAdapter().get(file.storageKey);
      if (!bytes) throw new FsError("not_found", "The file's bytes are gone.");
      return bytes;
    },
    async write(bytes) {
      if (c.mode !== "readwrite") throw new FsError("forbidden", "This handle is read-only.");
      const res = await overwriteFile({ workspaceId: c.ws, fileId: file.id, bytes, userId: `app:${app.appId}/${app.install}`, maxBytes: DEFAULT_MAX_FILE_BYTES });
      return { version: res.version };
    },
  };
}


