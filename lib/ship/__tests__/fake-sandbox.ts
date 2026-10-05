// TEST-ONLY fake Sandbox: a temp directory plus child_process running real
// `git` and `sh` on this machine. It exists so the ship tools can be tested
// against real git with no network and no sandbox provider. It is NEVER
// exported from non-test code and never used at runtime (the runtime gets a
// real provider through sandboxForRun()).
//
// Test-only rewrites (documented so nothing here is mistaken for runtime
// behaviour): https://github.com/<owner>/<repo>.git in a git argv is pointed
// at a local bare repository under the fake's "remotes" dir, and the file
// protocol is allowed for its processes — so clone / fetch / push run for
// real against a local remote. Every exec (argv + env) is logged so tests can
// prove a token never appears in a command line.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Sandbox, SandboxExecOptions, SandboxExecResult, SandboxFileEntry } from "@/lib/sandbox/types";

// The host PATH, so git and sh resolve (a system variable, not app config).
const { PATH } = process.env;

export interface ExecLogEntry {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface FakeSandbox extends Sandbox {
  root: string;
  remotesDir: string;
  log: ExecLogEntry[];
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
): Promise<SandboxExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, signal: opts.signal });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const take = (cur: string, chunk: Buffer) => {
      const next = cur + chunk.toString("utf8");
      if (Buffer.byteLength(next) > opts.maxOutputBytes) {
        truncated = true;
        return next.slice(0, opts.maxOutputBytes);
      }
      return next;
    };
    child.stdout.on("data", (c: Buffer) => (stdout = take(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = take(stderr, c)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: stderr + String(err), timedOut, truncated, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut, truncated, durationMs: Date.now() - started });
    });
  });
}

export function createFakeSandbox(): FakeSandbox {
  const root = mkdtempSync(path.join(tmpdir(), "shapes-fake-sandbox-"));
  const workdir = path.join(root, "work");
  const home = path.join(root, "home");
  const remotesDir = path.join(root, "remotes");
  for (const d of [workdir, home, remotesDir]) mkdirSync(d, { recursive: true });
  const log: ExecLogEntry[] = [];
  const baseEnv: Record<string, string | undefined> = {
    PATH: PATH,
    HOME: home,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    // TEST-ONLY: the local "remote" is reached over the file protocol.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
  };
  const rewrite = (a: string) => {
    const m = a.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    return m ? path.join(remotesDir, m[1]!, `${m[2]}.git`) : a;
  };
  const resolve = (p: string) => (path.isAbsolute(p) ? p : path.join(workdir, p));

  const sb: FakeSandbox = {
    id: `fake-${path.basename(root)}`,
    provider: "docker",
    workdir,
    root,
    remotesDir,
    log,
    async exec(cmd: string | string[], opts: SandboxExecOptions = {}) {
      const argv = typeof cmd === "string" ? ["sh", "-lc", cmd] : [...cmd];
      log.push({ argv: [...argv], env: { ...(opts.env ?? {}) }, cwd: opts.cwd ?? workdir });
      const real = argv[0] === "git" ? argv.map(rewrite) : argv;
      return run(real[0]!, real.slice(1), {
        cwd: opts.cwd ? resolve(opts.cwd) : workdir,
        env: { ...baseEnv, ...(opts.env ?? {}) },
        timeoutMs: opts.timeoutMs ?? 60_000,
        maxOutputBytes: opts.maxOutputBytes ?? 4 * 1024 * 1024,
        signal: opts.signal,
      });
    },
    async readFile(p: string) {
      return fs.readFile(resolve(p));
    },
    async writeFile(p: string, data: Buffer | string) {
      await fs.mkdir(path.dirname(resolve(p)), { recursive: true });
      await fs.writeFile(resolve(p), data);
    },
    async listFiles(dir: string, opts?: { recursive?: boolean; maxEntries?: number }) {
      const base = resolve(dir);
      const out: SandboxFileEntry[] = [];
      const walk = async (d: string) => {
        for (const e of await fs.readdir(d, { withFileTypes: true })) {
          if (out.length >= (opts?.maxEntries ?? 10_000)) return;
          const full = path.join(d, e.name);
          const rel = path.relative(base, full);
          if (e.isDirectory()) {
            out.push({ path: rel, type: "dir" });
            if (opts?.recursive && e.name !== ".git") await walk(full);
          } else {
            out.push({ path: rel, type: "file", size: (await fs.stat(full)).size });
          }
        }
      };
      await walk(base);
      return out;
    },
    async snapshot() {
      throw new Error("fake sandbox: snapshot not supported");
    },
    async restore() {
      throw new Error("fake sandbox: restore not supported");
    },
    async exposePort() {
      throw new Error("fake sandbox: exposePort not supported");
    },
    async destroy() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
  return sb;
}

/** Create a bare "GitHub" repository the fake resolves https://github.com/<owner>/<repo>.git to. */
export async function seedRemote(
  sb: FakeSandbox,
  owner: string,
  repo: string,
  files: Record<string, string>,
  branch = "main",
): Promise<string> {
  const bare = path.join(sb.remotesDir, owner, `${repo}.git`);
  const seed = path.join(sb.root, "seed", owner, repo);
  await fs.mkdir(seed, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(seed, name)), { recursive: true });
    await fs.writeFile(path.join(seed, name), content);
  }
  const sh = (args: string[], cwd: string) =>
    run("git", args, {
      cwd,
      env: { PATH: PATH, HOME: path.join(sb.root, "home"), GIT_CONFIG_NOSYSTEM: "1" },
      timeoutMs: 30_000,
      maxOutputBytes: 1 << 20,
    }).then((r) => {
      if (r.exitCode !== 0) throw new Error(`seed git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    });
  await fs.mkdir(path.dirname(bare), { recursive: true });
  await sh(["init", "-q", "--bare", "-b", branch, bare], sb.root);
  await sh(["init", "-q", "-b", branch], seed);
  await sh(["-c", "user.name=seed", "-c", "user.email=seed@example.invalid", "add", "-A"], seed);
  await sh(["-c", "user.name=seed", "-c", "user.email=seed@example.invalid", "commit", "-qm", "initial"], seed);
  await sh(["push", "-q", bare, `${branch}:refs/heads/${branch}`], seed);
  return bare;
}

/** Read a ref of a bare remote (null when absent). */
export async function remoteRef(bare: string, ref: string): Promise<string | null> {
  const r = await run("git", ["--git-dir", bare, "rev-parse", "--verify", "-q", ref], {
    cwd: path.dirname(bare),
    env: { PATH: PATH, GIT_CONFIG_NOSYSTEM: "1" },
    timeoutMs: 10_000,
    maxOutputBytes: 1 << 16,
  });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}
