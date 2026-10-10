// ShapesOS — Phase 4b live connector HTTP layer.
//
// One request helper for every live-wired provider adapter (GA4, Search
// Console, Google Ads, Meta Ads, Drive, Notion, Business Profile, outreach
// sending partners). It owns the cross-cutting rules so each adapter only
// describes endpoints:
//
//   - Bearer auth from the vault credential; on 401 (or a provider's
//     "invalid token" body) it calls the injected refresher ONCE, then
//     retries with the new token. A failed refresh is auth_rejected.
//   - 429 / 5xx / provider rate-limit bodies are retried with exponential
//     backoff (base 500ms, doubling, jitter), honouring Retry-After (capped
//     at 60s). Network failures retry on the same schedule.
//   - Every failure becomes a ConnectorApiError with a CLOSED code; the
//     message is the provider's own short message, truncated and scrubbed
//     of token-shaped text. Tokens never appear in errors or logs.
//
// Provider hosts are fixed constants in each adapter (never user input),
// but every call still goes through safeFetch (lib/connectors/safe-fetch.ts)
// like the rest of the connector layer: the resolved address is checked
// (no private/metadata ranges), redirects are followed manually and
// re-validated per hop, and a cross-origin hop drops Authorization so a
// provider redirect can never carry the bearer token elsewhere.
// fetchImpl, resolve and sleep are injectable so tests run against fixtures.

import type { DecryptedCredential, InvokeContext, InvokeResult } from "../types";
import { safeFetch } from "@/lib/connectors/safe-fetch";
import type { ResolveFn } from "@/lib/safe-url";

/** Closed set of live connector error codes. */
export type ConnectorErrorCode =
  | "not_connected"
  | "config_missing"
  | "auth_rejected"
  | "forbidden"
  | "not_found"
  | "bad_request"
  | "rate_limited"
  | "provider_error"
  | "provider_unreachable";

export class ConnectorApiError extends Error {
  readonly code: ConnectorErrorCode;
  readonly provider: string;
  readonly status?: number;
  constructor(provider: string, code: ConnectorErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ConnectorApiError";
    this.provider = provider;
    this.code = code;
    this.status = status;
  }
}

export interface LiveDeps {
  fetchImpl?: typeof fetch;
  /** DNS resolver for safeFetch's address check (tests inject a fake). */
  resolve?: ResolveFn;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt for 429/5xx/network (default 4). */
  maxRetries?: number;
  /** Backoff base in ms (default 500). */
  baseDelayMs?: number;
}

/** Bearer token plus an optional one-shot refresher. */
export interface TokenSource {
  token: string;
  refresh?: () => Promise<string | null>;
}

/** What a provider classifier says about a non-2xx response. */
export interface Classification {
  code: ConnectorErrorCode;
  retryable: boolean;
  /** The token is invalid/expired: refresh once and retry. */
  authExpired?: boolean;
  message?: string;
}

export type Classifier = (status: number, body: unknown) => Classification;

const MAX_RETRY_AFTER_MS = 60_000;
const MAX_MESSAGE = 300;

const TOKENISH: RegExp[] = [
  /bearer\s+[A-Za-z0-9\-._~+/=]+/gi,
  /ya29\.[A-Za-z0-9\-._~+/=]+/g,
  /(access_token|refresh_token|api_key|client_secret)=([^&\s"']+)/gi,
  /secret_[A-Za-z0-9]{10,}/g,
  /ntn_[A-Za-z0-9]{10,}/g,
  /EAA[A-Za-z0-9]{20,}/g,
];

/**
 * Truncate + scrub a provider message so it is safe to surface. `secrets`
 * are literal values this request carried (bearer tokens, developer tokens)
 * that are redacted even when they don't look token-shaped.
 */
export function scrubMessage(msg: string, secrets: Array<string | null | undefined> = []): string {
  let out = msg.slice(0, MAX_MESSAGE * 2);
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  for (const re of TOKENISH) out = out.replace(re, "[redacted]");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Pull a human message out of the common provider error envelopes. */
export function providerMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" ? body : undefined;
  const b = body as Record<string, unknown>;
  const err = b.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    return str(e.message) ?? str(e.error_user_msg) ?? str(e.status);
  }
  return str(b.message) ?? str(err) ?? str(b.error_description);
}

/** Google-style reasons that mean "slow down" even on a 403. */
const GOOGLE_RATE_REASONS = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED|dailyLimitExceeded/i;

/** Default classifier: Google APIs, Notion, and generic REST. */
export function defaultClassify(status: number, body: unknown): Classification {
  const message = providerMessage(body);
  const raw = JSON.stringify(body ?? "").slice(0, 2000);
  if (status === 401) return { code: "auth_rejected", retryable: false, authExpired: true, message };
  if (status === 429) return { code: "rate_limited", retryable: true, message };
  if (status === 403) {
    if (GOOGLE_RATE_REASONS.test(raw)) return { code: "rate_limited", retryable: true, message };
    return { code: "forbidden", retryable: false, message };
  }
  if (status === 404) return { code: "not_found", retryable: false, message };
  if (status === 400 || status === 409 || status === 422) {
    return { code: "bad_request", retryable: false, message };
  }
  if (status === 402) return { code: "forbidden", retryable: false, message };
  if (status >= 500) return { code: "provider_error", retryable: status !== 501, message };
  return { code: "provider_error", retryable: false, message };
}

function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
  return null;
}

