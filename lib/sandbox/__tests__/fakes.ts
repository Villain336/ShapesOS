// ShapesOS — Phase 8 TEST DOUBLES for the sandbox contract. MOCK, not a
// provider: LocalDirSandbox runs commands with /bin/sh in a temp directory
// on the test machine so the tool layer can be exercised end to end without
// Docker. Production never uses it (lib/sandbox/index.ts only knows docker,
// e2b, daytona).

import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Sandbox, SandboxCreateOptions, SandboxExecOptions, SandboxExecResult, SandboxFileEntry, SandboxProvider } from "../types";
import { OutputCollector } from "../output";
import { resolveSandboxPath } from "../paths";
import { listFilesViaExec, newSnapshotId } from "../exec-fs";
import { previewPath, type PreviewCapable, type PreviewUpstream } from "../preview";

export class LocalDirSandbox implements Sandbox, PreviewCapable {
  readonly provider = "docker" as const;
  readonly workdir: string;
  readonly id: string;
  destroyed = false;
  readonly snapshots = new Map<string, string>();
  readonly execs: Array<{ cmd: string | string[]; opts?: SandboxExecOptions }> = [];
  upstream: PreviewUpstream | null = null;
  private readonly root: string;

  constructor(readonly runId = "run-test", id?: string) {
    this.root = mkdtempSync(join(tmpdir(), "shapes-sbx-test-"));
    this.workdir = join(this.root, "work");
    mkdirSync(this.workdir, { recursive: true });
    this.id = id ?? `shapes-sbx-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
  }

  exec(cmd: string | string[], opts: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    this.execs.push({ cmd, opts });
    const argv = typeof cmd === "string" ? ["/bin/sh", "-c", cmd] : cmd;
    const started = Date.now();
    const out = new OutputCollector(opts);
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd ?? this.workdir, env: { ...process.env, ...(opts.env ?? {}) } });
      let timedOut = false;
      const t = opts.timeoutMs ? setTimeout(() => ((timedOut = true), child.kill("SIGKILL")), opts.timeoutMs) : null;
      const onAbort = () => child.kill("SIGKILL");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d: Buffer) => out.push("stdout", d));
      child.stderr.on("data", (d: Buffer) => out.push("stderr", d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (t) clearTimeout(t);
        opts.signal?.removeEventListener("abort", onAbort);
        if (opts.signal?.aborted) return reject(opts.signal.reason ?? new Error("Aborted"));
        resolve(out.result(timedOut ? 124 : (code ?? -1), timedOut, started));
      });
    });
  }

  async readFile(path: string): Promise<Buffer> {
    return readFileSync(resolveSandboxPath(this.workdir, path));
  }

  async writeFile(path: string, data: Buffer | string): Promise<void> {
    const abs = resolveSandboxPath(this.workdir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
  }

  listFiles(dir: string, opts?: { recursive?: boolean; maxEntries?: number }): Promise<SandboxFileEntry[]> {
    return listFilesViaExec((c, o) => this.exec(c, o), this.workdir, dir, opts);
  }

  async snapshot(label?: string) {
    const id = newSnapshotId();
    const to = join(this.root, "snaps", id);
    cpSync(this.workdir, to, { recursive: true });
    this.snapshots.set(id, to);
    return { id, label, createdAt: new Date().toISOString() };
  }

  async restore(snapshotId: string): Promise<void> {
    const from = this.snapshots.get(snapshotId);
    if (!from) throw new Error("Unknown checkpoint.");
    rmSync(this.workdir, { recursive: true, force: true });
    cpSync(from, this.workdir, { recursive: true });
  }

  async exposePort(port: number): Promise<{ url: string }> {
    return { url: previewPath(this.runId, port) };
  }

  async previewUpstream(): Promise<PreviewUpstream> {
    if (!this.upstream) throw new Error("no upstream");
    return this.upstream;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** A provider handing out LocalDirSandboxes; records every call. MOCK. */
export class FakeProvider implements SandboxProvider {
  readonly name = "docker" as const;
  readonly created: LocalDirSandbox[] = [];
  readonly byId = new Map<string, LocalDirSandbox>();
  ok = true;
  createDelayMs = 0;
  upstream: PreviewUpstream | null = null;

  async available() {
    return this.ok ? ({ ok: true } as const) : ({ ok: false, reason: "fake provider is down" } as const);
  }

  async create(opts: SandboxCreateOptions): Promise<Sandbox> {
    if (this.createDelayMs) await new Promise((r) => setTimeout(r, this.createDelayMs));
    const s = new LocalDirSandbox(opts.runId);
    s.upstream = this.upstream;
    this.created.push(s);
    this.byId.set(s.id, s);
    return s;
  }

  async get(id: string): Promise<Sandbox | null> {
    const s = this.byId.get(id);
    return s && !s.destroyed ? s : null;
  }
}
