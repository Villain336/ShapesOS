// ShapesOS — Phase 8: E2B sandboxes (hosted Firecracker microVMs), over HTTP.
//
// Enabled by SANDBOX_PROVIDER=e2b + E2B_API_KEY. Written against E2B's
// published specs (github.com/e2b-dev/E2B spec/openapi.yml, spec/envd/
// envd.yaml, spec/envd/process/process.proto — read 2026-10-04) and the JS
// SDK's connection code, without the SDK (no new dependency):
//
//   control plane  https://api.<E2B_DOMAIN>          header X-API-Key
//     POST   /v2/sandboxes            {templateID, timeout, metadata, network…}
//     GET    /sandboxes/{id}           detail (state, envdAccessToken, domain)
//     POST   /sandboxes/{id}/timeout   {timeout} — the idle timer, reset per command
//     DELETE /sandboxes/{id}
//   envd           https://49983-<id>.<domain>       header X-Access-Token,
//                  E2b-Sandbox-Id / E2b-Sandbox-Port, Authorization: Basic
//                  base64("user:") to pick the Linux user
//     POST /process.Process/Start      Connect server-stream (application/
//                                      connect+json envelopes): start / data
//                                      (base64 stdout|stderr) / end events
//     POST /process.Process/SendSignal Connect unary JSON (time-out / Stop)
//     GET  /files?path=…               download     POST /files?path=… upload
//
// Egress: network.allowOut = the allow-list, denyOut = 0.0.0.0/0 (E2B: "when
// using domain-based filtering, you must deny all other traffic").
// Previews: allowPublicTraffic=false, so the port URL https://<port>-<id>.
// <domain> answers only with the e2b-traffic-access-token header — which only
// the server holds (stored encrypted on the run's sandbox row).
//
// UNVERIFIED-LIVE: proven against stubbed fetch only (no E2B key here).

import type { Sandbox, SandboxCreateOptions, SandboxExecOptions, SandboxExecResult, SandboxFileEntry, SandboxProvider } from "./types";
import { sandboxConfig, type SandboxConfig } from "./config";
import { OutputCollector } from "./output";
import { resolveSandboxPath } from "./paths";
import { listFilesViaExec, restoreViaExec, SandboxCommandError, snapshotViaExec } from "./exec-fs";
import { isValidPreviewPort, previewPath, type PreviewCapable, type PreviewUpstream } from "./preview";
import type { SecretCarrier } from "./secrets";

export const E2B_ENVD_PORT = 49983;
export const E2B_USER = "user";
export const E2B_WORKDIR = "/home/user/work";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class E2BError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "E2BError";
  }
}

/** One Connect envelope: flags(1) + length(4, BE) + JSON message. */
export function connectEnvelope(msg: unknown, flags = 0): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const h = Buffer.alloc(5);
  h[0] = flags;
  h.writeUInt32BE(body.length, 1);
  return Buffer.concat([h, body]);
}

/** Incremental Connect envelope reader. */
export class ConnectReader {
  private buf = Buffer.alloc(0);
  push(chunk: Uint8Array): Array<{ flags: number; msg: unknown }> {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    const out: Array<{ flags: number; msg: unknown }> = [];
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      const flags = this.buf[0]!;
      const raw = this.buf.subarray(5, 5 + len).toString("utf8");
      this.buf = this.buf.subarray(5 + len);
      let msg: unknown = null;
      try {
        msg = raw ? JSON.parse(raw) : {};
      } catch {
        msg = null;
      }
      out.push({ flags, msg });
    }
    return out;
  }
}

interface ProcessEvent {
  start?: { pid?: number };
  data?: { stdout?: string; stderr?: string; pty?: string };
  end?: { exitCode?: number; exited?: boolean; status?: string; error?: string };
  keepalive?: Record<string, never>;
}

interface Access {
  sandboxId: string;
  envdAccessToken: string | null;
  trafficAccessToken: string | null;
  domain: string;
}

export class E2BSandbox implements Sandbox, PreviewCapable, SecretCarrier {
  readonly provider = "e2b" as const;
  readonly workdir = E2B_WORKDIR;

  constructor(
    private readonly provider_: E2BSandboxProvider,
    private readonly access: Access,
    readonly runId: string,
  ) {}

  get id(): string {
    return this.access.sandboxId;
  }

  persistSecret(): string | null {
    return this.access.trafficAccessToken ? JSON.stringify({ traffic: this.access.trafficAccessToken }) : null;
  }

  private envdUrl(path: string): string {
    return `https://${E2B_ENVD_PORT}-${this.access.sandboxId}.${this.access.domain}${path}`;
  }

