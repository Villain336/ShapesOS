// ShapesOS — Phase 8: Docker sandboxes over the Engine API (the default).
//
// One sandbox = a private `Internal: true` network, a named volume for the
// non-root user's home (the workdir lives in it), a gateway sidecar (egress
// allow-list + authenticated preview, egress-gateway.ts) and the sandbox
// container itself:
//
//   - image SANDBOX_IMAGE (default pinned by tag + digest, config.ts)
//   - user 1000:1000 (the image's `node` user), never root
//   - CapDrop ALL, no-new-privileges, read-only root filesystem; writable
//     only /home/node (the volume; workdir /home/node/work) and /tmp (tmpfs)
//   - NanoCpus / Memory (swap = memory) / PidsLimit / nofile ulimit; the
//     workdir is capped only when SANDBOX_DISK_MB is set (a tmpfs-backed
//     volume of that size — memory-backed; Docker can't cap a plain local
//     volume without xfs project quotas)
//   - NO host mounts: Binds is always empty, Mounts holds only the named
//     volume; no published ports, no privileged mode, private IPC
//   - labels shapes.sandbox / .id / .workspace / .run / .role
//   - PID 1 is an idle watchdog: no command for SANDBOX_IDLE_MINUTES → it
//     exits, and AutoRemove deletes the container; the gateway notices the
//     sandbox is gone and exits too; the next create() reaps the orphaned
//     network, volume and checkpoints.
//
// exec uses the exec API (Tty=false → multiplexed stdout/stderr, demuxed and
// streamed as it arrives). Each command runs under coreutils `timeout`, whose
// pid is recorded so a time-out or Stop can signal it (timeout forwards the
// signal to the whole process group, then KILLs it 5 s later).
//
// Checkpoints use the ARCHIVE API: GET /containers/{id}/archive of the
// workdir streams a tar to the host (SANDBOX_SNAPSHOT_DIR), restore empties
// the workdir and PUTs the tar back under /home/node. Chosen over
// `docker commit` because commit never captures volumes (and the workdir
// must be a volume — the root filesystem is read-only), creates image layers
// that need garbage collection, and pauses the container while it runs.
// Archive extraction into the volume is allowed with a read-only rootfs
// because the target path is on a writable mount.

import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { posix } from "node:path";
import type { IncomingMessage } from "node:http";
import type {
  Sandbox,
  SandboxCreateOptions,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxFileEntry,
  SandboxProvider,
} from "./types";
import { DockerApiError, DockerClient } from "./docker-api";
import { sandboxConfig, type SandboxConfig } from "./config";
import { DockerDemuxer, OutputCollector } from "./output";
import { resolveSandboxPath } from "./paths";
import { firstFileInTar, tarSingleFile } from "./tar";
import { listFilesViaExec, newSnapshotId, SandboxCommandError, SNAPSHOT_ID_RE } from "./exec-fs";
import { GATEWAY_SOURCE } from "./egress-gateway";
import { isValidPreviewPort, previewPath, type PreviewCapable, type PreviewUpstream } from "./preview";

export const DOCKER_HOME = "/home/node";
export const DOCKER_WORKDIR = `${DOCKER_HOME}/work`;
export const DOCKER_USER = "1000:1000";
const EGRESS_PORT = 3128;
const PREVIEW_PORT = 8080;
const SANDBOX_ID_RE = /^shapes-sbx-[0-9a-f]{12}$/;
const ACTIVITY = "/tmp/.shapes-activity";

/** The exec wrapper: mark activity, record the pid, run under `timeout`. */
const EXEC_WRAPPER =
  `touch ${ACTIVITY} 2>/dev/null; echo $$ > "/tmp/.shapes-exec-$1.pid"; t=$2; shift 2; exec timeout -k 5 "$t" "$@"`;

/** PID 1: exit once nothing has run for `idle` seconds (a running command counts). */
export function watchdogScript(idleSeconds: number): string {
  return [
    `touch ${ACTIVITY}`,
    `while :; do sleep 15`,
    `for f in /tmp/.shapes-exec-*.pid; do [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null && touch ${ACTIVITY} && break; done`,
    `now=$(date +%s); last=$(stat -c %Y ${ACTIVITY} 2>/dev/null || echo "$now")`,
    `[ $((now - last)) -ge ${Math.max(60, Math.round(idleSeconds))} ] && exit 0`,
    `done`,
  ].join("; ");
}

