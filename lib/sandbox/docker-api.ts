// ShapesOS — Phase 8: a minimal Docker Engine API client over the unix socket.
//
// node:http with `socketPath` — no dependency. (undici resolves from app
// code today, but only as a transitive dependency pinned by an `overrides`
// entry for payload; importing it would be a phantom dependency that a
// future install could drop. node:http does everything we need, including
// the hijacked exec stream, which Docker writes as a plain read-until-close
// body when the request does not ask for a protocol upgrade.)
//
// Only the endpoints the sandbox uses are wrapped. The API version is pinned
// (v1.41 = Docker Engine 20.10+) so a newer daemon keeps answering in the
// shape this code was written against.

import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Readable } from "node:stream";

export const DOCKER_API_VERSION = "v1.41";

export class DockerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DockerApiError";
  }
}

export interface DockerRequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Raw body (tar upload); sent as application/x-tar. */
  raw?: Buffer;
  /** Streamed raw body (a checkpoint tar), sent chunked as application/x-tar. */
  rawStream?: Readable;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function buildPath(path: string, query?: DockerRequestOptions["query"]): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
  const q = qs.toString();
  return `/${DOCKER_API_VERSION}${path}${q ? `?${q}` : ""}`;
}

export class DockerClient {
  constructor(readonly socketPath: string) {}

  /** Open a request and hand back the response stream (caller consumes it). */
  stream(method: string, path: string, opts: DockerRequestOptions = {}): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const payload = opts.raw ?? (opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body)));
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          method,
          path: buildPath(path, opts.query),
          headers: {
            host: "docker",
            ...(payload
              ? { "content-type": opts.raw ? "application/x-tar" : "application/json", "content-length": payload.length }
              : opts.rawStream
                ? { "content-type": "application/x-tar", "transfer-encoding": "chunked" }
                : {}),
          },
          signal: opts.signal,
        },
        resolve,
      );
      req.on("error", reject);
      if (opts.timeoutMs) {
        req.setTimeout(opts.timeoutMs, () => req.destroy(new DockerApiError(0, `Docker API ${method} ${path} timed out`)));
      }
      if (opts.rawStream) {
        opts.rawStream.on("error", (e) => req.destroy(e));
        opts.rawStream.pipe(req);
        return;
      }
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Full request: returns status + body; throws DockerApiError on >= 400 unless `allow` lists it. */
  async call(
    method: string,
    path: string,
    opts: DockerRequestOptions & { allow?: number[]; maxBytes?: number } = {},
  ): Promise<{ status: number; body: Buffer; headers: IncomingMessage["headers"] }> {
    const res = await this.stream(method, path, opts);
    const chunks: Buffer[] = [];
    let size = 0;
    const max = opts.maxBytes ?? 64 * 1024 * 1024;
    for await (const c of res) {
      size += (c as Buffer).length;
      if (size > max) {
        res.destroy();
        throw new DockerApiError(0, `Docker API ${method} ${path}: response over ${max} bytes`);
      }
      chunks.push(c as Buffer);
    }
    const body = Buffer.concat(chunks);
    const status = res.statusCode ?? 0;
    if (status >= 400 && !(opts.allow ?? []).includes(status)) {
      let msg = body.toString("utf8").slice(0, 500);
      try {
        msg = (JSON.parse(msg) as { message?: string }).message ?? msg;
      } catch {
        /* not JSON */
      }
      throw new DockerApiError(status, `Docker API ${method} ${path} → ${status}: ${msg}`);
    }
    return { status, body, headers: res.headers };
  }

  async json<T = unknown>(method: string, path: string, opts: DockerRequestOptions & { allow?: number[] } = {}): Promise<{ status: number; data: T | null }> {
    const { status, body } = await this.call(method, path, opts);
    if (!body.length) return { status, data: null };
    try {
      return { status, data: JSON.parse(body.toString("utf8")) as T };
    } catch {
      return { status, data: null };
    }
  }

  /** GET /_ping — true when the daemon answers OK. */
  async ping(timeoutMs = 2000): Promise<boolean> {
    try {
      const { status, body } = await this.call("GET", "/_ping", { timeoutMs });
      return status === 200 && body.toString("utf8").trim() === "OK";
    } catch {
      return false;
    }
  }
}
