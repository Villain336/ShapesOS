// ShapesOS — Phase 4b live GA4 client (Data API v1beta + Admin API v1beta).
// Endpoint shapes verified against developers.google.com/analytics (2026-10).

import { liveRequest, ConnectorApiError, type LiveDeps, type TokenSource } from "./http";

export const GA4_DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";
export const GA4_ADMIN_BASE = "https://analyticsadmin.googleapis.com/v1beta";
const PROVIDER = "Google Analytics";

interface RunReportResponse {
  dimensionHeaders?: Array<{ name: string }>;
  metricHeaders?: Array<{ name: string; type?: string }>;
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ value?: string }>;
  }>;
  rowCount?: number;
}

/** GA4 property ids are numeric; "properties/123" is accepted and normalized. */
export function normalizePropertyId(raw: unknown): string {
  const s = String(raw ?? "").trim().replace(/^properties\//, "");
  if (!/^\d{1,20}$/.test(s)) {
    throw new ConnectorApiError(PROVIDER, "bad_request", `${PROVIDER}: property id must be numeric (got "${s.slice(0, 40)}").`);
  }
  return s;
}

/** GA4 accepts YYYY-MM-DD, NdaysAgo, yesterday, today. */
export function normalizeGaDate(raw: unknown, field: string): string {
  const s = String(raw ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{1,4}daysAgo$/.test(s) || s === "today" || s === "yesterday") return s;
  throw new ConnectorApiError(PROVIDER, "bad_request", `${PROVIDER}: ${field} must be YYYY-MM-DD, NdaysAgo, yesterday or today.`);
}

function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function runReport(
  auth: TokenSource,
  propertyId: string,
  body: Record<string, unknown>,
  deps: LiveDeps,
): Promise<RunReportResponse> {
  return liveRequest<RunReportResponse>(
    {
      provider: PROVIDER,
      method: "POST",
      url: `${GA4_DATA_BASE}/properties/${propertyId}:runReport`,
      json: body,
      auth,
    },
    deps,
  );
}

export async function ga4TrafficReport(
  auth: TokenSource,
  args: { propertyId: string; startDate: string; endDate: string },
  deps: LiveDeps = {},
) {
  const res = await runReport(
    auth,
    args.propertyId,
    {
      dateRanges: [{ startDate: args.startDate, endDate: args.endDate }],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "newUsers" },
        { name: "engagementRate" },
        { name: "keyEvents" },
      ],
    },
    deps,
  );
  const values = res.rows?.[0]?.metricValues ?? [];
  return {
    propertyId: args.propertyId,
    startDate: args.startDate,
    endDate: args.endDate,
    sessions: num(values[0]?.value),
    totalUsers: num(values[1]?.value),
    newUsers: num(values[2]?.value),
    engagementRate: num(values[3]?.value),
    conversions: num(values[4]?.value),
  };
}

export async function ga4TopPages(
  auth: TokenSource,
  args: { propertyId: string; startDate: string; endDate: string; limit: number },
  deps: LiveDeps = {},
) {
  const res = await runReport(
    auth,
    args.propertyId,
    {
      dateRanges: [{ startDate: args.startDate, endDate: args.endDate }],
      dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "engagementRate" },
        { name: "keyEvents" },
      ],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: args.limit,
      offset: 0,
    },
    deps,
  );
  return {
    propertyId: args.propertyId,
    totalRows: res.rowCount ?? (res.rows?.length ?? 0),
    rows: (res.rows ?? []).map((r) => ({
      pagePath: r.dimensionValues?.[0]?.value ?? "",
      pageTitle: r.dimensionValues?.[1]?.value ?? "",
      sessions: num(r.metricValues?.[0]?.value),
      users: num(r.metricValues?.[1]?.value),
      engagementRate: num(r.metricValues?.[2]?.value),
      conversions: num(r.metricValues?.[3]?.value),
    })),
  };
}

interface AccountSummariesResponse {
  accountSummaries?: Array<{
    account?: string;
    displayName?: string;
    propertySummaries?: Array<{ property?: string; displayName?: string; propertyType?: string }>;
  }>;
  nextPageToken?: string;
}

/** Account summaries with pageToken pagination (capped at maxPages). */
export async function ga4ListProperties(auth: TokenSource, deps: LiveDeps = {}, maxPages = 10) {
  const properties: Array<{ propertyId: string; displayName: string; account: string; accountName: string }> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await liveRequest<AccountSummariesResponse>(
      {
        provider: PROVIDER,
        url: `${GA4_ADMIN_BASE}/accountSummaries`,
        query: { pageSize: 200, pageToken },
        auth,
      },
      deps,
    );
    for (const a of res.accountSummaries ?? []) {
      for (const p of a.propertySummaries ?? []) {
        properties.push({
          propertyId: (p.property ?? "").replace(/^properties\//, ""),
          displayName: p.displayName ?? "",
          account: (a.account ?? "").replace(/^accounts\//, ""),
          accountName: a.displayName ?? "",
        });
      }
    }
    pageToken = res.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return properties;
}

/** Health check: one account summary. */
export async function ga4Ping(auth: TokenSource, deps: LiveDeps = {}) {
  await liveRequest(
    { provider: PROVIDER, url: `${GA4_ADMIN_BASE}/accountSummaries`, query: { pageSize: 1 }, auth },
    deps,
  );
  return { reachable: true };
}
