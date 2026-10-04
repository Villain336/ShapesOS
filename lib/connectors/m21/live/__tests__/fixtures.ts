// Shared fixture helpers for the Phase 4b live-adapter tests: a scripted
// fetch that records every request and replays canned provider responses.
// No network, no real keys.

import type { DecryptedCredential, InvokeContext } from "../../types";

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Scripted = Response | Error | ((req: RecordedRequest) => Response);

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

/** Scripted fetch: each call consumes the next scripted response. */
export function scriptedFetch(script: Scripted[]) {
  const calls: RecordedRequest[] = [];
  const queue = [...script];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    const h = new Headers(init?.headers);
    h.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    let body: unknown = init?.body ?? null;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep text */
      }
    } else if (body instanceof URLSearchParams) {
      body = Object.fromEntries(body.entries());
    }
    const req: RecordedRequest = { url, method: (init?.method ?? "GET").toUpperCase(), headers, body };
    calls.push(req);
    const next = queue.shift();
    if (!next) throw new Error(`scriptedFetch: unexpected request ${req.method} ${url.href}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(req) : next;
  }) as typeof fetch;
  return { fetchImpl, calls, remaining: () => queue.length };
}

/** Fake DNS for safeFetch's address check: every provider host is public. */
export const publicResolve = async (_host: string) => ["142.250.80.10"];

/** Deps with an instant, recorded sleep and fake public DNS. */
export function liveDeps(fetchImpl: typeof fetch) {
  const sleeps: number[] = [];
  return {
    deps: {
      fetchImpl,
      resolve: publicResolve,
      sleep: async (ms: number) => void sleeps.push(ms),
      baseDelayMs: 100,
    },
    sleeps,
  };
}

export function oauthCred(token = "tok-1", extra: Record<string, unknown> = {}): DecryptedCredential {
  return { kind: "oauth2", payload: { access_token: token, refresh_token: "r-1", ...extra } };
}

export function ctxWith(
  overrides: Partial<InvokeContext> = {},
): InvokeContext & { refreshCalls: () => number } {
  let n = 0;
  const base: InvokeContext = { workspaceId: "ws-1", userId: "u-1", ...overrides };
  const refresher = overrides.refreshCredential;
  return {
    ...base,
    refreshCredential: refresher
      ? async () => {
          n += 1;
          return refresher();
        }
      : undefined,
    refreshCalls: () => n,
  };
}

/** Context whose refresher hands back a fresh token "tok-2". */
export function refreshingCtx(overrides: Partial<InvokeContext> = {}) {
  return ctxWith({ ...overrides, refreshCredential: async () => oauthCred("tok-2") });
}
