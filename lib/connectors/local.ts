// Marketr — site working-copy file providers (milestone 7; deploy PR).
//
// The working copy is the editable copy of a site: for file-source sites it
// IS the site; for github/sftp sites sync pulls remote → here and deploy
// pushes here → remote. Two implementations of the same contract
// (WorkingCopyProvider), chosen by MARKETR_STORAGE (siteWorkingCopy()):
//
//   LocalDirProvider  — a directory on this server's disk (MARKETR_STORAGE=local:
//                       dev and the single-box self-host; byte-for-byte the
//                       pre-deploy behaviour).
//   BlobDirProvider   — the same tree in the shared blob store (namespace
//                       "sites", <siteId>/working/<path>) so every web replica
//                       and the worker see one working copy (MARKETR_STORAGE=s3).
//
// Paths are sanitized with the same sanitizePath() as every other provider,
// so ".." can never escape the root; the blob provider additionally encodes
// every path segment into the blob layer's strict charset.

import { promises as fs } from "fs";
import { dirname, join, resolve, sep } from "path";
import type { FileEntry, ReadResult, SiteFileProvider } from "@/lib/sitefiles/types";
import { joinPath, sanitizePath } from "@/lib/sitefiles/paths";
import {
  blobDelete,
  blobDeletePrefix,
  blobGet,
  blobHead,
  blobList,
  blobPut,
  decodeBlobSegment,
  encodeBlobSegment,
  storageMode,
} from "@/lib/filesystem/storage";

const MAX_READ_BYTES = 200 * 1024;

/** What the IDE, builder, fix agent and deploys use: a site's editable files. */
export interface WorkingCopyProvider extends SiteFileProvider {
  /** Make sure the working copy exists (a no-op for the blob store). */
  ensureRoot(): Promise<void>;
  /** Delete one file; a missing file is not an error. Never a directory. */
  removeFile(path: string): Promise<void>;
  /** Every non-dotfile path in the working copy ("/a/b.html"). */
  listAllFiles(): Promise<string[]>;
}

export class LocalDirProvider implements WorkingCopyProvider {
  readonly name = "local";
  readonly isLive = true;

  constructor(private root: string) {}

  /** Resolve a sanitized "/a/b" path to an absolute path inside the root. */
  private abs(sanitized: string): string {
    const rel = sanitized.replace(/^\//, "");
    const resolved = resolve(this.root, rel);
    const rootResolved = resolve(this.root) + sep;
    if (resolved !== resolve(this.root) && !resolved.startsWith(rootResolved)) {
      throw new Error("Path escapes the site root");
    }
    return resolved;
  }

  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  async listDir(path: string): Promise<FileEntry[]> {
    const dir = sanitizePath(path);
    const abs = this.abs(dir);
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      throw new Error(`Cannot list directory ${dir}`);
    }
    const entries: FileEntry[] = [];
    for (const d of dirents) {
      if (d.name.startsWith(".")) continue; // hide dotfiles
      const entryPath = joinPath(dir, d.name);
      let size: number | undefined;
      if (d.isFile()) {
        try {
          size = (await fs.stat(this.abs(entryPath))).size;
        } catch {
          size = undefined;
        }
      }
      entries.push({
        name: d.name,
        path: entryPath,
        type: d.isDirectory() ? "dir" : "file",
        size,
      });
    }
    entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
    return entries;
  }

