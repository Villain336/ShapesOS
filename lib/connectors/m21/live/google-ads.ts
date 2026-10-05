// ShapesOS — Phase 4b live Google Ads client (REST, GAQL searchStream).
//   GET  https://googleads.googleapis.com/{v}/customers:listAccessibleCustomers
//   POST https://googleads.googleapis.com/{v}/customers/{customerId}/googleAds:searchStream
//        body { query } → JSON array of batches [{ results[], fieldMask, requestId }]
// Phase 6: searchStream replaces paged googleAds:search — one request per
// report, row count bounded by a GAQL LIMIT (added when the query has none).
// An error raised after streaming began arrives as an { error } element of
// the array with HTTP 200; it is classified like a non-2xx response.
// Headers on every call: Authorization: Bearer <token>, developer-token,
// and login-customer-id when the account is reached through a manager (MCC).
// Version v25 verified against the Google Ads API release notes (2026-10);
// GOOGLE_ADS_API_VERSION overrides it when Google sunsets a version.
// GAQL is built from validated parts only (digits, enum literals, ISO dates)
// so no argument text is ever interpolated into a query.

import {
  liveRequest,
  scrubMessage,
  ConnectorApiError,
  defaultClassify,
  type Classification,
  type LiveDeps,
  type TokenSource,
} from "./http";

const PROVIDER = "Google Ads";
export const GOOGLE_ADS_DEFAULT_VERSION = "v25";

export function googleAdsBase(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env.GOOGLE_ADS_API_VERSION ?? "").trim();
  return `https://googleads.googleapis.com/${/^v\d{2,3}$/.test(v) ? v : GOOGLE_ADS_DEFAULT_VERSION}`;
}

export interface GoogleAdsAuth extends TokenSource {
  developerToken: string;
  loginCustomerId?: string;
}

/** 10-digit customer id; dashes are stripped ("123-456-7890" → "1234567890"). */
export function normalizeCustomerId(raw: unknown, field = "customerId"): string {
  const s = String(raw ?? "").replace(/-/g, "").trim();
  if (!/^\d{10}$/.test(s)) {
    throw new ConnectorApiError(PROVIDER, "bad_request", `${PROVIDER}: ${field} must be a 10-digit customer id.`);
  }
  return s;
}

const DURING = new Set([
  "TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS", "LAST_BUSINESS_WEEK",
  "THIS_MONTH", "LAST_MONTH", "THIS_WEEK_SUN_TODAY", "THIS_WEEK_MON_TODAY", "LAST_WEEK_SUN_SAT",
  "LAST_WEEK_MON_SUN",
]);

/** GAQL date predicate from a DURING literal or "YYYY-MM-DD..YYYY-MM-DD". */
export function gaqlDateClause(raw: unknown): string {
  const s = String(raw ?? "LAST_30_DAYS").trim().toUpperCase();
  if (DURING.has(s)) return `segments.date DURING ${s}`;
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(String(raw ?? "").trim());
  if (m && !Number.isNaN(Date.parse(m[1])) && !Number.isNaN(Date.parse(m[2]))) {
    return `segments.date BETWEEN '${m[1]}' AND '${m[2]}'`;
  }
  throw new ConnectorApiError(
    PROVIDER,
    "bad_request",
    `${PROVIDER}: dateRange must be one of ${[...DURING].join(", ")} or YYYY-MM-DD..YYYY-MM-DD.`,
  );
}

/** Google Ads nests the useful message in error.details[].errors[]. */
export function classifyGoogleAds(status: number, body: unknown): Classification {
  const base = defaultClassify(status, body);
  const details = (body as { error?: { details?: Array<{ errors?: Array<{ message?: string; errorCode?: Record<string, string> }> }> } })
    ?.error?.details;
  const first = details?.flatMap((d) => d.errors ?? [])[0];
  const quota = first?.errorCode && Object.keys(first.errorCode).some((k) => k === "quotaError");
  if (quota) return { code: "rate_limited", retryable: true, message: first?.message ?? base.message };
  return { ...base, message: first?.message ?? base.message };
}

function adsHeaders(auth: GoogleAdsAuth): Record<string, string> {
  return {
    "developer-token": auth.developerToken,
    ...(auth.loginCustomerId ? { "login-customer-id": auth.loginCustomerId } : {}),
  };
}

interface SearchStreamBatch<R> {
  results?: R[];
  error?: unknown;
}

/** Append a GAQL LIMIT when the query has none, so the stream is bounded. */
export function withGaqlLimit(query: string, maxRows: number): string {
  return /\bLIMIT\s+\d+\s*$/i.test(query.trim()) ? query.trim() : `${query.trim()} LIMIT ${maxRows}`;
}

