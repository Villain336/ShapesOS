// ShapesOS — Phase 21B (WS=drive): the NATIVE FileProvider — the reference
// implementation. It is the workspace's own store (S3-compatible or local disk,
// Postgres registry) seen through one folder as its root, on behalf of ONE
// actor: every call goes through the actor-aware layer (lib/drive/ops.ts), so
// a provider can never see or touch more than that person can.
//
// Large streams are buffered up to the 25 MB single-write cap; bigger files go
// through the multipart path (lib/drive/uploads.ts), not through this interface.

import { prisma } from "@/lib/prisma";
import { NotFoundError, ForbiddenError, HttpError } from "@/lib/api/errors";
import { FsError, DEFAULT_MAX_FILE_BYTES } from "../../filesystem/core";
import { collisionKey, displayPath } from "../../filesystem/paths";
import { getStorageAdapter } from "../../filesystem/storage";
import { getQuota } from "../../filesystem/service";
import { listChanges } from "../changes";
import { driveRoleFor, type DriveActor } from "../access";
import { createFolderAs, findLiveFileByPath, findLiveFolderByPath, moveItemAs, trashItemAs, writeFileAs } from "../ops";
import { listChildren } from "../tree";
import { fileCan } from "../../files/acl";
import { type ChangesPage, type FileProvider, type ListPage, type ProviderEntry, type WriteOptions, ProviderError, toBuffer } from "./types";
import { joinPath, nameOf, parentOf, parseProviderPath } from "./path";

function mapError(err: unknown): never {
  if (err instanceof ProviderError) throw err;
  if (err instanceof FsError) {
    const code = err.code === "not_found" ? "not_found" : err.code === "conflict" || err.code === "invalid_state" ? "conflict" : err.code === "quota_exceeded" || err.code === "too_large" ? "quota_exceeded" : err.code === "unsafe_content" ? "unsupported" : err.code === "scanner_unavailable" ? "unavailable" : err.code === "forbidden" ? "forbidden" : "invalid_path";
    throw new ProviderError(code, err.message);
  }
  if (err instanceof NotFoundError) throw new ProviderError("not_found", err.message);
  if (err instanceof ForbiddenError) throw new ProviderError("forbidden", err.message);
  if (err instanceof HttpError) throw new ProviderError(err.status === 404 ? "not_found" : err.status === 403 ? "forbidden" : "invalid_path", err.message);
  throw err;
}

const CHUNK = 1024 * 1024;

export class NativeProvider implements FileProvider {
  readonly id = "native";
  /**
   * @param actor who this provider acts for
   * @param rootPath a canonical folder (e.g. /shared/Projects or /home/<me>/Docs); it must be
   *   outside the four system folders, which have their own spelling rules
   */
  constructor(
    private readonly actor: DriveActor,
    private readonly rootPath: string,
  ) {}

  private full(rel: string): string {
    return rel === "/" ? this.rootPath : `${this.rootPath}${rel}`;
  }
  private rel(canonical: string): string {
    return canonical.slice(this.rootPath.length) || "/";
  }
  private inRoot(path: string | null): boolean {
    return !!path && (collisionKey(path) === collisionKey(this.rootPath) || collisionKey(path).startsWith(`${collisionKey(this.rootPath)}/`));
  }

  private async entryFor(canonical: string): Promise<ProviderEntry | null> {
    const file = await findLiveFileByPath(this.actor.workspaceId, canonical);
    if (file) {
      const role = await driveRoleFor(this.actor, { path: file.logicalPath, ownerUserId: file.ownerUserId, createdBy: file.createdBy, fileId: file.id });
      if (!role) return null;
      return { id: file.id, path: this.rel(file.logicalPath), name: file.filename, kind: "file", sizeBytes: file.sizeBytes, mimeType: file.mimeType, modifiedAt: (file.updatedAt ?? file.createdAt).toISOString() };
    }
    const folder = await findLiveFolderByPath(this.actor.workspaceId, canonical);
    if (folder) {
      const role = await driveRoleFor(this.actor, { path: folder.path, ownerUserId: folder.ownerUserId, createdBy: folder.createdBy });
      if (!role) return null;
      return { id: folder.id, path: this.rel(folder.path), name: folder.name, kind: "folder", sizeBytes: null, mimeType: null, modifiedAt: folder.updatedAt.toISOString() };
    }
    return null;
  }

  private async requireFolder(rel: string): Promise<void> {
    if (rel === "/") return;
    const e = await this.entryFor(this.full(rel)).catch(mapError);
    if (!e || e.kind !== "folder") throw new ProviderError("not_found", `The folder ${rel} does not exist.`);
  }

  async list(path: string, opts?: { pageToken?: string | null; limit?: number }): Promise<ListPage> {
    const p = parseProviderPath(path).path;
    const limit = Math.min(opts?.limit ?? 100, 500);
    const offset = opts?.pageToken ? Number(opts.pageToken) || 0 : 0;
    try {
      const l = await listChildren({ actor: this.actor, path: this.full(p), limit, offset });
      const entries = l.items.map((i): ProviderEntry => ({
        id: i.id,
        path: this.rel(i.path),
        name: i.name,
        kind: i.kind,
        sizeBytes: i.sizeBytes,
        mimeType: i.mimeType,
        modifiedAt: i.updatedAt,
      }));
      return { entries, nextPageToken: offset + limit < l.total ? String(offset + limit) : null };
    } catch (e) {
      mapError(e);
    }
  }