export interface DockerNames {
  sid: string;
  container: string;
  gateway: string;
  network: string;
  volume: string;
}

export function dockerNames(sid: string): DockerNames {
  const container = `shapes-${sid}`;
  return { sid, container, gateway: `${container}-gw`, network: `${container}-net`, volume: `${container}-home` };
}

export interface SpecInput {
  names: DockerNames;
  image: string;
  workspaceId: string;
  runId: string;
  resources: SandboxConfig["resources"];
  idleSeconds: number;
  egressAllow: string[];
  gatewayToken: string;
  previewBind: string;
}

function labels(i: SpecInput, role: "sandbox" | "gateway"): Record<string, string> {
  return {
    "shapes.sandbox": "1",
    "shapes.sandbox.id": i.names.sid,
    "shapes.sandbox.role": role,
    "shapes.workspace": i.workspaceId,
    "shapes.run": i.runId,
  };
}

/** Security options both containers share. Exported for the tests. */
export const HARDENING = {
  CapDrop: ["ALL"],
  CapAdd: [] as string[],
  SecurityOpt: ["no-new-privileges:true"],
  Privileged: false,
  ReadonlyRootfs: true,
  Binds: [] as string[],
  IpcMode: "private",
  Init: true,
  AutoRemove: true,
} as const;

/** POST /containers/create body for the sandbox. */
export function sandboxContainerSpec(i: SpecInput): Record<string, unknown> {
  const mem = Math.round(i.resources.memoryMb * 1024 * 1024);
  const proxy = `http://egress:${EGRESS_PORT}`;
  return {
    Image: i.image,
    Cmd: ["/bin/sh", "-c", watchdogScript(i.idleSeconds)],
    User: DOCKER_USER,
    WorkingDir: DOCKER_HOME,
    Hostname: "sandbox",
    Tty: false,
    OpenStdin: false,
    AttachStdin: false,
    Env: [
      `HOME=${DOCKER_HOME}`,
      `HTTP_PROXY=${proxy}`,
      `HTTPS_PROXY=${proxy}`,
      `http_proxy=${proxy}`,
      `https_proxy=${proxy}`,
      "NO_PROXY=localhost,127.0.0.1,sandbox",
      "no_proxy=localhost,127.0.0.1,sandbox",
      "NPM_CONFIG_UPDATE_NOTIFIER=false",
      "PIP_DISABLE_PIP_VERSION_CHECK=1",
      "SHAPES_SANDBOX=1",
    ],
    Labels: labels(i, "sandbox"),
    HostConfig: {
      ...HARDENING,
      Mounts: [{ Type: "volume", Source: i.names.volume, Target: DOCKER_HOME, ReadOnly: false }],
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=1024m" },
      NanoCpus: Math.round(i.resources.cpus * 1e9),
      Memory: mem,
      MemorySwap: mem,
      PidsLimit: i.resources.pids,
      Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 8192 }],
      NetworkMode: i.names.network,
      PortBindings: {},
      PublishAllPorts: false,
    },
    NetworkingConfig: { EndpointsConfig: { [i.names.network]: { Aliases: ["sandbox"] } } },
  };
}

/** POST /containers/create body for the gateway sidecar. */
export function gatewayContainerSpec(i: SpecInput): Record<string, unknown> {
  const mem = 128 * 1024 * 1024;
  return {
    Image: i.image,
    Cmd: ["node", "-e", GATEWAY_SOURCE],
    User: DOCKER_USER,
    Tty: false,
    Env: [
      `ALLOW=${i.egressAllow.join(",")}`,
      `GATEWAY_TOKEN=${i.gatewayToken}`,
      "SANDBOX_HOST=sandbox",
      `EGRESS_PORT=${EGRESS_PORT}`,
      `PREVIEW_PORT=${PREVIEW_PORT}`,
    ],
    Labels: labels(i, "gateway"),
    ExposedPorts: { [`${PREVIEW_PORT}/tcp`]: {} },
    HostConfig: {
      ...HARDENING,
      Mounts: [],
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=16m" },
      NanoCpus: 250_000_000,
      Memory: mem,
      MemorySwap: mem,
      PidsLimit: 64,
      NetworkMode: "bridge",
      // Previews only: on the Docker host's loopback (SANDBOX_PREVIEW_BIND),
      // random port, and the gateway still demands its token.
      PortBindings: { [`${PREVIEW_PORT}/tcp`]: [{ HostIp: i.previewBind, HostPort: "" }] },
      PublishAllPorts: false,
    },
  };
}