/** googleAds:searchStream — every batch flattened, capped at maxRows. */
export async function googleAdsSearch<R = Record<string, unknown>>(
  auth: GoogleAdsAuth,
  customerId: string,
  query: string,
  deps: LiveDeps = {},
  maxRows = 2_000,
): Promise<R[]> {
  const res = await liveRequest<SearchStreamBatch<R>[] | SearchStreamBatch<R> | null>(
    {
      provider: PROVIDER,
      method: "POST",
      url: `${googleAdsBase()}/customers/${customerId}/googleAds:searchStream`,
      headers: adsHeaders(auth),
      json: { query: withGaqlLimit(query, maxRows) },
      auth,
      classify: classifyGoogleAds,
    },
    deps,
  );
  const batches = Array.isArray(res) ? res : res ? [res] : [];
  const out: R[] = [];
  for (const batch of batches) {
    if (batch?.error) {
      const c = classifyGoogleAds(500, { error: batch.error });
      const secrets = [auth.token, auth.developerToken];
      const detail = c.message ? `: ${scrubMessage(c.message, secrets)}` : "";
      throw new ConnectorApiError(PROVIDER, c.code, `${PROVIDER} stream failed${detail}`);
    }
    out.push(...(batch?.results ?? []));
  }
  return out.slice(0, maxRows);
}

export async function googleAdsListAccessible(auth: GoogleAdsAuth, deps: LiveDeps = {}): Promise<string[]> {
  const res = await liveRequest<{ resourceNames?: string[] }>(
    {
      provider: PROVIDER,
      url: `${googleAdsBase()}/customers:listAccessibleCustomers`,
      headers: { "developer-token": auth.developerToken },
      auth,
      classify: classifyGoogleAds,
    },
    deps,
  );
  return (res.resourceNames ?? []).map((r) => r.replace(/^customers\//, ""));
}

const micros = (v: unknown) => Math.round((Number(v ?? 0) / 1_000_000) * 100) / 100;
const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/** Accessible customers, each enriched with its descriptive name (best effort, max 25). */
export async function googleAdsListAccounts(auth: GoogleAdsAuth, deps: LiveDeps = {}) {
  const ids = await googleAdsListAccessible(auth, deps);
  const out: Array<{ id: string; name: string | null; currency: string | null; manager: boolean | null }> = [];
  for (const id of ids.slice(0, 25)) {
    try {
      const rows = await googleAdsSearch<{ customer?: { descriptiveName?: string; currencyCode?: string; manager?: boolean } }>(
        { ...auth, loginCustomerId: auth.loginCustomerId },
        id,
        "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1",
        deps,
        1,
      );
      const c = rows[0]?.customer;
      out.push({ id, name: c?.descriptiveName ?? null, currency: c?.currencyCode ?? null, manager: c?.manager ?? null });
    } catch (err) {
      // Accounts reachable only through a manager need login-customer-id;
      // list them anyway rather than failing the whole call.
      if (err instanceof ConnectorApiError && (err.code === "auth_rejected" || err.code === "rate_limited")) throw err;
      out.push({ id, name: null, currency: null, manager: null });
    }
  }
  return out;
}

export async function googleAdsCampaignReport(
  auth: GoogleAdsAuth,
  args: { customerId: string; dateRange: unknown },
  deps: LiveDeps = {},
) {
  const where = gaqlDateClause(args.dateRange);
  const query =
    "SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, " +
    "metrics.cost_micros, metrics.conversions, metrics.ctr, metrics.average_cpc " +
    `FROM campaign WHERE ${where} ORDER BY metrics.cost_micros DESC`;
  const rows = await googleAdsSearch<{
    campaign?: { id?: string; name?: string; status?: string };
    metrics?: Record<string, unknown>;
  }>(auth, args.customerId, query, deps);
  return rows.map((r) => ({
    id: r.campaign?.id ?? "",
    name: r.campaign?.name ?? "",
    status: r.campaign?.status ?? "",
    impressions: n(r.metrics?.impressions),
    clicks: n(r.metrics?.clicks),
    cost: micros(r.metrics?.costMicros),
    conversions: n(r.metrics?.conversions),
    ctr: n(r.metrics?.ctr),
    avgCpc: micros(r.metrics?.averageCpc),
  }));
}

export async function googleAdsKeywordReport(
  auth: GoogleAdsAuth,
  args: { customerId: string; campaignId: string; dateRange: unknown },
  deps: LiveDeps = {},
) {
  if (!/^\d{1,20}$/.test(args.campaignId)) {
    throw new ConnectorApiError(PROVIDER, "bad_request", `${PROVIDER}: campaignId must be numeric.`);
  }
  const where = gaqlDateClause(args.dateRange);
  const query =
    "SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, " +
    "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions " +
    `FROM keyword_view WHERE campaign.id = ${args.campaignId} AND ${where} ` +
    "ORDER BY metrics.impressions DESC LIMIT 500";
  const rows = await googleAdsSearch<{
    adGroupCriterion?: { keyword?: { text?: string; matchType?: string } };
    metrics?: Record<string, unknown>;
  }>(auth, args.customerId, query, deps, 500);
  return rows.map((r) => ({
    keyword: r.adGroupCriterion?.keyword?.text ?? "",
    matchType: r.adGroupCriterion?.keyword?.matchType ?? "",
    impressions: n(r.metrics?.impressions),
    clicks: n(r.metrics?.clicks),
    cost: micros(r.metrics?.costMicros),
    conversions: n(r.metrics?.conversions),
  }));
}