/** Exponential backoff with up to 25% jitter. */
export function backoffMs(attempt: number, base: number): number {
  const exp = base * 2 ** attempt;
  return Math.min(exp + Math.floor(Math.random() * (exp / 4)), MAX_RETRY_AFTER_MS);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LiveRequest {
  provider: string;
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  /** JSON body (serialized with Content-Type: application/json). */
  json?: unknown;
  /** Phase 21B: a raw body (file bytes, multipart/related) with its Content-Type. Not retried across a token refresh differently from JSON. */
  rawBody?: Uint8Array;
  contentType?: string;
  /** Auth: bearer token source. Omit for providers that authenticate in the URL. */
  auth?: TokenSource;
  /** "json" (default), "text" (Drive export / media) or "buffer" (Phase 21B: file bytes). */
  responseType?: "json" | "text" | "buffer";
  classify?: Classifier;
  /** Max response bytes for text responses (default 2 MB). */
  maxTextBytes?: number;
}

/** Header values that are credentials (developer-token, api keys, proofs). */
function secretHeaderValues(headers: Record<string, string> | undefined): string[] {
  return Object.entries(headers ?? {})
    .filter(([k]) => /token|secret|key|proof|authorization/i.test(k))
    .map(([, v]) => v);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Perform one provider call with refresh-on-401 and 429/5xx backoff.
 * Resolves with the parsed JSON (or text); throws ConnectorApiError.
 */
export async function liveRequest<T = unknown>(req: LiveRequest, deps: LiveDeps = {}): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const maxRetries = deps.maxRetries ?? 4;
  const base = deps.baseDelayMs ?? 500;
  const classify = req.classify ?? defaultClassify;

  const url = new URL(req.url);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  let token = req.auth?.token ?? null;
  let refreshed = false;
  let attempt = 0;

  for (;;) {
    const headers: Record<string, string> = {
      Accept: req.responseType === "text" || req.responseType === "buffer" ? "*/*" : "application/json",
      ...(req.headers ?? {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: string | Uint8Array | undefined;
    if (req.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.json);
    } else if (req.rawBody !== undefined) {
      headers["Content-Type"] = req.contentType ?? "application/octet-stream";
      body = req.rawBody;
    }

    let res: Response;
    try {
      res = await safeFetch(
        url.toString(),
        { method: req.method ?? "GET", headers, body },
        { fetchFn: fetchImpl, resolve: deps.resolve },
      );
    } catch {
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt, base));
        attempt += 1;
        continue;
      }
      throw new ConnectorApiError(req.provider, "provider_unreachable", `${req.provider} could not be reached.`);
    }

    if (res.ok) {
      if (res.status === 204) return null as T;
      if (req.responseType === "buffer") return Buffer.from(await res.arrayBuffer()) as T;
      if (req.responseType === "text") {
        const text = await res.text();
        const cap = req.maxTextBytes ?? 2_000_000;
        return (text.length > cap ? text.slice(0, cap) : text) as T;
      }
      return (await readBody(res)) as T;
    }

    const parsed = await readBody(res);
    const c = classify(res.status, parsed);
    if (c.authExpired && req.auth?.refresh && !refreshed) {
      refreshed = true;
      const next = await req.auth.refresh().catch(() => null);
      if (next) {
        token = next;
        continue;
      }
      throw new ConnectorApiError(
        req.provider,
        "auth_rejected",
        `${req.provider} rejected the stored token and it could not be refreshed — reconnect the integration.`,
        res.status,
      );
    }
    if (c.retryable && attempt < maxRetries) {
      const wait = parseRetryAfter(res.headers.get("retry-after")) ?? backoffMs(attempt, base);
      await sleep(wait);
      attempt += 1;
      continue;
    }
    const secrets = [req.auth?.token, token, ...secretHeaderValues(req.headers)];
    const detail = c.message ? `: ${scrubMessage(c.message, secrets)}` : "";
    throw new ConnectorApiError(req.provider, c.code, `${req.provider} request failed (HTTP ${res.status})${detail}`, res.status);
  }
}

/** Token source from a vault credential + invoke context (null → mock mode). */
export function tokenSourceFrom(
  credential: DecryptedCredential | null,
  ctx?: Pick<InvokeContext, "refreshCredential">,
): TokenSource | null {
  const token = credential?.payload?.access_token;
  if (typeof token !== "string" || !token) return null;
  const refresher = ctx?.refreshCredential;
  return {
    token,
    refresh: refresher
      ? async () => {
          const next = await refresher();
          const t = next?.payload?.access_token;
          return typeof t === "string" && t ? t : null;
        }
      : undefined,
  };
}

/** Map any thrown error into the uniform failure envelope. */
export function liveFailure(err: unknown, provider: string): InvokeResult {
  if (err instanceof ConnectorApiError) {
    return { ok: false, error: err.message, errorCode: err.code, mock: false };
  }
  const msg = err instanceof Error ? scrubMessage(err.message) : "unexpected error";
  return { ok: false, error: `${provider}: ${msg}`, errorCode: "provider_error", mock: false };
}

/** Clamp a numeric arg into [min, max] with a default. */
export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.max(n, min), max);
}

/** Strict YYYY-MM-DD (GA4/GSC also accept relative forms handled by callers). */
export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}