export function networkSpec(i: SpecInput): Record<string, unknown> {
  return {
    Name: i.names.network,
    Driver: "bridge",
    Internal: true,
    Attachable: false,
    CheckDuplicate: true,
    Labels: { "shapes.sandbox": "1", "shapes.sandbox.id": i.names.sid, "shapes.run": i.runId },
  };
}

export function volumeSpec(i: SpecInput): Record<string, unknown> {
  const disk = i.resources.diskMb;
  return {
    Name: i.names.volume,
    Driver: "local",
    DriverOpts: disk ? { type: "tmpfs", device: "tmpfs", o: `size=${disk}m,uid=1000,gid=1000,mode=0755` } : {},
    Labels: { "shapes.sandbox": "1", "shapes.sandbox.id": i.names.sid, "shapes.run": i.runId },
  };
}

export interface DockerProviderDeps {
  client?: DockerClient;
  config?: SandboxConfig;
  /** Where the preview gateway's host port is bound (default 127.0.0.1). */
  previewBind?: string;
  /** Hook for the fake engine tests: skip the reaper. */
  reap?: boolean;
}

function readAll(res: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    res.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) {
        res.destroy();
        reject(new SandboxCommandError(`Response over ${max} bytes`));
        return;
      }
      chunks.push(c);
    });
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
  });
}

export class DockerSandbox implements Sandbox, PreviewCapable {
  readonly provider = "docker" as const;
  readonly workdir = DOCKER_WORKDIR;
  private gatewayCheckedAt = 0;

  constructor(
    private readonly client: DockerClient,
    private readonly cfg: SandboxConfig,
    readonly names: DockerNames,
    readonly workspaceId: string,
    readonly runId: string,
    private readonly deps: { previewBind: string },
  ) {}

  get id(): string {
    return this.names.container;
  }

  private snapshotDir(): string {
    const root = isAbsolute(this.cfg.docker.snapshotDir) ? this.cfg.docker.snapshotDir : join(process.cwd(), this.cfg.docker.snapshotDir);
    return join(root, this.names.container);
  }

  /** Recreate the gateway if it exited (checked at most once a minute). */
  async ensureGateway(force = false): Promise<void> {
    if (!force && Date.now() - this.gatewayCheckedAt < 60_000) return;
    this.gatewayCheckedAt = Date.now();
    const { data } = await this.client.json<{ State?: { Running?: boolean } }>("GET", `/containers/${this.names.gateway}/json`, { allow: [404] });
    if (data?.State?.Running) return;
    await this.client.call("DELETE", `/containers/${this.names.gateway}`, { query: { force: true }, allow: [404, 409] });
    await startGateway(this.client, {
      names: this.names,
      image: this.cfg.docker.image,
      workspaceId: this.workspaceId,
      runId: this.runId,
      resources: this.cfg.resources,
      idleSeconds: this.cfg.idleSeconds,
      egressAllow: this.cfg.egressAllow,
      gatewayToken: randomBytes(24).toString("hex"),
      previewBind: this.deps.previewBind,
    });
  }

  private async signal(tag: string, sig: "TERM" | "KILL"): Promise<void> {
    try {
      const { data } = await this.client.json<{ Id: string }>("POST", `/containers/${this.id}/exec`, {
        body: {
          AttachStdout: false,
          AttachStderr: false,
          Tty: false,
          User: DOCKER_USER,
          Cmd: ["/bin/sh", "-c", `p=$(cat /tmp/.shapes-exec-${tag}.pid 2>/dev/null) && kill -${sig} "$p" 2>/dev/null; true`],
        },
      });
      if (data?.Id) await this.client.call("POST", `/exec/${data.Id}/start`, { body: { Detach: true, Tty: false } });
    } catch {
      // Best effort: the in-container `timeout` is the backstop.
    }
  }

