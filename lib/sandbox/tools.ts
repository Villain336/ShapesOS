// ShapesOS — Phase 8: code tools (tool group "code"), run in the agent run's
// sandbox — never on the host.
//
//   read_file   safe   line ranges, size cap, binary files refused
//   glob        safe   files matching a glob under the workdir
//   grep        safe   ripgrep when the image has it, else grep -rn
//   write_file  spend  edit_sandbox_files   (Tier 0: a per-agent auto rule applies)
//   edit_file   spend  edit_sandbox_files   exact string, must match once
//   bash        spend  run_sandbox_command  streamed, with a timeout
//   run_tests   spend  run_sandbox_command  the repo profile's test command;
//                      details.testsFailed=true on failure (the runtime
//                      counts fix cycles and escalates the model on it)
//   run_checks  spend  run_sandbox_command  Phase 9: lint, typecheck, test,
//                      build — the repo profile's commands, in that order;
//                      details.testsFailed=true when any fails
//
// Which commands: lib/sandbox/repo-profile.ts resolveRepoCommands — the
// checkout's .shapes/profile.json, then the saved repo profile of the
// repository the run cloned (git_clone stores it), then detection. Without a
// path both run in the cloned repository (the run's ship state).
//
// Every path resolves inside the sandbox workdir (traversal refused). The
// sandbox comes from sandboxForRun(ctx) and Stop from ctx.signal. Command
// output streams to the run timeline (appendAgentRunEvent). Edits are
// checkpointed in batches: a write marks the run dirty, and a checkpoint
// (snapshot + `sandbox.checkpoint` run event) is taken at most every
// CHECKPOINT_MIN_INTERVAL_MS from a write, and always before a command runs
// (flushCheckpoint) — so every command starts from a restorable point.

import { registerExtraTool, type ToolContext, type ToolDef, type ToolResult } from "@/lib/chat/tools";
import type { Sandbox } from "./types";
import { liveSandboxForRun, sandboxForRun, SandboxUnavailableError, sandboxAvailability } from "./index";
import { addExposedPort } from "./store";
import { resolveSandboxPath, relativeToWorkdir, SandboxPathError, shq } from "./paths";
import { applyExactEdit, globToRegExp, numberLines } from "./edit";
import {
  CHECK_ORDER,
  getRepoProfile,
  resolveRepoCommands,
  saveRepoProfile,
  type CheckName,
  type ResolvedRepoCommands,
  type ResolveRepoCommandsInput,
} from "./repo-profile";
import { SandboxCommandError } from "./exec-fs";
import { previewPath } from "./preview";

export const CODE_TOOL_NAMES = ["read_file", "write_file", "edit_file", "glob", "grep", "bash", "run_tests", "run_checks"] as const;
export type CodeToolName = (typeof CODE_TOOL_NAMES)[number];

/** Biggest file read_file / edit_file will load. */
export const READ_MAX_BYTES = 2 * 1024 * 1024;
/** Most characters of command output handed back to the model per stream. */
const MODEL_OUTPUT_CHARS = 30_000;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_BASH_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TEST_TIMEOUT_MS = 10 * 60_000;
export const CHECKPOINT_MIN_INTERVAL_MS = 15_000;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function int(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function bool(v: unknown): boolean {
  return v === true || v === "true";
}

function tail(s: string, n = MODEL_OUTPUT_CHARS): string {
  return s.length <= n ? s : `…[${s.length - n} earlier characters cut]\n${s.slice(-n)}`;
}

// ---------------------------------------------------------------------------
// Run timeline + checkpoints
// ---------------------------------------------------------------------------

let noteSink: ((summary: string, payload: Record<string, unknown>) => void) | null = null;

/** Tests: capture run-timeline notes instead of writing them (null restores). */
export function setCodeToolEventsForTests(fn: ((summary: string, payload: Record<string, unknown>) => void) | null): void {
  noteSink = fn;
}

async function runNote(ctx: ToolContext, summary: string, payload: Record<string, unknown>): Promise<void> {
  if (!ctx.runId) return;
  if (noteSink) return noteSink(summary, payload);
  try {
    const { appendAgentRunEvent } = await import("@/lib/agents/runs/service");
    await appendAgentRunEvent(ctx.workspaceId, ctx.runId, { type: "note", summary: summary.slice(0, 280), payload });
  } catch {
    // best effort
  }
}

/**
 * Streams command output to the run timeline in batches (every ~1 s or
 * 8 KB), capped per command so a chatty build can't flood the database.
 */
export class OutputStreamer {
  private buf: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  private sent = 0;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private capped = false;

  constructor(
    private readonly emit: (stream: "stdout" | "stderr", data: string) => Promise<void>,
    private readonly opts: { flushBytes?: number; flushMs?: number; maxBytes?: number } = {},
  ) {}

  push(chunk: { stream: "stdout" | "stderr"; data: string }): void {
    if (this.capped) return;
    this.buf[chunk.stream] += chunk.data;
    if (this.buf.stdout.length + this.buf.stderr.length >= (this.opts.flushBytes ?? 8192)) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.opts.flushMs ?? 1000);
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const s of ["stdout", "stderr"] as const) {
      let data = this.buf[s];
      this.buf[s] = "";
      if (!data) continue;
      const max = this.opts.maxBytes ?? 256 * 1024;
      if (this.sent + data.length > max) {
        data = `${data.slice(0, Math.max(0, max - this.sent))}\n…[more output not streamed]`;
        this.capped = true;
      }
      this.sent += data.length;
      this.chain = this.chain.then(() => this.emit(s, data)).catch(() => undefined);
      if (this.capped) break;
    }
    return this.chain;
  }
}

