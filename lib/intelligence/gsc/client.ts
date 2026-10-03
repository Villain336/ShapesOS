// Marketr — Phase 10 M1: Google Search Console API client.
//
// Wraps the Search Analytics API using the EXISTING M21 OAuth vault
// (lib/vault): the "google-search-console" connector's stored tokens are
// decrypted via getDecryptedCredential() and silently refreshed via
// refreshConnection() — no second OAuth flow is built here.
//
// API surface:
//   POST https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
//   Body: { startDate, endDate, dimensions, dataState, rowLimit, startRow, ... }
//   Response rows: { keys: [query, page, country, device], clicks, impressions, ctr, position }
//
// Caps honored (documented in README.md):
//   - ~50,000 rows/day/search-type/property: paginated via startRow/rowLimit,
//     hard-stop at 50k with a `truncated` flag on the snapshot run.
//   - 1,200 QPM/site: light in-process throttle before each call.
//   - HOURLY_ALL (hourly granularity) only covers the last ~30 days.

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { getDecryptedCredential, refreshConnection } from "@/lib/vault/refresh";
import { recordApiMeter } from "@/lib/intelligence/providers";
import type { DateWindow, GscGranularity, GscSnapshotRow } from "./types";

const GSC_API = "https://www.googleapis.com/webmasters/v3/sites";
export const GSC_CONNECTOR_KEY = "google-search-console";

/** Hard caps from the GSC API docs. */
export const GSC_MAX_ROWS_PER_DAY = 50_000;
export const GSC_QPM = 1_200;
const PAGE_SIZE = 25_000;

/** Backoff for 429/5xx: base 1s, doubling, up to 4 retries, small jitter. */
const BACKOFF_BASE_MS = 1_000;
const MAX_RETRIES = 4;

export interface GscToken {
  accessToken: string;
  /** The SC property bound to the project, e.g. "sc-domain:example.com". */
  property: string;
}

