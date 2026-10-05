// ShapesOS — Phase 8: Daytona sandboxes, over HTTP.
//
// Enabled by SANDBOX_PROVIDER=daytona + DAYTONA_API_KEY. Written against
// Daytona's published OpenAPI documents (daytona.io/docs/openapi.json and
// /docs/toolbox-openapi.json, read 2026-10-04), without the SDK:
//
//   platform API  DAYTONA_API_URL (default https://app.daytona.io/api),
//                 Authorization: Bearer <key>
//     POST   /sandbox          {labels, env, public:false, cpu, memory(GB),
//                               disk(GB), autoStopInterval(min),
//                               autoDeleteInterval:0, domainAllowList, snapshot?}
//     GET    /sandbox/{id}     state ("started" …), toolboxProxyUrl, labels
//     GET    /sandbox/{id}/ports/{port}/preview-url → {url, token}
//     DELETE /sandbox/{id}
//   toolbox API   {toolboxProxyUrl}/{id}  (default https://proxy.app.daytona.io/toolbox)
//     POST /process/execute    {command, cwd, envs, timeout(s)} → {exitCode, result}
//     GET  /files/download?path=      POST /files/upload-v2?path= (multipart "file")
//
// Egress: domainAllowList (Daytona enforces it at the network layer).
// Idle: autoStopInterval = SANDBOX_IDLE_MINUTES and autoDeleteInterval = 0
// ("delete immediately upon stopping"). Previews: public=false, so the port
// URL needs the x-daytona-preview-token header — fetched server-side.
// /process/execute is not streaming: output arrives (combined stdout+stderr)
// when the command ends and is reported as stdout.
//
// UNVERIFIED-LIVE: proven against stubbed fetch only (no Daytona key here).

import type { Sandbox, SandboxCreateOptions, SandboxExecOptions, SandboxExecResult, SandboxFileEntry, SandboxProvider } from "./types";
import { sandboxConfig, type SandboxConfig } from "./config";
import { OutputCollector } from "./output";
import { resolveSandboxPath, shq } from "./paths";
import { listFilesViaExec, restoreViaExec, SandboxCommandError, snapshotViaExec } from "./exec-fs";
import { isValidPreviewPort, previewPath, type PreviewCapable, type PreviewUpstream } from "./preview";
import type { FetchLike } from "./e2b";

export const DAYTONA_WORKDIR = "/home/daytona/work";
const DEFAULT_TOOLBOX = "https://proxy.app.daytona.io/toolbox";

export class DaytonaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DaytonaError";
  }
}

interface DaytonaSandboxDto {
  id: string;
  state?: string;
  toolboxProxyUrl?: string;
  labels?: Record<string, string>;
}

export class DaytonaSandbox implements Sandbox, PreviewCapable {
  readonly provider = "daytona" as const;
  readonly workdir = DAYTONA_WORKDIR;

  constructor(
    private readonly p: DaytonaSandboxProvider,
    readonly id: string,
    private readonly toolboxBase: string,
    readonly runId: string,
  ) {}

  private tb(path: string): string {
    return `${this.toolboxBase.replace(/\/+$/, "")}/${encodeURIComponent(this.id)}${path}`;
  }

