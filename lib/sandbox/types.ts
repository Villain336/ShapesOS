// ShapesOS — Phase 8: the sandbox contract (PURE types; no implementation).
//
// Every code-running tool (lib/sandbox/tools.ts, the GitHub / ship tools)
// talks to a Sandbox through this interface only, so providers are pluggable:
// Docker (default, Engine API over the socket), E2B or Daytona (hosted
// microVMs, switched on by key). A sandbox belongs to ONE agent run in ONE
// workspace and is destroyed when the run ends or idles out. Nothing here
// ever runs on the host: when no provider is available, code tools are off
// and say why — they are never faked.
//
// THIS FILE IS SHARED BY PARALLEL WORKSTREAMS — add new exports in other
// files; do not change these shapes without changing every implementation.

export type SandboxProviderName = "docker" | "e2b" | "daytona";

export interface SandboxExecOptions {
  /** Working directory inside the sandbox (default: the sandbox workdir). */
  cwd?: string;
  env?: Record<string, string>;
  /** Hard wall-clock limit; the process is killed and timedOut=true. */
  timeoutMs?: number;
  /** Aborted when the agent run is stopped (Phase 5 Stop). */
  signal?: AbortSignal;
  /** Streamed output as it arrives (for the live run timeline). */
  onOutput?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void;
  /** Cap on captured stdout/stderr (bytes each); output beyond it is truncated. */
  maxOutputBytes?: number;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when stdout/stderr were cut at maxOutputBytes. */
  truncated: boolean;
  durationMs: number;
}

export interface SandboxFileEntry {
  /** Path relative to the listed directory. */
  path: string;
  type: "file" | "dir";
  size?: number;
}

export interface Sandbox {
  readonly id: string;
  readonly provider: SandboxProviderName;
  /** Absolute workdir inside the sandbox (repos are cloned under it). */
  readonly workdir: string;
  /** Run a command. A string runs through `sh -lc`; an array runs directly. */
  exec(cmd: string | string[], opts?: SandboxExecOptions): Promise<SandboxExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer | string): Promise<void>;
  listFiles(dir: string, opts?: { recursive?: boolean; maxEntries?: number }): Promise<SandboxFileEntry[]>;
  /** Point-in-time copy of the workdir (checkpoint). */
  snapshot(label?: string): Promise<{ id: string; label?: string; createdAt: string }>;
  restore(snapshotId: string): Promise<void>;
  /** Make a port reachable for a preview; returns the URL a browser can open. */
  exposePort(port: number): Promise<{ url: string }>;
  destroy(): Promise<void>;
}

export interface SandboxCreateOptions {
  workspaceId: string;
  /** The AgentRun this sandbox serves (one sandbox per run). */
  runId: string;
  image?: string;
  resources?: { cpus?: number; memoryMb?: number; pids?: number; diskMb?: number };
  /** Hosts the sandbox may reach (package registries, GitHub, …). */
  egressAllow?: string[];
}

export interface SandboxProvider {
  readonly name: SandboxProviderName;
  /** Configured and reachable right now (cheap check). */
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  create(opts: SandboxCreateOptions): Promise<Sandbox>;
  /** Reattach to a live sandbox by id (null when gone). */
  get(id: string): Promise<Sandbox | null>;
}