interface CheckpointState {
  dirty: boolean;
  lastAt: number;
  edits: string[];
}
const checkpoints = new Map<string, CheckpointState>();

function cpState(runId: string): CheckpointState {
  let s = checkpoints.get(runId);
  if (!s) {
    s = { dirty: false, lastAt: 0, edits: [] };
    checkpoints.set(runId, s);
  }
  return s;
}

/** Snapshot the workdir now and record it on the run timeline. */
export async function checkpoint(ctx: ToolContext, sandbox: Sandbox, label?: string): Promise<string | null> {
  if (!ctx.runId) return null;
  const st = cpState(ctx.runId);
  const files = [...new Set(st.edits)];
  try {
    const snap = await sandbox.snapshot(label);
    st.dirty = false;
    st.lastAt = Date.now();
    st.edits = [];
    await runNote(ctx, `Checkpoint: ${files.length ? files.slice(0, 5).join(", ") + (files.length > 5 ? ` +${files.length - 5} more` : "") : label ?? "workdir"}`, {
      kind: "sandbox.checkpoint",
      snapshotId: snap.id,
      label: label ?? null,
      files,
      sandboxId: sandbox.id,
      createdAt: snap.createdAt,
    });
    // Phase 21B (WS=drive): a mounted Drive folder is synced out at checkpoints (best effort, lazy).
    void import("@/lib/drive/sandbox-hooks").then((m) => m.syncRunMount(ctx.workspaceId, ctx.runId!, sandbox, "checkpoint")).catch(() => undefined);
    return snap.id;
  } catch (err) {
    await runNote(ctx, `Checkpoint failed: ${err instanceof Error ? err.message : "unknown error"}`, { kind: "sandbox.checkpoint_failed" });
    return null;
  }
}

/** After a write: mark the batch, checkpoint when the last one is old enough. */
async function afterEdit(ctx: ToolContext, sandbox: Sandbox, file: string): Promise<string | null> {
  if (!ctx.runId) return null;
  const st = cpState(ctx.runId);
  st.dirty = true;
  st.edits.push(file);
  if (Date.now() - st.lastAt < CHECKPOINT_MIN_INTERVAL_MS) return null;
  return checkpoint(ctx, sandbox, "edits");
}

/** Close the current batch of edits (before a command; the run loop may call it at a step end). */
export async function flushCheckpoint(ctx: ToolContext, sandbox?: Sandbox): Promise<string | null> {
  if (!ctx.runId) return null;
  const st = checkpoints.get(ctx.runId);
  if (!st?.dirty) return null;
  const sb = sandbox ?? (await sandboxFor(ctx));
  return checkpoint(ctx, sb, "edits");
}

