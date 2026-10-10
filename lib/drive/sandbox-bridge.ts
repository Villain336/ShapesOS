// ShapesOS — Phase 21B (WS=drive): the bridge between Drive and a code sandbox.
//
//   mountFolder   copy a Drive folder INTO the sandbox, at <workdir>/workspace
//                 (the sandbox's `/workspace` when its workdir is /; the code
//                 tools only reach inside the workdir). A marker file records
//                 which folder it is and the content hashes it started from.
//   syncOut       copy what changed back OUT as Drive versions — on exit and on
//                 checkpoints for agent runs, or when a person asks:
//                   new files        created (an agent: only inside its grant)
//                   changed files    a person's sync writes a new VERSION; an
//                                    AGENT'S sync never overwrites — the new
//                                    content is staged under
//                                    /agents/<run>/proposed/… and listed, and a
//                                    person applies it (applyStaged), because
//                                    replacing an existing file always asks
//                   deleted in the sandbox  left alone in Drive (never deletes)
//                   symlinks, special files, bad names, over-large files  skipped, listed
//   applyStaged   the person's "apply this proposal": the staged bytes become a
//                 new version of the original file.
//   uploadToSandbox / downloadFromSandbox   the Terminal's upload/download bridge.
//
// Nothing is trusted from inside the sandbox: the marker only says which folder;
// for an agent that folder must be inside the run's grant at sync time, every
// destination is re-resolved by PATH (never a file id from the sandbox), and
// every write goes through the person's own rights, the upload gate and quotas.
//
// Tested against the fake sandbox engine; real container runs are UNVERIFIED-LIVE.

import { createHash } from "node:crypto";
import type { Sandbox } from "@/lib/sandbox/types";
import { resolveSandboxPath, shq } from "@/lib/sandbox/paths";
import { getStorageAdapter } from "../filesystem/storage";
import { DEFAULT_MAX_FILE_BYTES, FsError } from "../filesystem/core";
import { basenameOf, dirnameOf, normalizeFolderPath, normalizeLogicalPath } from "../filesystem/paths";
import { checkAgentFileOp, type AgentGrant } from "./grants";
import { driveRoleFor, type DriveActor } from "./access";
import { findLiveFileByPath, writeFileAs, trashItemAs } from "./ops";
import { fileCan } from "../files/acl";
import { requireFileAction } from "../files/access";
import { prisma } from "@/lib/prisma";

export const MOUNT_DIR = "workspace";
const MARKER = ".shapes-mount.json";
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_TOTAL = 50 * 1024 * 1024;