  private envdHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "E2b-Sandbox-Id": this.access.sandboxId,
      "E2b-Sandbox-Port": String(E2B_ENVD_PORT),
      Authorization: `Basic ${Buffer.from(`${E2B_USER}:`).toString("base64")}`,
      ...(this.access.envdAccessToken ? { "X-Access-Token": this.access.envdAccessToken } : {}),
      ...extra,
    };
  }

  private async kill(pid: number): Promise<void> {
    await this.provider_
      .fetch(this.envdUrl("/process.Process/SendSignal"), {
        method: "POST",
        headers: this.envdHeaders({ "content-type": "application/json", "connect-protocol-version": "1" }),
        body: JSON.stringify({ process: { pid }, signal: "SIGNAL_SIGKILL" }),
      })
      .catch(() => undefined);
  }

  async exec(cmd: string | string[], opts: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    const argv = typeof cmd === "string" ? ["/bin/sh", "-lc", cmd] : cmd;
    if (argv.length === 0) throw new SandboxCommandError("Empty command.");
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("Aborted");
    void this.provider_.touch(this.access.sandboxId);
    const started = Date.now();
    const cwd = resolveSandboxPath(this.workdir, opts.cwd ?? this.workdir);
    const ctl = new AbortController();
    let pid = 0;
    let timedOut = false;
    let aborted = false;
    const stop = (why: "timeout" | "abort") => {
      if (why === "timeout") timedOut = true;
      else aborted = true;
      if (pid) void this.kill(pid);
      setTimeout(() => ctl.abort(), 3000);
    };
    const timer = opts.timeoutMs ? setTimeout(() => stop("timeout"), opts.timeoutMs) : null;
    const onAbort = () => stop("abort");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const out = new OutputCollector(opts);
    let exitCode: number | null = null;
    try {
      const res = await this.provider_.fetch(this.envdUrl("/process.Process/Start"), {
        method: "POST",
        headers: this.envdHeaders({
          "content-type": "application/connect+json",
          "connect-protocol-version": "1",
          "Keepalive-Ping-Interval": "50",
        }),
        body: new Uint8Array(
          connectEnvelope({
            process: { cmd: argv[0], args: argv.slice(1), envs: opts.env ?? {}, cwd },
            stdin: false,
          }),
        ),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) throw new E2BError(res.status, `E2B process start failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const reader = new ConnectReader();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        for (const { flags, msg } of reader.push(chunk)) {
          if (flags & 0x02) {
            const err = (msg as { error?: { message?: string } } | null)?.error;
            if (err && exitCode === null && !timedOut && !aborted) throw new E2BError(0, `E2B process error: ${err.message ?? "unknown"}`);
            continue;
          }
          const ev = (msg as { event?: ProcessEvent } | null)?.event;
          if (!ev) continue;
          if (ev.start?.pid) pid = ev.start.pid;
          if (ev.data?.stdout) out.push("stdout", Buffer.from(ev.data.stdout, "base64"));
          if (ev.data?.stderr) out.push("stderr", Buffer.from(ev.data.stderr, "base64"));
          if (ev.end) exitCode = typeof ev.end.exitCode === "number" ? ev.end.exitCode : 0;
        }
      }
    } catch (err) {
      if (!timedOut && !aborted) throw err;
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    if (aborted) throw opts.signal?.reason ?? new Error("Aborted");
    return out.result(exitCode ?? (timedOut ? 124 : -1), timedOut, started);
  }

  async readFile(path: string): Promise<Buffer> {
    const abs = resolveSandboxPath(this.workdir, path);
    const res = await this.provider_.fetch(this.envdUrl(`/files?path=${encodeURIComponent(abs)}&username=${E2B_USER}`), {
      headers: this.envdHeaders(),
    });
    if (res.status === 404) throw new SandboxCommandError(`No such file: ${path}`);
    if (!res.ok) throw new E2BError(res.status, `E2B file read failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async writeFile(path: string, data: Buffer | string): Promise<void> {
    const abs = resolveSandboxPath(this.workdir, path);
    if (abs === this.workdir) throw new SandboxCommandError("Can't write over the workdir itself.");
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const res = await this.provider_.fetch(this.envdUrl(`/files?path=${encodeURIComponent(abs)}&username=${E2B_USER}`), {
      method: "POST",
      headers: this.envdHeaders({ "content-type": "application/octet-stream" }),
      body: new Uint8Array(buf),
    });
    if (!res.ok) throw new E2BError(res.status, `E2B file write failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }

  listFiles(dir: string, opts?: { recursive?: boolean; maxEntries?: number }): Promise<SandboxFileEntry[]> {
    return listFilesViaExec((c, o) => this.exec(c, o), this.workdir, dir, opts);
  }

  snapshot(label?: string) {
    return snapshotViaExec((c, o) => this.exec(c, o), this.workdir, label);
  }

  restore(snapshotId: string): Promise<void> {
    return restoreViaExec((c, o) => this.exec(c, o), this.workdir, snapshotId);
  }

  async exposePort(port: number): Promise<{ url: string }> {
    if (!isValidPreviewPort(port)) throw new SandboxCommandError("Pick a port between 1024 and 65535.");
    return { url: previewPath(this.runId, port) };
  }

  async previewUpstream(port: number): Promise<PreviewUpstream> {
    if (!isValidPreviewPort(port)) throw new SandboxCommandError("Invalid preview port.");
    if (!this.access.trafficAccessToken) throw new SandboxCommandError("This sandbox has no preview access token.");
    const host = `${port}-${this.access.sandboxId}.${this.access.domain}`;
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      origin: `https://${host}`,
      headers: { "e2b-traffic-access-token": this.access.trafficAccessToken },
      kind: "public",
      hostPattern: new RegExp(`^${esc(host)}$`),
    };
  }

  async destroy(): Promise<void> {
    await this.provider_.kill(this.access.sandboxId);
  }
}

export interface E2BProviderDeps {
  fetch?: FetchLike;
  config?: SandboxConfig;
}

export class E2BSandboxProvider implements SandboxProvider {
  readonly name = "e2b" as const;
  private readonly cfg: SandboxConfig;
  readonly fetch: FetchLike;

  constructor(deps: E2BProviderDeps = {}) {
    this.cfg = deps.config ?? sandboxConfig();
    this.fetch = deps.fetch ?? ((u, i) => fetch(u, i));
  }

  private api(path: string): string {
    return `https://api.${this.cfg.e2b.domain}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "X-API-Key": this.cfg.e2b.apiKey ?? "", ...extra };
  }

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.cfg.e2b.apiKey) return { ok: false, reason: "SANDBOX_PROVIDER=e2b needs E2B_API_KEY." };
    try {
      const res = await this.fetch(this.api("/sandboxes"), { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: "E2B rejected E2B_API_KEY." };
      if (!res.ok) return { ok: false, reason: `E2B answered ${res.status}.` };
      return { ok: true };
    } catch {
      return { ok: false, reason: `Couldn't reach api.${this.cfg.e2b.domain}.` };
    }
  }

  async create(opts: SandboxCreateOptions): Promise<Sandbox> {
    if (!this.cfg.e2b.apiKey) throw new SandboxCommandError("E2B_API_KEY is not set.");
    const res = await this.fetch(this.api("/v2/sandboxes"), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        templateID: opts.image ?? this.cfg.e2b.template,
        timeout: this.cfg.idleSeconds,
        autoPause: false,
        allow_internet_access: true,
        metadata: { app: "shapesos", workspaceId: opts.workspaceId, runId: opts.runId },
        network: {
          allowPublicTraffic: false,
          allowOut: opts.egressAllow?.length ? opts.egressAllow : this.cfg.egressAllow,
          denyOut: ["0.0.0.0/0"],
        },
      }),
    });
    if (!res.ok) throw new E2BError(res.status, `E2B create failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const sb = (await res.json()) as { sandboxID: string; envdAccessToken?: string; trafficAccessToken?: string | null; domain?: string | null };
    const s = new E2BSandbox(
      this,
      {
        sandboxId: sb.sandboxID,
        envdAccessToken: sb.envdAccessToken ?? null,
        trafficAccessToken: sb.trafficAccessToken ?? null,
        domain: sb.domain || this.cfg.e2b.domain,
      },
      opts.runId,
    );
    const mk = await s.exec(["mkdir", "-p", E2B_WORKDIR], { timeoutMs: 30_000 }).catch(async (e) => {
      await this.kill(sb.sandboxID);
      throw e;
    });
    if (mk.exitCode !== 0) {
      await this.kill(sb.sandboxID);
      throw new SandboxCommandError(`Couldn't create the workdir: ${mk.stderr.trim()}`);
    }
    return s;
  }

  get(id: string): Promise<Sandbox | null> {
    return this.getWithSecret(id, null);
  }

  async getWithSecret(id: string, secret: string | null): Promise<Sandbox | null> {
    if (!/^[a-z0-9-]{4,64}$/i.test(id) || !this.cfg.e2b.apiKey) return null;
    const res = await this.fetch(this.api(`/sandboxes/${encodeURIComponent(id)}`), { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new E2BError(res.status, `E2B lookup failed (${res.status})`);
    const d = (await res.json()) as {
      sandboxID: string;
      state?: string;
      envdAccessToken?: string;
      domain?: string | null;
      metadata?: Record<string, string>;
    };
    if (d.state && d.state !== "running") return null;
    let traffic: string | null = null;
    try {
      traffic = secret ? ((JSON.parse(secret) as { traffic?: string }).traffic ?? null) : null;
    } catch {
      traffic = null;
    }
    return new E2BSandbox(
      this,
      { sandboxId: d.sandboxID, envdAccessToken: d.envdAccessToken ?? null, trafficAccessToken: traffic, domain: d.domain || this.cfg.e2b.domain },
      d.metadata?.runId ?? "",
    );
  }

  /** Reset the idle timer (E2B kills the sandbox `timeout` seconds after the last reset). */
  async touch(id: string): Promise<void> {
    await this.fetch(this.api(`/sandboxes/${encodeURIComponent(id)}/timeout`), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ timeout: this.cfg.idleSeconds }),
    }).catch(() => undefined);
  }

  async kill(id: string): Promise<void> {
    const res = await this.fetch(this.api(`/sandboxes/${encodeURIComponent(id)}`), { method: "DELETE", headers: this.headers() }).catch(() => null);
    if (res && !res.ok && res.status !== 404) throw new E2BError(res.status, `E2B delete failed (${res.status})`);
  }
}