  async stat(path: string): Promise<ProviderEntry | null> {
    const p = parseProviderPath(path).path;
    if (p === "/") return { id: "root", path: "/", name: "", kind: "folder", sizeBytes: null, mimeType: null, modifiedAt: null };
    try {
      return await this.entryFor(this.full(p));
    } catch (e) {
      mapError(e);
    }
  }

  async *read(path: string, range?: { start: number; end: number }): AsyncGenerator<Buffer> {
    const p = parseProviderPath(path).path;
    const file = await findLiveFileByPath(this.actor.workspaceId, this.full(p));
    if (!file) throw new ProviderError("not_found", "No such file.");
    const role = await driveRoleFor(this.actor, { path: file.logicalPath, ownerUserId: file.ownerUserId, createdBy: file.createdBy, fileId: file.id });
    if (!role || !fileCan(role, "view")) throw new ProviderError("not_found", "No such file.");
    const adapter = getStorageAdapter();
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? file.sizeBytes - 1, file.sizeBytes - 1);
    for (let at = start; at <= end; at += CHUNK) {
      const chunk = await adapter.getRange(file.storageKey, at, Math.min(at + CHUNK, end + 1) - 1);
      if (!chunk) throw new ProviderError("unavailable", "The stored bytes could not be read.");
      yield chunk;
    }
  }

  async write(path: string, data: Buffer | AsyncIterable<Buffer>, opts: WriteOptions = {}): Promise<ProviderEntry> {
    const p = parseProviderPath(path).path;
    if (p === "/") throw new ProviderError("invalid_path", "That is the root.");
    await this.requireFolder(parentOf(p));
    try {
      const bytes = await toBuffer(data);
      const { file } = await writeFileAs(this.actor, { dir: this.full(parentOf(p)), filename: nameOf(p), bytes, mimeType: opts.mimeType, overwrite: opts.overwrite, maxBytes: DEFAULT_MAX_FILE_BYTES });
      return { id: file.id, path: this.rel(file.logicalPath), name: file.filename, kind: "file", sizeBytes: file.sizeBytes, mimeType: file.mimeType, modifiedAt: new Date().toISOString() };
    } catch (e) {
      mapError(e);
    }
  }

  async mkdir(path: string): Promise<ProviderEntry> {
    const p = parseProviderPath(path).path;
    if (p === "/") throw new ProviderError("conflict", "The root exists.");
    await this.requireFolder(parentOf(p));
    try {
      const f = await createFolderAs(this.actor, this.full(p));
      return { id: f.id, path: this.rel(f.path), name: f.name, kind: "folder", sizeBytes: null, mimeType: null, modifiedAt: f.updatedAt };
    } catch (e) {
      mapError(e);
    }
  }

  async move(from: string, to: string): Promise<ProviderEntry> {
    const a = parseProviderPath(from).path;
    const b = parseProviderPath(to).path;
    const src = await this.entryFor(this.full(a)).catch(mapError);
    if (!src) throw new ProviderError("not_found", "No such file or folder.");
    await this.requireFolder(parentOf(b));
    try {
      await moveItemAs(this.actor, { kind: src.kind, id: src.id, to: this.full(b) });
    } catch (e) {
      mapError(e);
    }
    const moved = await this.entryFor(this.full(b)).catch(mapError);
    if (!moved) throw new ProviderError("unavailable", "The move did not take effect.");
    return moved;
  }

  async remove(path: string): Promise<void> {
    const p = parseProviderPath(path).path;
    const src = await this.entryFor(this.full(p)).catch(mapError);
    if (!src) throw new ProviderError("not_found", "No such file or folder.");
    try {
      await trashItemAs(this.actor, { kind: src.kind, id: src.id });
    } catch (e) {
      mapError(e);
    }
  }

  async changes(cursor: string | null, limit = 100): Promise<ChangesPage> {
    try {
      if (cursor === null) {
        const head = await listChanges({ workspaceId: this.actor.workspaceId, viewerUserId: this.actor.userId, cursor: null, limit: 1 });
        return { changes: [], cursor: head.head, hasMore: false };
      }
      const out: ChangesPage["changes"] = [];
      let cur = cursor;
      let more = true;
      // The journal is workspace-wide; keep reading until `limit` of OURS are found.
      while (out.length < limit && more) {
        const page = await listChanges({ workspaceId: this.actor.workspaceId, viewerUserId: this.actor.userId, cursor: cur, limit: 200 });
        for (const c of page.changes) {
          if (!this.inRoot(c.path) && !this.inRoot(c.prevPath)) {
            cur = c.cursor;
            continue;
          }
          if (out.length >= limit) {
            more = true;
            return { changes: out, cursor: cur, hasMore: true };
          }
          const rel = this.inRoot(c.path) ? this.rel(c.path) : "/";
          if (rel === "/") {
            cur = c.cursor;
            continue; // the root itself
          }
          out.push({
            type: c.type === "restore" ? "create" : c.type === "update" ? "update" : c.type,
            entry: { id: c.entityId, path: rel, name: nameOf(rel), kind: c.entity, sizeBytes: null, mimeType: null, modifiedAt: c.at },
            prevPath: c.prevPath && this.inRoot(c.prevPath) ? this.rel(c.prevPath) : null,
          });
          cur = c.cursor;
        }
        more = page.hasMore;
        if (!page.changes.length) cur = page.cursor;
        else if (!more) cur = page.cursor;
      }
      return { changes: out, cursor: cur, hasMore: more && out.length >= limit };
    } catch (e) {
      mapError(e);
    }
  }

  async quota() {
    const q = await getQuota({ workspaceId: this.actor.workspaceId });
    return { usedBytes: q.usedBytes, limitBytes: q.limitBytes };
  }
}

export { joinPath, prisma as _prismaForTests, displayPath };