/** Forget a finished run's batch state. */
export function forgetCheckpoints(runId: string): void {
  checkpoints.delete(runId);
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

let resolverOverride: ((ctx: ToolContext) => Promise<Sandbox>) | null = null;

/** Tests: hand the tools a sandbox without the database (null restores). */
export function setCodeToolSandboxForTests(fn: ((ctx: ToolContext) => Promise<Sandbox>) | null): void {
  resolverOverride = fn;
}

async function sandboxFor(ctx: ToolContext): Promise<Sandbox> {
  if (resolverOverride) return resolverOverride(ctx);
  if (!ctx.runId) throw new SandboxUnavailableError("code tools only run inside an agent run.");
  return sandboxForRun(ctx);
}

/** Turn the expected failures into a plain result the model can act on. */
async function guarded(name: CodeToolName, ctx: ToolContext, fn: (sb: Sandbox) => Promise<ToolResult>): Promise<ToolResult> {
  let sb: Sandbox;
  try {
    sb = await sandboxFor(ctx);
  } catch (err) {
    if (err instanceof SandboxUnavailableError) return { summary: err.message, details: { unavailable: true, reason: err.reason } };
    throw err;
  }
  try {
    return await fn(sb);
  } catch (err) {
    if (err instanceof SandboxPathError || err instanceof SandboxCommandError) {
      return { summary: `${name}: ${err.message}`, details: { error: err.message } };
    }
    throw err;
  }
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

async function runStreamed(
  ctx: ToolContext,
  sb: Sandbox,
  tool: CodeToolName,
  command: string,
  opts: { cwd?: string; timeoutMs: number },
) {
  const streamer = new OutputStreamer((stream, data) =>
    runNote(ctx, `${tool} ${stream}`, { kind: "sandbox.output", tool, stream, data }),
  );
  try {
    return await sb.exec(command, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      signal: ctx.signal,
      onOutput: (c) => streamer.push(c),
      maxOutputBytes: 2 * 1024 * 1024,
    });
  } finally {
    await streamer.flush();
  }
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const read_file: ToolDef = {
  name: "read_file",
  description:
    "Read a text file from the code sandbox (paths are relative to the sandbox workdir). Returns numbered lines; use offset/limit for long files.",
  kind: "safe",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workdir." },
      offset: { type: "number", description: "First line to show (1-based, default 1)." },
      limit: { type: "number", description: "How many lines (default 2000)." },
    },
    required: ["path"],
  },
  execute: (ctx, args) =>
    guarded("read_file", ctx, async (sb) => {
      const path = resolveSandboxPath(sb.workdir, str(args.path));
      const buf = await sb.readFile(path);
      const rel = relativeToWorkdir(sb.workdir, path);
      if (buf.length > READ_MAX_BYTES) return { summary: `${rel} is ${buf.length} bytes — over the ${READ_MAX_BYTES / 1024 / 1024} MB read limit. Use grep or bash (head/sed) to look at part of it.`, details: { error: "too_large", bytes: buf.length } };
      if (looksBinary(buf)) return { summary: `${rel} is a binary file (${buf.length} bytes).`, details: { binary: true, bytes: buf.length } };
      const { view, totalLines, shown } = numberLines(buf.toString("utf8"), int(args.offset) ?? 1, Math.min(int(args.limit) ?? 2000, 5000));
      return {
        summary: `${rel} (lines ${shown[0]}–${shown[1]} of ${totalLines})\n${tail(view, 100_000)}`,
        details: { path: rel, totalLines, shown },
      };
    }),
};

const write_file: ToolDef = {
  name: "write_file",
  description:
    "Create a file in the code sandbox, or overwrite it with the full new content. For a change to part of an existing file use edit_file.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workdir." },
      content: { type: "string", description: "The complete file content." },
    },
    required: ["path", "content"],
  },
  execute: (ctx, args) =>
    guarded("write_file", ctx, async (sb) => {
      const path = resolveSandboxPath(sb.workdir, str(args.path));
      const content = str(args.content);
      if (content === undefined) return { summary: "write_file needs content (a string).", details: { error: "content" } };
      if (Buffer.byteLength(content) > 8 * 1024 * 1024) return { summary: "That file is over 8 MB — write it in a command instead.", details: { error: "too_large" } };
      await sb.writeFile(path, content);
      const rel = relativeToWorkdir(sb.workdir, path);
      const snapshotId = await afterEdit(ctx, sb, rel);
      return { summary: `Wrote ${rel} (${Buffer.byteLength(content)} bytes).`, details: { path: rel, bytes: Buffer.byteLength(content), snapshotId } };
    }),
};