export interface Skipped {
  path: string;
  reason: string;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export function mountPathOf(sandbox: Sandbox): string {
  return `${sandbox.workdir.replace(/\/+$/, "")}/${MOUNT_DIR}`;
}

interface Marker {
  v: 1;
  folder: string;
  baseline: Record<string, { sha: string; size: number }>;
}

async function readMarker(sandbox: Sandbox): Promise<Marker | null> {
  try {
    const raw = JSON.parse((await sandbox.readFile(`${mountPathOf(sandbox)}/${MARKER}`)).toString("utf8")) as Marker;
    return raw && raw.v === 1 && typeof raw.folder === "string" && raw.baseline && typeof raw.baseline === "object" ? raw : null;
  } catch {
    return null;
  }
}

async function writeMarker(sandbox: Sandbox, m: Marker): Promise<void> {
  await sandbox.writeFile(`${mountPathOf(sandbox)}/${MARKER}`, JSON.stringify(m));
}

/** Regular files in a sandbox directory (symlinks and special files are listed apart). */
async function listRegular(sandbox: Sandbox, dir: string, max: number): Promise<{ files: Array<{ rel: string; size: number }>; others: string[] }> {
  const r = await sandbox.exec(`find ${shq(dir)} -mindepth 1 \\( -type f -printf 'f\\t%s\\t%P\\0' -o ! -type d -printf 'o\\t0\\t%P\\0' \\) 2>/dev/null | head -z -n ${max + 1000}`, { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 });
  const files: Array<{ rel: string; size: number }> = [];
  const others: string[] = [];
  for (const rec of r.stdout.split("\0")) {
    if (!rec) continue;
    const [kind, size, ...rest] = rec.split("\t");
    const rel = rest.join("\t");
    if (!rel || rel === MARKER) continue;
    if (kind === "f") files.push({ rel, size: Number(size) || 0 });
    else others.push(rel);
  }
  return { files, others };
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export interface MountResult {
  mountDir: string;
  folder: string;
  files: number;
  bytes: number;
  skipped: Skipped[];
}

export async function mountFolder(args: { sandbox: Sandbox; actor: DriveActor; folder: string; grant?: AgentGrant; maxFiles?: number; maxBytes?: number }): Promise<MountResult> {
  const info = normalizeFolderPath(args.folder);
  if (!info.ok) throw new FsError("invalid_path", info.reason);
  if (args.grant) {
    const v = checkAgentFileOp(args.grant, { kind: "read", path: info.path });
    if (!v.allowed) throw new FsError("forbidden", v.reason);
  }
  const role = await driveRoleFor(args.actor, { path: info.path, ownerUserId: info.ownerUserId, createdBy: null });
  if (!role) throw new FsError("not_found", "Folder not found.");
  const maxFiles = args.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = args.maxBytes ?? DEFAULT_MAX_TOTAL;
  const rows = await prisma.workspaceFile.findMany({
    where: { workspaceId: args.actor.workspaceId, trashedAt: null, logicalPath: { startsWith: `${info.path}/` }, OR: [{ ownerUserId: null }, { ownerUserId: args.actor.userId }] },
    orderBy: { logicalPath: "asc" },
    take: maxFiles + 1,
  });
  const dir = mountPathOf(args.sandbox);
  await args.sandbox.exec(["mkdir", "-p", dir], { timeoutMs: 15_000 });
  const adapter = getStorageAdapter();
  const baseline: Marker["baseline"] = {};
  const skipped: Skipped[] = [];
  let bytes = 0;
  let copied = 0;
  for (const row of rows) {
    const rel = row.logicalPath.slice(info.path.length + 1);
    if (copied >= maxFiles) {
      skipped.push({ path: rel, reason: `more than ${maxFiles} files; the rest were not copied` });
      break;
    }
    if (row.sizeBytes > DEFAULT_MAX_FILE_BYTES || bytes + row.sizeBytes > maxBytes) {
      skipped.push({ path: rel, reason: "too large to copy into the sandbox" });
      continue;
    }
    const data = await adapter.get(row.storageKey);
    if (!data) {
      skipped.push({ path: rel, reason: "its stored bytes could not be read" });
      continue;
    }
    const parent = dirnameOf(`/${rel}`);
    if (parent !== "/") await args.sandbox.exec(["mkdir", "-p", `${dir}${parent}`], { timeoutMs: 15_000 });
    await args.sandbox.writeFile(`${dir}/${rel}`, data);
    baseline[rel] = { sha: sha(data), size: data.length };
    bytes += data.length;
    copied++;
  }
  await writeMarker(args.sandbox, { v: 1, folder: info.path, baseline });
  return { mountDir: dir, folder: info.path, files: copied, bytes, skipped };
}

// ---------------------------------------------------------------------------
// Sync out
// ---------------------------------------------------------------------------

export interface SyncReport {
  folder: string | null;
  created: Array<{ path: string; fileId: string }>;
  updated: Array<{ path: string; fileId: string; version: number }>;
  /** Agent mode: changed files that were NOT written over; a person applies them. */
  staged: Array<{ path: string; stagedPath: string; stagedFileId: string }>;
  unchanged: number;
  removedInSandbox: string[];
  skipped: Skipped[];
  /** For "Undo this agent run". */
  touched: Array<{ kind: "drive_file"; id: string; op: "create" | "update"; before: Record<string, unknown> }>;
}

function emptyReport(folder: string | null): SyncReport {
  return { folder, created: [], updated: [], staged: [], unchanged: 0, removedInSandbox: [], skipped: [], touched: [] };
}

export function stagingPath(runId: string, folder: string, rel: string): string {
  return `/agents/${runId}/proposed/${encodeURIComponent(folder)}/${rel}`;
}

export async function syncOut(args: { sandbox: Sandbox; actor: DriveActor; mode: "agent" | "person"; grant?: AgentGrant; maxFiles?: number }): Promise<SyncReport> {
  const marker = await readMarker(args.sandbox);
  if (!marker) return { ...emptyReport(null), skipped: [{ path: MOUNT_DIR, reason: "no Drive folder is mounted in this sandbox" }] };
  const report = emptyReport(marker.folder);
  const folderInfo = normalizeFolderPath(marker.folder);
  if (!folderInfo.ok) return { ...report, skipped: [{ path: marker.folder, reason: folderInfo.reason }] };
  if (args.mode === "agent") {
    if (!args.grant) throw new FsError("forbidden", "An agent sync needs the run's grant.");
    const v = checkAgentFileOp(args.grant, { kind: "create", path: `${folderInfo.path}/x` });
    if (!v.allowed) return { ...report, skipped: [{ path: marker.folder, reason: "this folder is not inside what the run was given; nothing was synced" }] };
  }
  const dir = mountPathOf(args.sandbox);
  const maxFiles = args.maxFiles ?? DEFAULT_MAX_FILES;
  const { files, others } = await listRegular(args.sandbox, dir, maxFiles);
  for (const o of others) report.skipped.push({ path: o, reason: "symbolic links and special files are not synced" });
  const seen = new Set<string>();
  const adapter = getStorageAdapter();
  let handled = 0;
  for (const f of files) {
    seen.add(f.rel);
    if (handled >= maxFiles) {
      report.skipped.push({ path: f.rel, reason: `more than ${maxFiles} files; the rest were not synced` });
      continue;
    }
    handled++;
    if (f.size > DEFAULT_MAX_FILE_BYTES) {
      report.skipped.push({ path: f.rel, reason: "over the 25 MB single-file limit" });
      continue;
    }
    const dest = normalizeLogicalPath(`${folderInfo.path}/${f.rel}`);
    if (!dest.ok) {
      report.skipped.push({ path: f.rel, reason: dest.reason });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await args.sandbox.readFile(resolveSandboxPath(args.sandbox.workdir, `${dir}/${f.rel}`));
    } catch {
      report.skipped.push({ path: f.rel, reason: "could not be read" });
      continue;
    }
    const digest = sha(bytes);
    if (marker.baseline[f.rel]?.sha === digest) {
      report.unchanged++;
      continue;
    }
    const existing = await findLiveFileByPath(args.actor.workspaceId, dest.path);
    if (existing) {
      const current = await adapter.get(existing.storageKey);
      if (current && sha(current) === digest) {
        report.unchanged++;
        marker.baseline[f.rel] = { sha: digest, size: bytes.length };
        continue;
      }
    }
    try {
      if (args.mode === "agent") {
        const verdict = checkAgentFileOp(args.grant!, { kind: existing ? "overwrite" : "create", path: dest.path });
        if (!verdict.allowed) {
          report.skipped.push({ path: f.rel, reason: verdict.reason });
          continue;
        }
        if (existing) {
          // Replacing an existing file always asks: stage the new content for a person.
          const staged = stagingPath(args.grant!.runId, folderInfo.path, f.rel);
          const sp = normalizeLogicalPath(staged);
          if (!sp.ok) {
            report.skipped.push({ path: f.rel, reason: sp.reason });
            continue;
          }
          const { file } = await writeFileAs(args.actor, { dir: dirnameOf(sp.path), filename: basenameOf(sp.path), bytes, mimeType: existing.mimeType, overwrite: true });
          report.staged.push({ path: dest.path, stagedPath: file.logicalPath, stagedFileId: file.id });
          marker.baseline[f.rel] = { sha: digest, size: bytes.length };
          continue;
        }
      }
      const { file, created, version } = await writeFileAs(args.actor, { dir: dirnameOf(dest.path), filename: basenameOf(dest.path), bytes, overwrite: args.mode === "person" });
      marker.baseline[f.rel] = { sha: digest, size: bytes.length };
      if (created) {
        report.created.push({ path: file.logicalPath, fileId: file.id });
        report.touched.push({ kind: "drive_file", id: file.id, op: "create", before: { version: 1, path: file.logicalPath } });
      } else {
        report.updated.push({ path: file.logicalPath, fileId: file.id, version });
        report.touched.push({ kind: "drive_file", id: file.id, op: "update", before: { version: version - 1, path: file.logicalPath, writtenVersion: version } });
      }
    } catch (err) {
      report.skipped.push({ path: f.rel, reason: err instanceof Error ? err.message : "could not be saved" });
    }
  }
  for (const rel of Object.keys(marker.baseline)) if (!seen.has(rel)) report.removedInSandbox.push(rel);
  await writeMarker(args.sandbox, marker).catch(() => undefined);
  return report;
}

/** A person applies a staged proposal: the staged bytes become a new version of the original. */
export async function applyStaged(actor: DriveActor, stagedFileId: string): Promise<{ fileId: string; version: number; path: string }> {
  const staged = await prisma.workspaceFile.findFirst({ where: { id: stagedFileId, workspaceId: actor.workspaceId, trashedAt: null } });
  const m = staged && /^\/agents\/[^/]+\/proposed\/([^/]+)\/(.+)$/.exec(staged.logicalPath);
  if (!staged || !m) throw new FsError("not_found", "That is not a staged proposal.");
  await requireFileAction(actor, staged.id, "view");
  const folder = decodeURIComponent(m[1]!);
  const target = normalizeLogicalPath(`${folder}/${m[2]!}`);
  if (!target.ok) throw new FsError("invalid_path", target.reason);
  const existing = await findLiveFileByPath(actor.workspaceId, target.path);
  if (!existing) throw new FsError("not_found", "The original file is gone; nothing to replace.");
  await requireFileAction(actor, existing.id, "version");
  const bytes = await getStorageAdapter().get(staged.storageKey);
  if (!bytes) throw new FsError("not_found", "The staged content could not be read.");
  const { file, version } = await writeFileAs(actor, { dir: dirnameOf(existing.logicalPath), filename: existing.filename, bytes, mimeType: existing.mimeType, overwrite: true });
  await trashItemAs(actor, { kind: "file", id: staged.id }).catch(() => undefined);
  return { fileId: file.id, version, path: file.logicalPath };
}

// ---------------------------------------------------------------------------
// Terminal upload / download (a person's own action: their rights, no grant)
// ---------------------------------------------------------------------------

/** Copy one Drive file into the sandbox (default: its working directory). */
export async function uploadToSandbox(args: { sandbox: Sandbox; actor: DriveActor; drivePath: string; sandboxDir?: string }): Promise<{ sandboxPath: string; bytes: number }> {
  const p = normalizeLogicalPath(args.drivePath);
  if (!p.ok) throw new FsError("invalid_path", p.reason);
  const file = await findLiveFileByPath(args.actor.workspaceId, p.path);
  if (!file) throw new FsError("not_found", "File not found.");
  const role = await driveRoleFor(args.actor, { path: file.logicalPath, ownerUserId: file.ownerUserId, createdBy: file.createdBy, fileId: file.id });
  if (!role || !fileCan(role, "download")) throw new FsError("not_found", "File not found.");
  if (file.sizeBytes > DEFAULT_MAX_FILE_BYTES) throw new FsError("too_large", "Files over 25 MB can't be copied into the terminal.");
  const bytes = await getStorageAdapter().get(file.storageKey);
  if (!bytes) throw new FsError("not_found", "File not found.");
  const dest = resolveSandboxPath(args.sandbox.workdir, `${args.sandboxDir ?? "."}/${file.filename}`);
  await args.sandbox.exec(["mkdir", "-p", dirnameOf(dest)], { timeoutMs: 15_000 });
  await args.sandbox.writeFile(dest, bytes);
  return { sandboxPath: dest, bytes: bytes.length };
}

/** Save one sandbox file into a Drive folder as the person (new file, or a new version with overwrite). */
export async function downloadFromSandbox(args: { sandbox: Sandbox; actor: DriveActor; sandboxPath: string; driveDir: string; overwrite?: boolean }): Promise<{ fileId: string; path: string; version: number; created: boolean }> {
  const abs = resolveSandboxPath(args.sandbox.workdir, args.sandboxPath);
  const st = await args.sandbox.exec(`test -f ${shq(abs)} && test ! -L ${shq(abs)} && stat -c %s ${shq(abs)}`, { timeoutMs: 15_000 });
  if (st.exitCode !== 0) throw new FsError("not_found", "That is not a regular file in the terminal.");
  if (Number(st.stdout.trim()) > DEFAULT_MAX_FILE_BYTES) throw new FsError("too_large", "Files over 25 MB can't be saved from the terminal.");
  const bytes = await args.sandbox.readFile(abs);
  const { file, created, version } = await writeFileAs(args.actor, { dir: args.driveDir, filename: basenameOf(abs), bytes, overwrite: args.overwrite });
  return { fileId: file.id, path: file.logicalPath, version, created };
}