  async exec(cmd: string | string[], opts: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    const argv = typeof cmd === "string" ? ["/bin/sh", "-lc", cmd] : cmd;
    if (argv.length === 0) throw new SandboxCommandError("Empty command.");
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("Aborted");
    await this.ensureGateway().catch(() => undefined);
    const tag = randomBytes(6).toString("hex");
    const secs = opts.timeoutMs ? Math.ceil(opts.timeoutMs / 1000) + 5 : 0;
    const env = Object.entries(opts.env ?? {})
      .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      .map(([k, v]) => `${k}=${v}`);
    const cwd = resolveSandboxPath(this.workdir, opts.cwd ?? this.workdir);
    const started = Date.now();
    const { data } = await this.client.json<{ Id: string }>("POST", `/containers/${this.id}/exec`, {
      body: {
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: DOCKER_USER,
        WorkingDir: cwd,
        Env: env,
        Cmd: ["/bin/sh", "-c", EXEC_WRAPPER, "shapes-exec", tag, String(secs), ...argv],
      },
    });
    if (!data?.Id) throw new SandboxCommandError("Docker did not create the exec.");
    const execId = data.Id;
    const out = new OutputCollector(opts);
    const demux = new DockerDemuxer((s, d) => out.push(s, d));
    const res = await this.client.stream("POST", `/exec/${execId}/start`, { body: { Detach: false, Tty: false } });
    if ((res.statusCode ?? 0) >= 400) {
      const body = await readAll(res, 64 * 1024).catch(() => Buffer.alloc(0));
      throw new DockerApiError(res.statusCode ?? 0, `exec start failed: ${body.toString("utf8").slice(0, 300)}`);
    }
    let timedOut = false;
    let aborted = false;
    const timers: NodeJS.Timeout[] = [];
    const stop = (why: "timeout" | "abort") => {
      if (why === "timeout") timedOut = true;
      else aborted = true;
      void this.signal(tag, "TERM");
      timers.push(setTimeout(() => void this.signal(tag, "KILL"), 5_000));
      // Hard guard: never wait forever on a wedged stream.
      timers.push(setTimeout(() => res.destroy(), 20_000));
    };
    if (opts.timeoutMs) timers.push(setTimeout(() => stop("timeout"), opts.timeoutMs));
    const onAbort = () => stop("abort");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await new Promise<void>((resolve) => {
        res.on("data", (c: Buffer) => demux.write(c));
        res.on("end", () => resolve());
        res.on("close", () => resolve());
        res.on("error", () => resolve());
      });
    } finally {
      for (const t of timers) clearTimeout(t);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    if (aborted) throw opts.signal?.reason ?? new Error("Aborted");
    let exitCode: number | null = null;
    for (let i = 0; i < 10 && exitCode === null; i++) {
      const { data: info } = await this.client.json<{ Running?: boolean; ExitCode?: number | null }>("GET", `/exec/${execId}/json`);
      if (info && !info.Running && typeof info.ExitCode === "number") exitCode = info.ExitCode;
      else await new Promise((r) => setTimeout(r, 100));
    }
    if (exitCode === 124) timedOut = true;
    return out.result(exitCode ?? (timedOut ? 124 : -1), timedOut, started);
  }

  async readFile(path: string): Promise<Buffer> {
    const abs = resolveSandboxPath(this.workdir, path);
    const { status, body } = await this.client.call("GET", `/containers/${this.id}/archive`, {
      query: { path: abs },
      allow: [404],
      maxBytes: 128 * 1024 * 1024,
    });
    if (status === 404) throw new SandboxCommandError(`No such file: ${path}`);
    const file = firstFileInTar(body);
    if (!file) throw new SandboxCommandError(`${path} is not a regular file.`);
    return file;
  }

