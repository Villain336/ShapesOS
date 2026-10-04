// ShapesOS — the ONE Google Search Console HTTP client (Webmasters v3).
//
//   GET  https://www.googleapis.com/webmasters/v3/sites
//   POST https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
//        body { startDate, endDate, dimensions, dataState, rowLimit, startRow }
// Pagination: searchAnalytics pages by startRow (rowLimit max 25,000).
// Docs: https://developers.google.com/webmaster-tools/v1/searchanalytics/query
//
// Phase 6: both callers share this module — the bulk snapshot cron
// (./client.ts: QPM throttle, metering, snapshot storage) and the M21
// connector adapter (lib/connectors/m21/native/google-search-console.ts:
// agent tools). Transport is the shared live connector layer
// (lib/connectors/m21/live/http.ts → safeFetch): Bearer auth, refresh once
// on 401, 429/5xx/quota-403 backoff, closed error codes, scrubbed messages.
//
// No Prisma import here, so the connector registry's import graph stays
// free of the cron's DB code.

import {
  liveRequest,
  ConnectorApiError,
  type LiveDeps,
  type TokenSource,
} from "@/lib/connectors/m21/live/http";

export const GSC_BASE = "https://www.googleapis.com/webmasters/v3";
export const GSC_PROVIDER = "Google Search Console";
/** Max rows per searchAnalytics.query page (API limit). */
export const GSC_PAGE_SIZE = 25_000;

export interface GscApiRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export interface GscQueryBody {
  startDate: string;
  endDate: string;
  dimensions: string[];
  dataState?: "final" | "all" | "HOURLY_ALL";
  rowLimit: number;
  startRow: number;
}

/** Accept sc-domain:example.com or an http(s) URL-prefix property. */
export function normalizeProperty(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (/^sc-domain:[a-z0-9.-]+$/i.test(s) || /^https?:\/\/[^\s]+$/i.test(s)) return s;
  throw new ConnectorApiError(
    GSC_PROVIDER,
    "bad_request",
    `${GSC_PROVIDER}: property must be sc-domain:<domain> or a URL prefix.`,
  );
}

export async function gscListSites(auth: TokenSource, deps: LiveDeps = {}) {
  const res = await liveRequest<{ siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }> }>(
    { provider: GSC_PROVIDER, url: `${GSC_BASE}/sites`, auth },
    deps,
  );
  return (res.siteEntry ?? []).map((s) => ({
    property: s.siteUrl ?? "",
    permissionLevel: s.permissionLevel ?? "",
  }));
}

/** One searchAnalytics.query page. */
export async function gscSearchAnalyticsPage(
  auth: TokenSource,
  property: string,
  body: GscQueryBody,
  deps: LiveDeps = {},
): Promise<GscApiRow[]> {
  const res = await liveRequest<{ rows?: GscApiRow[] }>(
    {
      provider: GSC_PROVIDER,
      method: "POST",
      url: `${GSC_BASE}/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
      json: body,
      auth,
    },
    deps,
  );
  return res.rows ?? [];
}

/**
 * searchAnalytics.query for one dimension, paged by startRow until `limit`
 * rows or a short page (the agent-tool shape).
 */
export async function gscQuery(
  auth: TokenSource,
  args: { property: string; startDate: string; endDate: string; dimension: "query" | "page"; limit: number },
  deps: LiveDeps = {},
): Promise<GscApiRow[]> {
  const out: GscApiRow[] = [];
  let startRow = 0;
  while (out.length < args.limit) {
    const rowLimit = Math.min(GSC_PAGE_SIZE, args.limit - out.length);
    const rows = await gscSearchAnalyticsPage(
      auth,
      args.property,
      {
        startDate: args.startDate,
        endDate: args.endDate,
        dimensions: [args.dimension],
        rowLimit,
        startRow,
        dataState: "final",
      },
      deps,
    );
    out.push(...rows);
    if (rows.length < rowLimit) break;
    startRow += rows.length;
  }
  return out.slice(0, args.limit);
}

export function shapeGscRow(r: GscApiRow, dimension: "query" | "page") {
  const key = r.keys?.[0] ?? "";
  return {
    ...(dimension === "query" ? { query: key } : { page: key }),
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: Math.round((r.ctr ?? 0) * 1000) / 1000,
    position: Math.round((r.position ?? 0) * 10) / 10,
  };
}
