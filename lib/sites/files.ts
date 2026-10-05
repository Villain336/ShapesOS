// ShapesOS — Phase 9 (sites): a SiteBuilder site's files as one snapshot.
//
// The canonical store of a site's files is its LOCAL WORKING COPY
// (lib/connectors/local.ts siteWorkingDir — the builder, the IDE, the fix
// agent and every hosting deploy read and write it). This module reads it as
// a list of text files, fingerprints it (so an agent draft can tell whether
// the site moved on since it was checked out) and writes a snapshot back.
// Sites are text-only by construction (LocalDirProvider refuses binaries and
// files over 200 KB), and so are snapshots.

import { createHash } from "node:crypto";
import { LocalDirProvider, siteWorkingDir } from "@/lib/connectors/local";
import { sanitizePath } from "@/lib/sitefiles/paths";

export interface SiteFile {
  /** "/index.html" style, sanitized. */
  path: string;
  content: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

/** Same cap as the working copy's own reads (LocalDirProvider). */
export const SITE_FILE_MAX_BYTES = 200 * 1024;
export const SITE_SNAPSHOT_MAX_FILES = 2000;
export const SITE_SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024;

/** A snapshot path: sanitized, no dot-segments (dotfiles never belong to a site). */
export function snapshotPath(raw: string): string | null {
  let p: string;
  try {
    p = sanitizePath(raw.startsWith("/") ? raw : `/${raw}`);
  } catch {
    return null;
  }
  if (p === "/") return null;
  if (p.split("/").some((seg) => seg.startsWith("."))) return null;
  return p;
}

/** Order-independent fingerprint of a file set (sha256 of path + content hashes). */
export function siteFingerprint(files: readonly SiteFile[]): string {
  const lines = files
    .map((f) => `${f.path}\0${createHash("sha256").update(f.content, "utf8").digest("hex")}`)
    .sort();
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

export function snapshotBytes(files: readonly SiteFile[]): number {
  return files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
}

/** Throws when a snapshot is over the caps. */
export function assertSnapshotSize(files: readonly SiteFile[]): void {
  if (files.length > SITE_SNAPSHOT_MAX_FILES) {
    throw new Error(`Too many files (${files.length}; the most a site revision holds is ${SITE_SNAPSHOT_MAX_FILES}).`);
  }
  const bytes = snapshotBytes(files);
  if (bytes > SITE_SNAPSHOT_MAX_BYTES) {
    throw new Error(`The site is too large (${Math.round(bytes / 1024)} KB; the most a revision holds is ${SITE_SNAPSHOT_MAX_BYTES / 1024 / 1024} MB).`);
  }
}

export function workingCopy(siteId: string): LocalDirProvider {
  return new LocalDirProvider(siteWorkingDir(siteId));
}

/** Every text file of a site's working copy (unreadable ones are listed, not fatal). */
export async function readSiteWorkingCopy(
  siteId: string,
  provider: LocalDirProvider = workingCopy(siteId),
): Promise<{ files: SiteFile[]; skipped: SkippedFile[] }> {
  const files: SiteFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const raw of await provider.listAllFiles()) {
    const path = snapshotPath(raw);
    if (!path) continue;
    try {
      const { content } = await provider.readFile(path);
      files.push({ path, content });
    } catch (err) {
      skipped.push({ path, reason: err instanceof Error ? err.message : "unreadable" });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped };
}

/**
 * Make the working copy exactly `files`: write each one, remove files that
 * are not in it. Returns what changed.
 */
export async function writeSiteWorkingCopy(
  siteId: string,
  files: readonly SiteFile[],
  provider: LocalDirProvider = workingCopy(siteId),
): Promise<{ written: number; removed: string[] }> {
  await provider.ensureRoot();
  const keep = new Set<string>();
  let written = 0;
  for (const f of files) {
    const path = snapshotPath(f.path);
    if (!path) continue;
    keep.add(path);
    await provider.writeFile(path, f.content);
    written++;
  }
  const removed: string[] = [];
  for (const raw of await provider.listAllFiles()) {
    const path = snapshotPath(raw);
    if (path && !keep.has(path)) {
      await provider.removeFile(path);
      removed.push(path);
    }
  }
  return { written, removed };
}