  async writeFile(path: string, data: Buffer | string): Promise<void> {
    const abs = resolveSandboxPath(this.workdir, path);
    if (abs === this.workdir) throw new SandboxCommandError("Can't write over the workdir itself.");
    const dir = posix.dirname(abs);
    const mk = await this.exec(["mkdir", "-p", dir], { timeoutMs: 30_000 });
    if (mk.exitCode !== 0) throw new SandboxCommandError(`Couldn't create ${dir}: ${mk.stderr.trim()}`, mk);
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    await this.client.call("PUT", `/containers/${this.id}/archive`, {
      query: { path: dir, noOverwriteDirNonDir: true },
      raw: tarSingleFile(posix.basename(abs), buf, { uid: 1000, gid: 1000 }),
    });
  }

  listFiles(dir: string, opts?: { recursive?: boolean; maxEntries?: number }): Promise<SandboxFileEntry[]> {
    return listFilesViaExec((c, o) => this.exec(c, o), this.workdir, dir, opts);
  }

  async snapshot(label?: string): Promise<{ id: string; label?: string; createdAt: string }> {
    const id = newSnapshotId();
    const dir = this.snapshotDir();
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${id}.tar`);
    const res = await this.client.stream("GET", `/containers/${this.id}/archive`, { query: { path: this.workdir } });
    if ((res.statusCode ?? 0) >= 400) {
      const body = await readAll(res, 64 * 1024).catch(() => Buffer.alloc(0));
      throw new DockerApiError(res.statusCode ?? 0, `Checkpoint failed: ${body.toString("utf8").slice(0, 300)}`);
    }
    const max = this.cfg.docker.snapshotMaxBytes;
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(file, { mode: 0o600 });
      let n = 0;
      res.on("data", (c: Buffer) => {
        n += c.length;
        if (n > max) {
          res.destroy();
          ws.destroy();
          reject(new SandboxCommandError(`Checkpoint is over ${Math.round(max / 1024 / 1024)} MB (SANDBOX_SNAPSHOT_MAX_MB).`));
          return;
        }
        if (!ws.write(c)) res.pause();
      });
      ws.on("drain", () => res.resume());
      res.on("end", () => ws.end());
      ws.on("finish", () => resolve());
      res.on("error", reject);
      ws.on("error", reject);
    }).catch(async (err) => {
      await rm(file, { force: true });
      throw err;
    });
    return { id, label, createdAt: new Date().toISOString() };
  }

  async restore(snapshotId: string): Promise<void> {
    if (!SNAPSHOT_ID_RE.test(snapshotId)) throw new SandboxCommandError("Unknown checkpoint.");
    const file = join(this.snapshotDir(), `${snapshotId}.tar`);
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) throw new SandboxCommandError("Unknown checkpoint.");
    const clear = await this.exec(["find", this.workdir, "-mindepth", "1", "-delete"], { timeoutMs: 120_000 });
    if (clear.exitCode !== 0) throw new SandboxCommandError(`Couldn't clear the workdir: ${clear.stderr.trim()}`, clear);
    // The tar's entries are "work/…" (GET of /home/node/work): extract under
    // its parent, the volume root — writable even with a read-only rootfs.
    await this.client.call("PUT", `/containers/${this.id}/archive`, {
      query: { path: posix.dirname(this.workdir) },
      rawStream: createReadStream(file),
    });
  }

  async exposePort(port: number): Promise<{ url: string }> {
    if (!isValidPreviewPort(port)) throw new SandboxCommandError("Pick a port between 1024 and 65535.");
    await this.ensureGateway(true);
    return { url: previewPath(this.runId, port) };
  }

  async previewUpstream(port: number): Promise<PreviewUpstream> {
    if (!isValidPreviewPort(port)) throw new SandboxCommandError("Invalid preview port.");
    await this.ensureGateway();
    const { data } = await this.client.json<{
      Config?: { Env?: string[] };
      NetworkSettings?: { Ports?: Record<string, Array<{ HostIp: string; HostPort: string }> | null> };
    }>("GET", `/containers/${this.names.gateway}/json`);
    const binding = data?.NetworkSettings?.Ports?.[`${PREVIEW_PORT}/tcp`]?.[0];
    const token = (data?.Config?.Env ?? []).find((e) => e.startsWith("GATEWAY_TOKEN="))?.slice("GATEWAY_TOKEN=".length);
    const hostPort = Number(binding?.HostPort);
    if (!token || !Number.isInteger(hostPort) || hostPort <= 0) throw new SandboxCommandError("The sandbox preview gateway isn't running.");
    return {
      origin: `http://${this.cfg.docker.previewHost}:${hostPort}`,
      headers: { "x-shapes-gateway-token": token, "x-shapes-preview-port": String(port) },
      kind: "loopback",
    };
  }

