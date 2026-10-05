// ShapesOS — Phase 8: filesystem helpers built on a sandbox's own exec.
//
// Shared by every provider for the operations their APIs don't cover the
// same way: listing a directory (find), and checkpoints for the hosted
// providers (a tar of the workdir kept INSIDE the sandbox, so a checkpoint
// lives exactly as long as the sandbox — restore is only possible while it
// does). Docker uses its archive API for checkpoints instead (docker.ts).

import { randomBytes } from "node:crypto";
import type { SandboxExecOptions, SandboxExecResult, SandboxFileEntry } from "./types";
import { relativeToWorkdir, resolveSandboxPath, shq } from "./paths";

export type ExecFn = (cmd: string | string[], opts?: SandboxExecOptions) => Promise<SandboxExecResult>;

export const SNAPSHOT_ID_RE = /^snap-[a-z0-9]{6,40}$/;

export function newSnapshotId(): string {
  return `snap-${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
}

export class SandboxCommandError extends Error {
  constructor(
    message: string,
    readonly result?: SandboxExecResult,
  ) {
    super(message);
    this.name = "SandboxCommandError";
  }
}

function ensureOk(r: SandboxExecResult, what: string): SandboxExecResult {
  if (r.exitCode !== 0) {
    throw new SandboxCommandError(`${what} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`, r);
  }
  return r;
}

/** List a directory with find (type, size, path relative to `dir`). */
export async function listFilesViaExec(
  exec: ExecFn,
  workdir: string,
  dir: string,
  opts: { recursive?: boolean; maxEntries?: number } = {},
): Promise<SandboxFileEntry[]> {
  const abs = resolveSandboxPath(workdir, dir);
  const max = Math.min(Math.max(opts.maxEntries ?? 1000, 1), 20_000);
  // Recursive listings skip .git and node_modules (huge, never what the
  // agent is looking for); a one-level listing shows them.
  const scope = opts.recursive ? `\\( -name .git -o -name node_modules \\) -prune -o` : "-maxdepth 1";
  // %y type, %s size, %P path relative to the starting point. NUL-separated
  // records so file names with newlines can't forge entries.
  const cmd = `find ${shq(abs)} -mindepth 1 ${scope} -printf '%y\\t%s\\t%P\\0' 2>/dev/null | head -z -n ${max}`;
  const r = ensureOk(await exec(cmd, { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 }), "Listing files");
  const out: SandboxFileEntry[] = [];
  for (const rec of r.stdout.split("\0")) {
    if (!rec) continue;
    const [y, size, ...rest] = rec.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    out.push({ path, type: y === "d" ? "dir" : "file", size: y === "d" ? undefined : Number(size) || 0 });
  }
  return out;
}

const SNAP_DIR = "/tmp/.shapes-snapshots";

/** Checkpoint = a gzip'd tar of the workdir kept inside the sandbox. */
export async function snapshotViaExec(exec: ExecFn, workdir: string, label?: string) {
  const id = newSnapshotId();
  const cmd = `mkdir -p ${SNAP_DIR} && tar -czf ${SNAP_DIR}/${id}.tgz -C ${shq(workdir)} .`;
  ensureOk(await exec(cmd, { timeoutMs: 5 * 60_000 }), "Checkpoint");
  return { id, label, createdAt: new Date().toISOString() };
}

/** Put the workdir back exactly as the checkpoint saw it (extra files go). */
export async function restoreViaExec(exec: ExecFn, workdir: string, snapshotId: string): Promise<void> {
  if (!SNAPSHOT_ID_RE.test(snapshotId)) throw new SandboxCommandError("Unknown checkpoint.");
  const file = `${SNAP_DIR}/${snapshotId}.tgz`;
  const cmd =
    `test -f ${file} || { echo 'checkpoint not found' >&2; exit 3; }; ` +
    `find ${shq(workdir)} -mindepth 1 -delete && tar -xzf ${file} -C ${shq(workdir)}`;
  ensureOk(await exec(cmd, { timeoutMs: 5 * 60_000 }), "Restore");
}

export { relativeToWorkdir };