export interface ClientDeps {
  fetchImpl?: typeof fetch;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── In-process QPM throttle (per process; the cron is the only bulk caller) ──

const callTimestamps: number[] = [];

async function throttleQpm(): Promise<void> {
  const now = Date.now();
  while (callTimestamps.length && callTimestamps[0] <= now - 60_000) callTimestamps.shift();
  if (callTimestamps.length >= GSC_QPM) {
    await sleep(callTimestamps[0] + 60_000 - now + 50);
    return throttleQpm();
  }
  callTimestamps.push(now);
}

/**
 * Resolve a live GSC access token for a project by reusing the M21 vault.
 * Looks up the project's ProjectDataSource binding for connectorKey
 * "google-search-console", decrypts the stored credential, and silently
 * refreshes when expired. Throws when nothing is connected.
 */
export async function getGscToken(
  workspaceId: string,
  projectId: string,
): Promise<GscToken> {
  const binding = await withWorkspaceScope(workspaceId, (tx) =>
    tx.projectDataSource.findFirst({
      where: { projectId, connectorKey: GSC_CONNECTOR_KEY },
      include: { connection: { include: { credential: true } } },
    }),
  );
  if (!binding || binding.connection.status !== "active") {
    throw new Error(
      `GSC not connected for project ${projectId}: bind the "google-search-console" connector first`,
    );
  }
  const credential = await getDecryptedCredential(binding.connection.id);
  const payload = credential?.payload;
  let accessToken =
    payload && typeof payload.access_token === "string" ? payload.access_token : null;
  const expiresAt = binding.connection.credential?.expiresAt ?? null;
  if (!accessToken || (expiresAt && expiresAt.getTime() - Date.now() < 60_000)) {
    const res = await refreshConnection(binding.connection.id);
    if (res !== "refreshed") {
      throw new Error(
        `GSC token for project ${projectId} expired and refresh failed — reconnect the connector`,
      );
    }
    const fresh = await getDecryptedCredential(binding.connection.id);
    accessToken =
      fresh?.payload && typeof fresh.payload.access_token === "string"
        ? fresh.payload.access_token
        : null;
  }
  if (!accessToken) throw new Error(`GSC credential has no access token for project ${projectId}`);
  const property =
    (binding.projectConfig as { property?: string } | null)?.property ??
    "sc-domain:unknown";
  return { accessToken, property };
}

// ── Search Analytics query ───────────────────────────────────────────────────

export interface SearchAnalyticsParams {
  token: GscToken;
  window: DateWindow;
  /** Subset of ["query","page","country","device"]. */
  dimensions: string[];
  dataState: "HOURLY_ALL" | "all";
}

interface GscApiRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Meter one GSC API call via the shared Phase 10 metering primitive. The
 * api_meter table is the append-only per-call audit log (spec §4 invariant 6
 * "audit everything"): vendor "google_gsc", GSC is free so cost_usd = 0,
 * quantity = rows returned. NOTE: ApiMeterKind has no gsc_call bucket, so
 * GSC calls ride the serp_call bucket (the only search-data call bucket);
 * filter by vendor="google_gsc" to separate them from paid SERP.
 */
async function meterGscCall(workspaceId: string, quantity: number): Promise<void> {
  await recordApiMeter(workspaceId, "google_gsc", "serp_call", quantity, 0);
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

async function postQuery(
  params: SearchAnalyticsParams,
  body: Record<string, unknown>,
  deps: ClientDeps,
  workspaceId: string,
): Promise<{ rows: GscApiRow[]; callCount: number }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${GSC_API}/${encodeURIComponent(params.token.property)}/searchAnalytics/query`;
  let lastError: Error | null = null;
  let calls = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttleQpm();
    calls++;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.token.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastError = e as Error;
      await sleep(BACKOFF_BASE_MS * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const json = (await res.json()) as { rows?: GscApiRow[] };
      const rows = json.rows ?? [];
      await meterGscCall(workspaceId, rows.length);
      return { rows, callCount: calls };
    }
    if (isRetryable(res.status) && attempt < MAX_RETRIES) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter
        ? Number(retryAfter) * 1000
        : BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(waitMs);
      continue;
    }
    const text = await res.text().catch(() => "");
    lastError = new Error(`GSC API ${res.status}: ${text.slice(0, 300)}`);
    break;
  }
  throw lastError ?? new Error("GSC API call failed");
}

/**
 * Pull one window of Search Analytics rows, paginating to the 50k/day cap.
 * Returns aggregated rows plus quota accounting for the run.
 */
export async function querySearchAnalytics(
  workspaceId: string,
  params: SearchAnalyticsParams,
  deps: ClientDeps = {},
): Promise<{ rows: GscSnapshotRow[]; apiCalls: number; truncated: boolean }> {
  const dimIndex = (name: string) => params.dimensions.indexOf(name);
  const out: GscSnapshotRow[] = [];
  let apiCalls = 0;
  let truncated = false;
  let startRow = 0;

  for (;;) {
    const body = {
      startDate: ymd(params.window.start),
      endDate: ymd(params.window.end),
      dimensions: params.dimensions,
      dataState: params.dataState,
      rowLimit: PAGE_SIZE,
      startRow,
    };
    const { rows, callCount } = await postQuery(params, body, deps, workspaceId);
    apiCalls += callCount;
    for (const r of rows) {
      const q = dimIndex("query");
      const p = dimIndex("page");
      const c = dimIndex("country");
      const d = dimIndex("device");
      out.push({
        query: q >= 0 ? (r.keys[q] ?? "") : "",
        page: p >= 0 ? (r.keys[p] ?? "") : "",
        country: c >= 0 ? (r.keys[c] ?? null) : null,
        device: d >= 0 ? (r.keys[d] ?? null) : null,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      });
    }
    if (rows.length < PAGE_SIZE) break;
    startRow += PAGE_SIZE;
    if (startRow >= GSC_MAX_ROWS_PER_DAY) {
      truncated = true; // hard wall: stop even if more rows exist
      break;
    }
  }
  return { rows: out, apiCalls, truncated };
}

// ── Snapshot pulls ───────────────────────────────────────────────────────────

export interface PullResult {
  snapshots: number;
  rows: number;
  apiCalls: number;
  truncated: boolean;
  granularity: GscGranularity;
}

/**
 * Pull GSC Search Analytics for a project and store aggregated snapshots.
 *
 * - granularity "daily": one API window per call (dataState "all").
 * - granularity "hourly": 24h chunks with dataState HOURLY_ALL (the finest
 *   the API exposes; hourly coverage exists only for the last ~30 days, so
 *   chunks older than that are skipped, not failed).
 *
 * Snapshots upsert on (projectId, windowStart, windowEnd, granularity).
 */
export async function pullSnapshots(
  workspaceId: string,
  projectId: string,
  window: DateWindow,
  granularity: GscGranularity,
  deps: ClientDeps = {},
): Promise<PullResult> {
  const token = await getGscToken(workspaceId, projectId);
  const dimensions = ["query", "page", "country", "device"];
  const dataState = granularity === "hourly" ? "HOURLY_ALL" : "all";

  // Chunk the window: hourly → 24h chunks; daily → the whole window in one go.
  const chunks: DateWindow[] = [];
  if (granularity === "hourly") {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let cursor = new Date(window.start);
    while (cursor < window.end) {
      const next = new Date(Math.min(cursor.getTime() + 24 * 60 * 60 * 1000, window.end.getTime()));
      if (next.getTime() >= thirtyDaysAgo) chunks.push({ start: new Date(cursor), end: next });
      cursor = next;
    }
  } else {
    chunks.push(window);
  }

  let totalRows = 0;
  let totalCalls = 0;
  let truncated = false;
  let snapshots = 0;

  for (const chunk of chunks) {
    const { rows, apiCalls, truncated: t } = await querySearchAnalytics(
      workspaceId,
      { token, window: chunk, dimensions, dataState },
      deps,
    );
    totalCalls += apiCalls;
    truncated = truncated || t;
    totalRows += rows.length;

    await withWorkspaceScope(workspaceId, (tx) =>
      tx.gscSnapshot.upsert({
        where: {
          projectId_windowStart_windowEnd_granularity: {
            projectId,
            windowStart: chunk.start,
            windowEnd: chunk.end,
            granularity,
          },
          workspaceId,
        },
        create: {
          workspaceId,
          projectId,
          windowStart: chunk.start,
          windowEnd: chunk.end,
          granularity,
          rows: rows as unknown as object,
        },
        update: { rows: rows as unknown as object, pulledAt: new Date() },
      }),
    );
    snapshots++;
  }

  return { snapshots, rows: totalRows, apiCalls: totalCalls, truncated, granularity };
}