  async destroy(): Promise<void> {
    await destroyByNames(this.client, this.names);
    await rm(this.snapshotDir(), { recursive: true, force: true }).catch(() => undefined);
  }
}

async function destroyByNames(client: DockerClient, n: DockerNames): Promise<void> {
  for (const c of [n.container, n.gateway]) {
    await client.call("DELETE", `/containers/${c}`, { query: { force: true, v: true }, allow: [404, 409] }).catch(() => undefined);
  }
  await client.call("DELETE", `/networks/${n.network}`, { allow: [404, 409] }).catch(() => undefined);
  await client.call("DELETE", `/volumes/${n.volume}`, { query: { force: true }, allow: [404, 409] }).catch(() => undefined);
}

async function startGateway(client: DockerClient, i: SpecInput): Promise<void> {
  await client.json("POST", "/containers/create", { query: { name: i.names.gateway }, body: gatewayContainerSpec(i) });
  await client.call("POST", `/networks/${i.names.network}/connect`, {
    body: { Container: i.names.gateway, EndpointConfig: { Aliases: ["egress"] } },
  });
  await client.call("POST", `/containers/${i.names.gateway}/start`, { allow: [304] });
}

async function pullImage(client: DockerClient, image: string): Promise<void> {
  const { body } = await client.call("POST", "/images/create", { query: { fromImage: image }, timeoutMs: 15 * 60_000, maxBytes: 256 * 1024 * 1024 });
  // The pull streams JSON progress lines; a failure arrives as {"error": …}.
  for (const line of body.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { error?: string };
      if (j.error) throw new SandboxCommandError(`Couldn't pull ${image}: ${j.error}`);
    } catch (e) {
      if (e instanceof SandboxCommandError) throw e;
    }
  }
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker" as const;
  private readonly cfg: SandboxConfig;
  private readonly client: DockerClient;
  private readonly previewBind: string;
  private readonly reap: boolean;

  constructor(deps: DockerProviderDeps = {}) {
    this.cfg = deps.config ?? sandboxConfig();
    this.client = deps.client ?? new DockerClient(this.cfg.docker.socketPath);
    this.previewBind = deps.previewBind ?? this.cfg.docker.previewBind;
    this.reap = deps.reap ?? true;
  }

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const sock = this.cfg.docker.socketPath;
    if (!sock) return { ok: false, reason: "DOCKER_HOST must be a unix socket (unix:///var/run/docker.sock); TCP Docker hosts are not supported." };
    const st = await stat(sock).catch(() => null);
    if (!st) return { ok: false, reason: `No Docker socket at ${sock} — mount it into the worker or pick SANDBOX_PROVIDER=e2b|daytona.` };
    if (!(await this.client.ping())) return { ok: false, reason: `The Docker daemon at ${sock} did not answer.` };
    return { ok: true };
  }

  async create(opts: SandboxCreateOptions): Promise<Sandbox> {
    if (!opts.workspaceId || !opts.runId) throw new SandboxCommandError("A sandbox needs a workspace and a run.");
    if (this.reap) await this.reapOrphans().catch(() => undefined);
    const names = dockerNames(`sbx-${randomBytes(6).toString("hex")}`);
    const r = { ...this.cfg.resources, ...(opts.resources ?? {}) };
    const input: SpecInput = {
      names,
      image: opts.image ?? this.cfg.docker.image,
      workspaceId: opts.workspaceId,
      runId: opts.runId,
      resources: { cpus: r.cpus ?? 2, memoryMb: r.memoryMb ?? 2048, pids: r.pids ?? 512, diskMb: r.diskMb ?? null },
      idleSeconds: this.cfg.idleSeconds,
      egressAllow: opts.egressAllow?.length ? opts.egressAllow : this.cfg.egressAllow,
      gatewayToken: randomBytes(24).toString("hex"),
      previewBind: this.previewBind,
    };
    try {
      await this.client.call("POST", "/networks/create", { body: networkSpec(input) });
      await this.client.call("POST", "/volumes/create", { body: volumeSpec(input) });
      const create = () =>
        this.client.call("POST", "/containers/create", {
          query: { name: names.container },
          body: sandboxContainerSpec(input),
          allow: [404],
        });
      let res = await create();
      if (res.status === 404) {
        await pullImage(this.client, input.image);
        res = await create();
        if (res.status === 404) throw new SandboxCommandError(`Image ${input.image} is not available.`);
      }
      await startGateway(this.client, input);
      await this.client.call("POST", `/containers/${names.container}/start`, { allow: [304] });
      const sb = new DockerSandbox(this.client, this.cfg, names, opts.workspaceId, opts.runId, { previewBind: this.previewBind });
      const mk = await sb.exec(["mkdir", "-p", DOCKER_WORKDIR], { timeoutMs: 30_000 });
      if (mk.exitCode !== 0) throw new SandboxCommandError(`Couldn't create the workdir: ${mk.stderr.trim()}`);
      return sb;
    } catch (err) {
      await destroyByNames(this.client, names);
      throw err;
    }
  }

  async get(id: string): Promise<Sandbox | null> {
    if (!SANDBOX_ID_RE.test(id)) return null;
    const { status, data } = await this.client.json<{ State?: { Running?: boolean }; Config?: { Labels?: Record<string, string> } }>(
      "GET",
      `/containers/${id}/json`,
      { allow: [404] },
    );
    if (status === 404 || !data?.State?.Running) return null;
    const l = data.Config?.Labels ?? {};
    if (l["shapes.sandbox"] !== "1" || l["shapes.sandbox.role"] !== "sandbox") return null;
    const sid = l["shapes.sandbox.id"] ?? "";
    if (`shapes-${sid}` !== id) return null;
    return new DockerSandbox(this.client, this.cfg, dockerNames(sid), l["shapes.workspace"] ?? "", l["shapes.run"] ?? "", { previewBind: this.previewBind });
  }

  /** Remove networks / volumes / gateways / checkpoints whose sandbox is gone. */
  async reapOrphans(): Promise<number> {
    const filters = JSON.stringify({ label: ["shapes.sandbox=1"] });
    const live = new Set<string>();
    const { data: containers } = await this.client.json<Array<{ Labels?: Record<string, string>; State?: string }>>("GET", "/containers/json", {
      query: { all: true, filters },
    });
    for (const c of containers ?? []) {
      if (c.Labels?.["shapes.sandbox.role"] === "sandbox" && c.State === "running") live.add(c.Labels["shapes.sandbox.id"] ?? "");
    }
    const dead = new Set<string>();
    for (const c of containers ?? []) {
      const sid = c.Labels?.["shapes.sandbox.id"];
      if (sid && !live.has(sid)) dead.add(sid);
    }
    const { data: nets } = await this.client.json<Array<{ Labels?: Record<string, string> }>>("GET", "/networks", { query: { filters } });
    for (const n of nets ?? []) {
      const sid = n.Labels?.["shapes.sandbox.id"];
      if (sid && !live.has(sid)) dead.add(sid);
    }
    const { data: vols } = await this.client.json<{ Volumes?: Array<{ Labels?: Record<string, string> }> }>("GET", "/volumes", { query: { filters } });
    for (const v of vols?.Volumes ?? []) {
      const sid = v.Labels?.["shapes.sandbox.id"];
      if (sid && !live.has(sid)) dead.add(sid);
    }
    for (const sid of dead) if (/^sbx-[0-9a-f]{12}$/.test(sid)) await destroyByNames(this.client, dockerNames(sid));
    // Checkpoints of sandboxes that no longer exist.
    const root = isAbsolute(this.cfg.docker.snapshotDir) ? this.cfg.docker.snapshotDir : join(process.cwd(), this.cfg.docker.snapshotDir);
    for (const d of await readdir(root).catch(() => [] as string[])) {
      if (SANDBOX_ID_RE.test(d) && !live.has(d.slice("shapes-".length))) await rm(join(root, d), { recursive: true, force: true }).catch(() => undefined);
    }
    return dead.size;
  }
}

