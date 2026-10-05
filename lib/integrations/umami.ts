// Marketr — Phase 12 "embeds": Umami analytics (MIT, cookieless).
// BYO sidecar pattern: UMAMI_URL + UMAMI_API_KEY (server) and
// UMAMI_WEBSITE_ID + UMAMI_SCRIPT_URL (browser snippet) live on the host
// environment and are never exposed to the browser except the two public
// snippet values. No config → loud honest empty states, never fake stats.
//
// Umami API notes (v2, verified 2026):
// - GET {UMAMI_URL}/api/websites/{websiteId}/stats?startAt&endAt → pageviews, visitors, visits, bounces, totaltime
// - GET {UMAMI_URL}/api/websites/{websiteId}/pageviews → time-series buckets
// - Auth: `Authorization: Bearer <api-key>` header.

import { sidecarEnv } from "./sidecar-tenancy";
export const UMAMI_API_BASE_ENV = "UMAMI_URL";
export const UMAMI_API_KEY_ENV = "UMAMI_API_KEY";
export const UMAMI_WEBSITE_ID_ENV = "UMAMI_WEBSITE_ID";
export const UMAMI_SCRIPT_URL_ENV = "UMAMI_SCRIPT_URL";

export interface UmamiStatus {
  /** Server-side stats API is usable (URL + API key present). */
  statsConfigured: boolean;
  /** Browser tracking snippet is usable (website id + script URL present). */
  snippetConfigured: boolean;
  name: string;
}

export function umamiStatus(env: Record<string, string | undefined> = sidecarEnv("umami")): UmamiStatus {
  const statsConfigured = !!(env[UMAMI_API_BASE_ENV] && env[UMAMI_API_KEY_ENV]);
  const snippetConfigured = !!(
    env[UMAMI_WEBSITE_ID_ENV] && env[UMAMI_SCRIPT_URL_ENV]
  );
  return {
    statsConfigured,
    snippetConfigured,
    name: statsConfigured || snippetConfigured ? "umami" : "umami (not configured)",
  };
}

/** Public snippet values only — safe to serialize to the client. */
export function umamiSnippetConfig(env: Record<string, string | undefined> = sidecarEnv("umami")): {
  websiteId: string;
  scriptUrl: string;
} | null {
  const websiteId = env[UMAMI_WEBSITE_ID_ENV];
  const scriptUrl = env[UMAMI_SCRIPT_URL_ENV];
  if (!websiteId || !scriptUrl) return null;
  return { websiteId, scriptUrl };
}

export interface UmamiStats {
  pageviews: number;
  visitors: number;
  visits: number;
  bounces: number;
  totaltime: number;
}

export interface UmamiPageviewBucket {
  /** Unix ms. */
  t: number;
  /** ISO date bucket label. */
  x: string;
  /** Pageviews in the bucket. */
  y: number;
}

export class UmamiApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "UmamiApiError";
  }
}

type FetchImpl = typeof fetch;

function apiBase(env: Record<string, string | undefined>): string {
  const base = env[UMAMI_API_BASE_ENV];
  if (!base) throw new UmamiApiError(0, "Umami is not configured (UMAMI_URL).");
  return base.replace(/\/+$/, "");
}

function apiKey(env: Record<string, string | undefined>): string {
  const key = env[UMAMI_API_KEY_ENV];
  if (!key) throw new UmamiApiError(0, "Umami is not configured (UMAMI_API_KEY).");
  return key;
}

function websiteId(env: Record<string, string | undefined>): string {
  const id = env[UMAMI_WEBSITE_ID_ENV];
  if (!id) throw new UmamiApiError(0, "Umami is not configured (UMAMI_WEBSITE_ID).");
  return id;
}

/** Normalize the /stats payload; Umami numbers may arrive as strings. */
export function normalizeStats(raw: unknown): UmamiStats {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  return {
    pageviews: num(r["pageviews"]),
    visitors: num(r["visitors"]),
    visits: num(r["visits"]),
    bounces: num(r["bounces"]),
    totaltime: num(r["totaltime"]),
  };
}

/** Normalize the /pageviews time-series payload. */
export function normalizePageviews(raw: unknown): UmamiPageviewBucket[] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(r["pageviews"]) ? r["pageviews"] : [];
  return rows
    .map((row) => {
      const b = row as Record<string, unknown>;
      const t = typeof b["t"] === "number" ? b["t"] : Number(b["t"]);
      const y = typeof b["y"] === "number" ? b["y"] : Number(b["y"]);
      return {
        t: Number.isFinite(t) ? t : 0,
        x: typeof b["x"] === "string" ? b["x"] : "",
        y: Number.isFinite(y) ? y : 0,
      };
    })
    .filter((b) => b.x !== "");
}

/**
 * Server-side: aggregate stats for a date range. `fetchImpl` is injectable
 * for tests; production passes the global fetch. Never logs the API key.
 */
export async function fetchUmamiStats(
  startAt: number,
  endAt: number,
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = sidecarEnv("umami"),
): Promise<UmamiStats> {
  const url =
    `${apiBase(env)}/api/websites/${websiteId(env)}/stats` +
    `?startAt=${startAt}&endAt=${endAt}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey(env)}` },
    });
  } catch {
    throw new UmamiApiError(0, "Could not reach the Umami sidecar.");
  }
  if (!res.ok) {
    throw new UmamiApiError(res.status, `Umami request failed with HTTP ${res.status}.`);
  }
  return normalizeStats(await res.json());
}

/**
 * Server-side: pageview time-series for a date range (for the sparkline).
 * `unit` is Umami's bucket unit ("hour" | "day" | "month").
 */
export async function fetchUmamiPageviews(
  startAt: number,
  endAt: number,
  unit: "hour" | "day" | "month" = "day",
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = sidecarEnv("umami"),
): Promise<UmamiPageviewBucket[]> {
  const url =
    `${apiBase(env)}/api/websites/${websiteId(env)}/pageviews` +
    `?startAt=${startAt}&endAt=${endAt}&unit=${unit}&timezone=UTC`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey(env)}` },
    });
  } catch {
    throw new UmamiApiError(0, "Could not reach the Umami sidecar.");
  }
  if (!res.ok) {
    throw new UmamiApiError(res.status, `Umami request failed with HTTP ${res.status}.`);
  }
  return normalizePageviews(await res.json());
}