const edit_file: ToolDef = {
  name: "edit_file",
  description:
    "Replace exact text in a sandbox file. old_string must match exactly once (whitespace included) unless replace_all is true; read the file first.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workdir." },
      old_string: { type: "string", description: "The exact text to replace." },
      new_string: { type: "string", description: "The text to put in its place." },
      replace_all: { type: "boolean", description: "Change every match instead of exactly one (default false)." },
    },
    required: ["path", "old_string", "new_string"],
  },
  execute: (ctx, args) =>
    guarded("edit_file", ctx, async (sb) => {
      const path = resolveSandboxPath(sb.workdir, str(args.path));
      const rel = relativeToWorkdir(sb.workdir, path);
      const oldS = str(args.old_string);
      const newS = str(args.new_string);
      if (oldS === undefined || newS === undefined) return { summary: "edit_file needs old_string and new_string.", details: { error: "args" } };
      const buf = await sb.readFile(path);
      if (buf.length > READ_MAX_BYTES) return { summary: `${rel} is too large to edit here; use bash.`, details: { error: "too_large" } };
      if (looksBinary(buf)) return { summary: `${rel} is a binary file.`, details: { error: "binary" } };
      const out = applyExactEdit(buf.toString("utf8"), oldS, newS, bool(args.replace_all));
      if (!out.ok) return { summary: `edit_file ${rel}: ${out.error}`, details: { error: out.error } };
      await sb.writeFile(path, out.content);
      const snapshotId = await afterEdit(ctx, sb, rel);
      return {
        summary: `Edited ${rel} (${out.replacements} replacement${out.replacements === 1 ? "" : "s"}).`,
        details: { path: rel, replacements: out.replacements, snapshotId },
      };
    }),
};

const glob: ToolDef = {
  name: "glob",
  description: "Find files in the code sandbox by glob pattern (e.g. **/*.ts, src/**/*.test.js). Skips .git and node_modules.",
  kind: "safe",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, relative to path." },
      path: { type: "string", description: "Directory to search (default: the workdir)." },
    },
    required: ["pattern"],
  },
  execute: (ctx, args) =>
    guarded("glob", ctx, async (sb) => {
      const dir = resolveSandboxPath(sb.workdir, str(args.path) ?? ".");
      const pattern = str(args.pattern)?.trim() || "**";
      const re = globToRegExp(pattern);
      const entries = await sb.listFiles(dir, { recursive: true, maxEntries: 20_000 });
      const hits = entries.filter((e) => e.type === "file" && re.test(e.path)).map((e) => e.path).sort();
      const shown = hits.slice(0, 500);
      return {
        summary: hits.length
          ? `${hits.length} file${hits.length === 1 ? "" : "s"} match ${pattern}${hits.length > shown.length ? ` (first ${shown.length})` : ""}:\n${shown.join("\n")}`
          : `No files match ${pattern}.`,
        details: { pattern, count: hits.length, files: shown },
      };
    }),
};

const grep: ToolDef = {
  name: "grep",
  description:
    "Search file contents in the code sandbox with a regular expression (ripgrep when available, else grep). Returns file:line:text matches.",
  kind: "safe",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to look for." },
      path: { type: "string", description: "File or directory to search (default: the workdir)." },
      glob: { type: "string", description: "Only files matching this glob (e.g. *.ts)." },
      ignore_case: { type: "boolean", description: "Case-insensitive (default false)." },
      max_results: { type: "number", description: "Most matching lines to return (default 200)." },
    },
    required: ["pattern"],
  },
  execute: (ctx, args) =>
    guarded("grep", ctx, async (sb) => {
      const pattern = str(args.pattern);
      if (!pattern) return { summary: "grep needs a pattern.", details: { error: "pattern" } };
      const target = resolveSandboxPath(sb.workdir, str(args.path) ?? ".");
      const max = Math.min(Math.max(int(args.max_results) ?? 200, 1), 2000);
      const g = str(args.glob)?.trim();
      const i = bool(args.ignore_case);
      const rg = `rg -n --no-heading --color never ${i ? "-i " : ""}${g ? `-g ${shq(g)} ` : ""}-g '!node_modules' -g '!.git' -e ${shq(pattern)} -- ${shq(target)}`;
      const gr = `grep -rnE ${i ? "-i " : ""}${g ? `--include=${shq(g)} ` : ""}--exclude-dir=.git --exclude-dir=node_modules -e ${shq(pattern)} -- ${shq(target)}`;
      const cmd = `if command -v rg >/dev/null 2>&1; then ${rg}; else ${gr}; fi | head -n ${max}`;
      const r = await sb.exec(cmd, { timeoutMs: 60_000, signal: ctx.signal, maxOutputBytes: 1024 * 1024 });
      const root = sb.workdir.endsWith("/") ? sb.workdir : `${sb.workdir}/`;
      const lines = r.stdout.split("\n").filter(Boolean).map((l) => (l.startsWith(root) ? l.slice(root.length) : l));
      if (!lines.length) {
        const err = r.stderr.trim();
        return { summary: err && r.exitCode > 1 ? `grep failed: ${err.slice(0, 300)}` : `No matches for ${pattern}.`, details: { count: 0 } };
      }
      return {
        summary: `${lines.length}${lines.length >= max ? "+" : ""} match${lines.length === 1 ? "" : "es"} for ${pattern}:\n${tail(lines.join("\n"))}`,
        details: { count: lines.length, truncated: lines.length >= max },
      };
    }),
};