  async exec(cmd: string | string[], opts: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    const argv = typeof cmd === "string" ? ["/bin/sh", "-lc", cmd] : cmd;
    if (argv.length === 0) throw new SandboxCommandError("Empty command.");
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("Aborted");
    const started = Date.now();
    const cwd = resolveSandboxPath(this.workdir, opts.cwd ?? this.workdir);
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const out = new OutputCollector(opts);
    try {
      const res = await this.p.fetch(this.tb("/process/execute"), {
        method: "POST",
        headers: this.p.headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          command: argv.map(shq).join(" "),
          cwd,
          envs: opts.env ?? {},
          timeout: opts.timeoutMs ? Math.max(1, Math.ceil(opts.timeoutMs / 1000)) : 0,
        }),
        signal: ctl.signal,
      });
      if (res.status === 408) return out.result(124, true, started);
      if (!res.ok) throw new DaytonaError(res.status, `Daytona execute failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
      const r = (await res.json()) as { exitCode?: number; result?: string };
      if (r.result) out.push("stdout", r.result);
      return out.result(typeof r.exitCode === "number" ? r.exitCode : -1, false, started);
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      throw err;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  async readFile(path: string): Promise<Buffer> {
    const abs = resolveSandboxPath(this.workdir, path);
    const res = await this.p.fetch(this.tb(`/files/download?path=${encodeURIComponent(abs)}`), { headers: this.p.headers() });
    if (res.status === 404) throw new SandboxCommandError(`No such file: ${path}`);
    if (!res.ok) throw new DaytonaError(res.status, `Daytona file read failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async writeFile(path: string, data: Buffer | string): Promise<void> {
    const abs = resolveSandboxPath(this.workdir, path);
    if (abs === this.workdir) throw new SandboxCommandError("Can't write over the workdir itself.");
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buf)]), abs.split("/").pop() || "file");
    const res = await this.p.fetch(this.tb(`/files/upload-v2?path=${encodeURIComponent(abs)}`), {
      method: "POST",
      headers: this.p.headers(),
      body: form,
    });
    if (!res.ok) throw new DaytonaError(res.status, `Daytona file write failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
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
    const res = await this.p.fetch(this.p.api(`/sandbox/${encodeURIComponent(this.id)}/ports/${port}/preview-url`), { headers: this.p.headers() });
    if (!res.ok) throw new DaytonaError(res.status, `Daytona preview link failed (${res.status})`);
    const r = (await res.json()) as { url?: string; token?: string };
    let u: URL;
    try {
      u = new URL(r.url ?? "");
    } catch {
      throw new SandboxCommandError("Daytona returned no preview URL.");
    }
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      origin: u.origin,
      headers: r.token ? { "x-daytona-preview-token": r.token } : {},
      kind: "public",
      // The documented shape: https://{port}-{sandboxId}.{proxyDomain}
      hostPattern: new RegExp(`^${port}-${esc(this.id.toLowerCase())}\\.[a-z0-9.-]+$`),
    };
  }

  async destroy(): Promise<void> {
    await this.p.remove(this.id);
  }
}

export interface DaytonaProviderDeps {
  fetch?: FetchLike;
  config?: SandboxConfig;
  /** Poll interval while a new sandbox starts (tests set it low). */
  pollMs?: number;
}

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = "daytona" as const;
  private readonly cfg: SandboxConfig;
  readonly fetch: FetchLike;
  private readonly pollMs: number;

  constructor(deps: DaytonaProviderDeps = {}) {
    this.cfg = deps.config ?? sandboxConfig();
    this.fetch = deps.fetch ?? ((u, i) => fetch(u, i));
    this.pollMs = deps.pollMs ?? 1000;
  }

  api(path: string): string {
    return `${this.cfg.daytona.apiUrl}${path}`;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.daytona.apiKey ?? ""}`, ...extra };
  }

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.cfg.daytona.apiKey) return { ok: false, reason: "SANDBOX_PROVIDER=daytona needs DAYTONA_API_KEY." };
    try {
      const res = await this.fetch(this.api("/sandbox"), { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: "Daytona rejected DAYTONA_API_KEY." };
      if (!res.ok) return { ok: false, reason: `Daytona answered ${res.status}.` };
      return { ok: true };
    } catch {
      return { ok: false, reason: `Couldn't reach ${this.cfg.daytona.apiUrl}.` };
    }
  }

  private wrap(d: DaytonaSandboxDto, runId: string): DaytonaSandbox {
    return new DaytonaSandbox(this, d.id, d.toolboxProxyUrl || DEFAULT_TOOLBOX, runId);
  }

  async create(opts: SandboxCreateOptions): Promise<Sandbox> {
    if (!this.cfg.daytona.apiKey) throw new SandboxCommandError("DAYTONA_API_KEY is not set.");
    const r = { ...this.cfg.resources, ...(opts.resources ?? {}) };
    const res = await this.fetch(this.api("/sandbox"), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        ...(opts.image ?? this.cfg.daytona.snapshot ? { snapshot: opts.image ?? this.cfg.daytona.snapshot } : {}),
        labels: { app: "shapesos", "shapes.workspace": opts.workspaceId, "shapes.run": opts.runId },
        env: { SHAPES_SANDBOX: "1" },
        public: false,
        cpu: Math.max(1, Math.round(r.cpus ?? 2)),
        memory: Math.max(1, Math.round((r.memoryMb ?? 2048) / 1024)),
        ...(r.diskMb ? { disk: Math.max(1, Math.round(r.diskMb / 1024)) } : {}),
        autoStopInterval: Math.max(1, Math.round(this.cfg.idleSeconds / 60)),
        autoDeleteInterval: 0,
        domainAllowList: (opts.egressAllow?.length ? opts.egressAllow : this.cfg.egressAllow).join(","),
      }),
    });
    if (!res.ok) throw new DaytonaError(res.status, `Daytona create failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
    let d = (await res.json()) as DaytonaSandboxDto;
    // Wait for it to start (bounded).
    const deadline = Date.now() + 120_000;
    while (d.state !== "started") {
      if (d.state === "error" || d.state === "build_failed" || Date.now() > deadline) {
        await this.remove(d.id).catch(() => undefined);
        throw new SandboxCommandError(`Daytona sandbox did not start (state ${d.state ?? "unknown"}).`);
      }
      await new Promise((ok) => setTimeout(ok, this.pollMs));
      const g = await this.fetch(this.api(`/sandbox/${encodeURIComponent(d.id)}`), { headers: this.headers() });
      if (!g.ok) throw new DaytonaError(g.status, `Daytona lookup failed (${g.status})`);
      d = (await g.json()) as DaytonaSandboxDto;
    }
    const s = this.wrap(d, opts.runId);
    const mk = await s.exec(["mkdir", "-p", DAYTONA_WORKDIR], { timeoutMs: 30_000 }).catch(async (e) => {
      await this.remove(d.id).catch(() => undefined);
      throw e;
    });
    if (mk.exitCode !== 0) {
      await this.remove(d.id).catch(() => undefined);
      throw new SandboxCommandError(`Couldn't create the workdir: ${mk.stdout.trim()}`);
    }
    return s;
  }

  async get(id: string): Promise<Sandbox | null> {
    if (!/^[A-Za-z0-9-]{4,80}$/.test(id) || !this.cfg.daytona.apiKey) return null;
    const res = await this.fetch(this.api(`/sandbox/${encodeURIComponent(id)}`), { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new DaytonaError(res.status, `Daytona lookup failed (${res.status})`);
    const d = (await res.json()) as DaytonaSandboxDto;
    if (d.state !== "started") return null;
    return this.wrap(d, d.labels?.["shapes.run"] ?? "");
  }

  async remove(id: string): Promise<void> {
    const res = await this.fetch(this.api(`/sandbox/${encodeURIComponent(id)}`), { method: "DELETE", headers: this.headers() }).catch(() => null);
    if (res && !res.ok && res.status !== 404) throw new DaytonaError(res.status, `Daytona delete failed (${res.status})`);
  }
}
