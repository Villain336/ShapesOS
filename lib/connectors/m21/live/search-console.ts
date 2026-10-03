// ShapesOS — Phase 4b live Google Search Console client (Webmasters v3).
//   GET  https://www.googleapis.com/webmasters/v3/sites
//   POST https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
// Pagination: searchAnalytics pages by startRow (rowLimit max 25,000).
// Docs: https://developers.google.com/webmaster-tools/v1/searchanalytics/query

import { liveRequest, ConnectorApiError, type LiveDeps, type TokenSource } from "./http";

export const GSC_BASE = "https://www.googleapis.com/webmasters/v3";
const PROVIDER = "Google Search Console";
const MAX_ROW_LIMIT = 25_000;

export interface GscQueryRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

/** Accept sc-domain:example.com or an http(s) URL-prefix property. */
export function normalizeProperty(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (/^sc-domain:[a-z0-9.-]+$/i.test(s) || /^https?:\/\/[^\s]+$/i.test(s)) return s;
  throw new ConnectorApiError(PROVIDER, "bad_request", `${PROVIDER}: property must be sc-domain:<domain> or a URL prefix.`);
}

export async function gscListSites(auth: TokenSource, deps: LiveDeps = {}) {
  const res = await liveRequest<{ siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }> }>(
    { provider: PROVIDER, url: `${GSC_BASE}/sites`, auth },
    deps,
  );
  return (res.siteEntry ?? []).map((s) => ({
    property: s.siteUrl ?? "",
    permissionLevel: s.permissionLevel ?? "",
  }));
}

/**
 * searchAnalytics.query paged by startRow until `limit` rows or a short page.
 */
export async function gscQuery(
  auth: TokenSource,
  args: { property: string; startDate: string; endDate: string; dimension: "query" | "page"; limit: number },
  deps: LiveDeps = {},
): Promise<GscQueryRow[]> {
  const out: GscQueryRow[] = [];
  let startRow = 0;
  while (out.length < args.limit) {
    const rowLimit = Math.min(MAX_ROW_LIMIT, args.limit - out.length);
    const res = await liveRequest<{ rows?: GscQueryRow[] }>(
      {
        provider: PROVIDER,
        method: "POST",
        url: `${GSC_BASE}/sites/${encodeURIComponent(args.property)}/searchAnalytics/query`,
        json: {
          startDate: args.startDate,
          endDate: args.endDate,
          dimensions: [args.dimension],
          rowLimit,
          startRow,
          dataState: "final",
        },
        auth,
      },
      deps,
    );
    const rows = res.rows ?? [];
    out.push(...rows);
    if (rows.length < rowLimit) break;
    startRow += rows.length;
  }
  return out.slice(0, args.limit);
}

export function shapeGscRow(r: GscQueryRow, dimension: "query" | "page") {
  const key = r.keys?.[0] ?? "";
  return {
    ...(dimension === "query" ? { query: key } : { page: key }),
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: Math.round((r.ctr ?? 0) * 1000) / 1000,
    position: Math.round((r.position ?? 0) * 10) / 10,
  };
}