const bash: ToolDef = {
  name: "bash",
  description:
    "Run a shell command in the code sandbox (an isolated container; only package registries and GitHub are reachable). Output streams to the run timeline. Start dev servers with the base path the preview link gives.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command (runs with sh -lc in the workdir)." },
      cwd: { type: "string", description: "Directory to run in, relative to the workdir." },
      timeout_ms: { type: "number", description: "Time limit in ms (default 120000, max 600000)." },
      preview_port: { type: "number", description: "Also expose this port (a dev server) and return its preview link." },
    },
    required: ["command"],
  },
  execute: (ctx, args) =>
    guarded("bash", ctx, async (sb) => {
      const command = str(args.command)?.trim();
      if (!command) return { summary: "bash needs a command.", details: { error: "command" } };
      const cwd = resolveSandboxPath(sb.workdir, str(args.cwd) ?? ".");
      await flushCheckpoint(ctx, sb);
      const timeoutMs = Math.min(Math.max(int(args.timeout_ms) ?? DEFAULT_BASH_TIMEOUT_MS, 1000), MAX_BASH_TIMEOUT_MS);
      const r = await runStreamed(ctx, sb, "bash", command, { cwd, timeoutMs });
      let preview: string | null = null;
      const port = int(args.preview_port);
      if (port !== undefined) preview = (await exposeForRun(ctx, sb, port)).url;
      const status = r.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `exit ${r.exitCode}`;
      const parts = [`$ ${command.slice(0, 200)} → ${status} (${Math.round(r.durationMs / 100) / 10} s)`];
      if (r.stdout) parts.push(`stdout:\n${tail(r.stdout)}`);
      if (r.stderr) parts.push(`stderr:\n${tail(r.stderr)}`);
      if (r.truncated) parts.push("(output was cut at the capture limit)");
      if (preview) parts.push(`Preview: ${preview}`);
      return {
        summary: parts.join("\n"),
        details: { exitCode: r.exitCode, timedOut: r.timedOut, truncated: r.truncated, durationMs: r.durationMs, preview },
      };
    }),
};

// ---------------------------------------------------------------------------
// Repo commands (Phase 9: the saved repo profile drives run_tests / run_checks)
// ---------------------------------------------------------------------------

export interface RepoCommandDeps {
  /** The repository this run cloned (its ship state), if any. */
  shipRepo: (ctx: ToolContext) => Promise<{ repo: string; dir: string } | null>;
  getProfile: ResolveRepoCommandsInput["getProfile"];
  saveProfile: ResolveRepoCommandsInput["saveProfile"];
}

const defaultRepoCommandDeps: RepoCommandDeps = {
  shipRepo: async (ctx) => {
    if (!ctx.runId) return null;
    const { loadShipState } = await import("@/lib/ship/state");
    const threadId = (ctx as ToolContext & { threadId?: string }).threadId;
    const st = await loadShipState({ workspaceId: ctx.workspaceId, runId: ctx.runId, threadId }).catch(() => null);
    return st ? { repo: st.repo, dir: st.dir } : null;
  },
  getProfile: getRepoProfile,
  saveProfile: saveRepoProfile,
};
let repoCommandDeps: RepoCommandDeps = defaultRepoCommandDeps;

/** Tests: replace how the tools find the cloned repo / its profile (null restores). */
export function setRepoCommandDepsForTests(deps: Partial<RepoCommandDeps> | null): void {
  repoCommandDeps = deps ? { ...defaultRepoCommandDeps, ...deps } : defaultRepoCommandDeps;
}