  async readFile(path: string): Promise<ReadResult> {
    const p = sanitizePath(path);
    const abs = this.abs(p);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new Error(`File not found: ${p}`);
    }
    if (!stat.isFile()) throw new Error(`Not a file: ${p}`);
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`File too large to edit (${Math.round(stat.size / 1024)} KB)`);
    }
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) throw new Error(`Binary file, cannot edit as text: ${p}`);
    return { content: buf.toString("utf8"), truncated: false };
  }

  async writeFile(path: string, content: string): Promise<void> {
    const p = sanitizePath(path);
    const abs = this.abs(p);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  /**
   * Phase 9: delete one file (applying a site draft that dropped it).
   * Files only — never a directory; a missing file is not an error.
   */
  async removeFile(path: string): Promise<void> {
    const p = sanitizePath(path);
    if (p === "/") throw new Error("Cannot remove the site root");
    const abs = this.abs(p);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) throw new Error(`Not a file: ${p}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw err;
    }
    await fs.unlink(abs);
  }

  async stat(path: string): Promise<FileEntry> {
    const p = sanitizePath(path);
    const abs = this.abs(p);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      throw new Error(`Path not found: ${p}`);
    }
    return {
      name: p === "/" ? "/" : p.split("/").pop()!,
      path: p,
      type: st.isDirectory() ? "dir" : "file",
      size: st.isFile() ? st.size : undefined,
      modifiedAt: st.mtime.toISOString(),
    };
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.ensureRoot();
      await fs.access(this.root);
      return { ok: true, message: "Local working copy ready" };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Cannot access working copy",
      };
    }
  }

  /** Recursively list every file under the root (for sync/deploy). */
  async listAllFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await this.listDir(dir)) {
        if (e.type === "dir") await walk(e.path);
        else out.push(e.path);
      }
    };
    await this.ensureRoot();
    await walk("/");
    return out;
  }

  get rootPath(): string {
    return this.root;
  }
}

/** Storage root for all site working copies. Overridable via SITE_STORAGE_DIR. */
export function siteStorageRoot(): string {
  return process.env.SITE_STORAGE_DIR?.trim() || join(process.cwd(), ".data", "sites");
}

function assertSiteId(siteId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(siteId)) throw new Error("Invalid site id");
}

/** Working-copy directory for one site (local mode). */
export function siteWorkingDir(siteId: string): string {
  assertSiteId(siteId);
  return join(siteStorageRoot(), siteId, "working");
}

/**
 * The working copy of one site in the storage MARKETR_STORAGE selects: the
 * local directory (single box) or the shared blob store (several instances).
 */
export function siteWorkingCopy(siteId: string): WorkingCopyProvider {
  assertSiteId(siteId);
  return storageMode() === "s3" ? new BlobDirProvider(`${siteId}/working`) : new LocalDirProvider(siteWorkingDir(siteId));
}

/** Remove a site's whole working copy (site deletion). */
export async function deleteSiteWorkingCopy(siteId: string): Promise<void> {
  assertSiteId(siteId);
  if (storageMode() === "s3") {
    await blobDeletePrefix("sites", `${siteId}/working/`);
  } else {
    await fs.rm(siteWorkingDir(siteId), { recursive: true, force: true });
  }
}

const SITES = "sites" as const;

/**
 * A working copy in the shared blob store. Same contract and limits as
 * LocalDirProvider: dotfiles hidden from listings, text-only reads capped at
 * 200 KB, files only (directories are implied by their files).
 */
export class BlobDirProvider implements WorkingCopyProvider {
  readonly name = "local";
  readonly isLive = true;

  /** `prefix` is the working copy's key prefix inside "sites", e.g. "<siteId>/working". */
  constructor(private readonly prefix: string) {
    if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(prefix)) throw new Error("Invalid working copy prefix");
  }

  /** Blob key of a sanitized "/a/b" path (the root maps to the prefix itself). */
  private key(sanitized: string): string {
    const rel = sanitized.replace(/^\//, "");
    if (!rel) return this.prefix;
    return `${this.prefix}/${rel.split("/").map(encodeBlobSegment).join("/")}`;
  }

  /** Sanitized "/a/b" path of a key under the prefix. */
  private pathOf(key: string): string {
    const rel = key.slice(this.prefix.length + 1);
    return "/" + rel.split("/").map(decodeBlobSegment).join("/");
  }

  async ensureRoot(): Promise<void> {
    // Object stores have no directories; the first write creates the copy.
  }

  async listDir(path: string): Promise<FileEntry[]> {
    const dir = sanitizePath(path);
    const listing = await blobList(SITES, `${this.key(dir)}/`, { delimiter: "/" }).catch(() => {
      throw new Error(`Cannot list directory ${dir}`);
    });
    if (dir !== "/" && listing.objects.length === 0 && listing.prefixes.length === 0) {
      throw new Error(`Cannot list directory ${dir}`);
    }
    const entries: FileEntry[] = [];
    for (const p of listing.prefixes) {
      const entryPath = this.pathOf(p.slice(0, -1));
      const name = entryPath.split("/").pop()!;
      if (name.startsWith(".")) continue; // hide dotfiles
      entries.push({ name, path: entryPath, type: "dir" });
    }
    for (const o of listing.objects) {
      const entryPath = this.pathOf(o.path);
      const name = entryPath.split("/").pop()!;
      if (name.startsWith(".")) continue;
      entries.push({ name, path: entryPath, type: "file", size: o.size });
    }
    entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
    return entries;
  }

  async readFile(path: string): Promise<ReadResult> {
    const p = sanitizePath(path);
    if (p === "/") throw new Error(`Not a file: ${p}`);
    const head = await blobHead(SITES, this.key(p));
    if (!head) {
      if (await this.isDir(p)) throw new Error(`Not a file: ${p}`);
      throw new Error(`File not found: ${p}`);
    }
    if (head.size > MAX_READ_BYTES) {
      throw new Error(`File too large to edit (${Math.round(head.size / 1024)} KB)`);
    }
    const buf = await blobGet(SITES, this.key(p));
    if (!buf) throw new Error(`File not found: ${p}`);
    if (buf.includes(0)) throw new Error(`Binary file, cannot edit as text: ${p}`);
    return { content: buf.toString("utf8"), truncated: false };
  }

  async writeFile(path: string, content: string): Promise<void> {
    const p = sanitizePath(path);
    if (p === "/") throw new Error("Cannot write the site root");
    await blobPut(SITES, this.key(p), content);
  }

  async removeFile(path: string): Promise<void> {
    const p = sanitizePath(path);
    if (p === "/") throw new Error("Cannot remove the site root");
    const head = await blobHead(SITES, this.key(p));
    if (!head) {
      if (await this.isDir(p)) throw new Error(`Not a file: ${p}`);
      return;
    }
    await blobDelete(SITES, this.key(p));
  }

  private async isDir(p: string): Promise<boolean> {
    if (p === "/") return true;
    const l = await blobList(SITES, `${this.key(p)}/`, { delimiter: "/" });
    return l.objects.length > 0 || l.prefixes.length > 0;
  }

  async stat(path: string): Promise<FileEntry> {
    const p = sanitizePath(path);
    const name = p === "/" ? "/" : p.split("/").pop()!;
    if (p !== "/") {
      const head = await blobHead(SITES, this.key(p));
      if (head) {
        return {
          name,
          path: p,
          type: "file",
          size: head.size,
          ...(head.lastModified ? { modifiedAt: head.lastModified.toISOString() } : {}),
        };
      }
    }
    if (await this.isDir(p)) return { name, path: p, type: "dir" };
    throw new Error(`Path not found: ${p}`);
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await blobList(SITES, `${this.prefix}/`, { delimiter: "/" });
      return { ok: true, message: "Shared working copy ready" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Cannot access working copy" };
    }
  }

  async listAllFiles(): Promise<string[]> {
    const { objects } = await blobList(SITES, `${this.prefix}/`);
    return objects
      .map((o) => this.pathOf(o.path))
      .filter((p) => !p.split("/").some((seg) => seg.startsWith(".")))
      .sort();
  }
}
