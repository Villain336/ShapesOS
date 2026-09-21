// Marketr — local working-copy file provider (milestone 7).
//
// Serves a directory on the server's filesystem as a SiteFileProvider. Used
// for file-source sites (the directory IS the site) and as the editable
// working copy for github/sftp sites (sync pulls remote → here, deploy pushes
// here → remote). Paths are sanitized with the same sanitizePath() as every
// other provider, so ".." can never escape the root.

import { promises as fs } from "fs";
import { dirname, join, resolve, sep } from "path";
import type { FileEntry, ReadResult, SiteFileProvider } from "@/lib/sitefiles/types";
import { joinPath, sanitizePath } from "@/lib/sitefiles/paths";

const MAX_READ_BYTES = 200 * 1024;

export class LocalDirProvider implements SiteFileProvider {
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

/** Working-copy directory for one site. */
export function siteWorkingDir(siteId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(siteId)) throw new Error("Invalid site id");
  return join(siteStorageRoot(), siteId, "working");
}