/** The project directory and its commands (default: the cloned repository). */
async function commandsFor(ctx: ToolContext, sb: Sandbox, rawPath: string | undefined): Promise<{ dir: string; resolved: ResolvedRepoCommands }> {
  const ship = await repoCommandDeps.shipRepo(ctx).catch(() => null);
  let shipDir: string | null = null;
  try {
    shipDir = ship ? resolveSandboxPath(sb.workdir, ship.dir) : null;
  } catch {
    shipDir = null; // cloned into another sandbox's workdir: not this checkout
  }
  const dir = rawPath !== undefined ? resolveSandboxPath(sb.workdir, rawPath) : (shipDir ?? resolveSandboxPath(sb.workdir, "."));
  const resolved = await resolveRepoCommands(sb, dir, {
    workspaceId: ctx.workspaceId,
    ship: ship && shipDir ? { repo: ship.repo, dir: shipDir } : null,
    getProfile: repoCommandDeps.getProfile,
    saveProfile: repoCommandDeps.saveProfile,
  });
  return { dir, resolved };
}

function secs(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

const run_tests: ToolDef = {
  name: "run_tests",
  description:
    "Run the project's tests in the code sandbox: the repo profile's test command (.shapes/profile.json, else the profile saved when the repository was cloned, else detected from package.json / pytest / go / cargo / make), or the command given. Runs in the cloned repository unless a path is given.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project directory, relative to the workdir (default: the cloned repository, else the workdir)." },
      command: { type: "string", description: "Override the detected test command." },
      timeout_ms: { type: "number", description: "Time limit in ms (default 600000)." },
    },
  },
  execute: (ctx, args) =>
    guarded("run_tests", ctx, async (sb) => {
      const { dir, resolved } = await commandsFor(ctx, sb, str(args.path));
      let command = str(args.command)?.trim() || null;
      let source = "as given";
      if (!command) {
        command = resolved.commands.test ?? null;
        source = resolved.sourceOf.test ?? "nothing recognised";
      }
      if (!command) {
        return {
          summary: "No test command found (no .shapes/profile.json, saved repo profile, test script, pytest, go, cargo or make test). Pass one in `command`.",
          details: { error: "no_test_command" },
        };
      }
      await flushCheckpoint(ctx, sb);
      const timeoutMs = Math.min(Math.max(int(args.timeout_ms) ?? DEFAULT_TEST_TIMEOUT_MS, 1000), MAX_BASH_TIMEOUT_MS);
      const r = await runStreamed(ctx, sb, "run_tests", command, { cwd: dir, timeoutMs });
      const failed = r.exitCode !== 0 || r.timedOut;
      const verdict = r.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : failed ? `FAILED (exit ${r.exitCode})` : "passed";
      return {
        summary: `Tests ${verdict}: ${command} (${source})\n${tail(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`)}`,
        details: { testsFailed: failed, exitCode: r.exitCode, timedOut: r.timedOut, command, source, durationMs: r.durationMs },
      };
    }),
};

export interface CheckResult {
  check: CheckName | "install";
  command: string;
  source: string;
  passed: boolean;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

function parseChecks(v: unknown): CheckName[] | null {
  const raw = typeof v === "string" ? v.split(",") : Array.isArray(v) ? v.map(String) : null;
  if (!raw) return null;
  const want = new Set(raw.map((x) => x.trim().toLowerCase()).filter(Boolean));
  const picked = CHECK_ORDER.filter((c) => want.has(c));
  return picked.length ? picked : null;
}

const run_checks: ToolDef = {
  name: "run_checks",
  description:
    "Run the project's checks in the code sandbox, in order: lint, typecheck, test, build — the commands from the repo profile (.shapes/profile.json, else the profile saved when the repository was cloned, else detected). Every check runs; the result says which failed with their output. Use it after each batch of edits; fix and run it again until everything passes.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project directory, relative to the workdir (default: the cloned repository, else the workdir)." },
      checks: { type: "string", description: "Comma-separated subset of lint,typecheck,test,build (default: all the profile has)." },
      install: { type: "boolean", description: "Install dependencies first with the profile's install command (default false; do it once per sandbox)." },
      timeout_ms: { type: "number", description: "Time limit per check in ms (default 600000)." },
    },
  },
  execute: (ctx, args) =>
    guarded("run_checks", ctx, async (sb) => {
      const { dir, resolved } = await commandsFor(ctx, sb, str(args.path));
      const wanted = parseChecks(args.checks) ?? [...CHECK_ORDER];
      const plan = wanted.filter((c) => !!resolved.commands[c]);
      if (plan.length === 0) {
        return {
          summary: `No ${wanted.join(" / ")} command found for ${relativeToWorkdir(sb.workdir, dir) || "the workdir"} (no .shapes/profile.json, saved repo profile, or recognised scripts). Use run_tests with a command, or bash.`,
          details: { error: "no_checks", checks: [] },
        };
      }
      await flushCheckpoint(ctx, sb);
      const timeoutMs = Math.min(Math.max(int(args.timeout_ms) ?? DEFAULT_TEST_TIMEOUT_MS, 1000), MAX_BASH_TIMEOUT_MS);
      const results: CheckResult[] = [];
      const outputs = new Map<string, string>();
      const steps: Array<CheckName | "install"> = bool(args.install) && resolved.commands.install ? ["install", ...plan] : plan;
      for (const check of steps) {
        const command = resolved.commands[check]!;
        const r = await runStreamed(ctx, sb, "run_checks", command, { cwd: dir, timeoutMs });
        const passed = r.exitCode === 0 && !r.timedOut;
        results.push({ check, command, source: resolved.sourceOf[check] ?? "from the repo profile", passed, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs });
        if (!passed) outputs.set(check, `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`);
        // Nothing else can run without the dependencies.
        if (check === "install" && !passed) break;
      }
      const ran = results.filter((r) => r.check !== "install");
      const failed = results.filter((r) => !r.passed);
      const line = (r: CheckResult) =>
        `${r.check} ${r.passed ? "passed" : r.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `FAILED (exit ${r.exitCode})`} in ${secs(r.durationMs)}: ${r.command}`;
      const headline = failed.length
        ? `Checks FAILED: ${failed.map((r) => r.check).join(", ")} (${ran.length - failed.filter((r) => r.check !== "install").length} of ${plan.length} passed)`
        : `All ${plan.length} checks passed`;
      const perFailure = Math.floor(MODEL_OUTPUT_CHARS / Math.max(1, failed.length));
      const parts = [headline, ...results.map(line)];
      for (const r of failed) parts.push(`--- ${r.check} output ---\n${tail(outputs.get(r.check) ?? "", perFailure)}`);
      const sources = [...new Set(results.map((r) => r.source))];
      parts.push(`(Commands ${sources.join("; ")}.)`);
      await runNote(ctx, headline, {
        kind: "sandbox.checks",
        dir: relativeToWorkdir(sb.workdir, dir),
        results: results.map(({ check, passed, exitCode, timedOut, durationMs }) => ({ check, passed, exitCode, timedOut, durationMs })),
      });
      return {
        summary: parts.join("\n"),
        details: { testsFailed: failed.length > 0, checks: results, failed: failed.map((r) => r.check) },
      };
    }),
};

/** Expose a sandbox port for this run's preview and remember it on the row. */
export async function exposeForRun(ctx: ToolContext, sb: Sandbox, port: number): Promise<{ url: string }> {
  const exposed = await sb.exposePort(port);
  // Link through THIS run (the route finds the sandbox it uses, borrowed or own).
  const res = ctx.runId ? { url: previewPath(ctx.runId, port) } : exposed;
  if (ctx.runId) {
    // The port belongs to whichever run owns the sandbox (a sub-agent shares its parent's).
    const live = await liveSandboxForRun({ workspaceId: ctx.workspaceId, runId: ctx.runId }).catch(() => null);
    await addExposedPort(ctx.workspaceId, live?.ownerRunId ?? ctx.runId, port).catch(() => undefined);
    await runNote(ctx, `Preview ready on port ${port}`, { kind: "sandbox.preview", port, url: res.url });
  }
  return res;
}

export const CODE_TOOLS: readonly ToolDef[] = [read_file, glob, grep, write_file, edit_file, bash, run_tests, run_checks];

let registered = false;

/** Register the code tools with the chat tool registry (idempotent). */
export function registerCodeTools(): void {
  if (registered) return;
  registered = true;
  for (const t of CODE_TOOLS) registerExtraTool(t);
}

/** Why the code tools can't run right now (null = they can). */
export async function codeToolsUnavailableReason(): Promise<string | null> {
  const a = await sandboxAvailability();
  return a.ok ? null : a.reason;
}
