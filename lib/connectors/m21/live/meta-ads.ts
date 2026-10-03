// ShapesOS — Phase 4b live Meta Marketing API client (versioned Graph URL).
//   GET {graph}/me/adaccounts?fields=…            → ad accounts
//   GET {graph}/act_{id}/insights?level=account   → account insights
//   GET {graph}/act_{id}/campaigns?fields=…       → campaigns (cursor paging)
//   GET {graph}/{campaignId}/insights             → campaign insights
// {graph} = https://graph.facebook.com/v26.0 (latest as of 2026-10 per the
// Graph API changelog; META_GRAPH_API_VERSION overrides it). The access
// token rides the Authorization header; appsecret_proof (HMAC-SHA256 of the
// token with the app secret) is added when the app secret is known, which
// Meta requires for apps with "Require App Secret" on.
// Errors: Meta answers 400/403 with error.code — 190/102 invalid token,
// 4/17/32/613/80000-80014 throttling, 10/200-299 permissions.

import { createHmac } from "node:crypto";
import {
  liveRequest,
  ConnectorApiError,
  providerMessage,
  type Classification,
  type LiveDeps,
  type TokenSource,
} from "./http";

const PROVIDER = "Meta Ads";
export const META_GRAPH_DEFAULT_VERSION = "v26.0";

export function metaGraphBase(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env.META_GRAPH_API_VERSION ?? "").trim();
  return `https://graph.facebook.com/${/^v\d{2}\.0$/.test(v) ? v : META_GRAPH_DEFAULT_VERSION}`;
}

export interface MetaAuth extends TokenSource {
  /** Meta app secret → appsecret_proof. Optional. */
  appSecret?: string;
}

export function classifyMeta(status: number, body: unknown): Classification {
  const err = (body as { error?: { code?: number; error_subcode?: number; is_transient?: boolean } })?.error;
  const code = typeof err?.code === "number" ? err.code : null;
  const message = providerMessage(body);
  if (code === 190 || code === 102 || status === 401) {
    return { code: "auth_rejected", retryable: false, authExpired: true, message };
  }
  if (code !== null && ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014))) {
    return { code: "rate_limited", retryable: true, message };
  }
  if (status === 429) return { code: "rate_limited", retryable: true, message };
  if (code !== null && (code === 10 || (code >= 200 && code <= 299))) {
    return { code: "forbidden", retryable: false, message };
  }
  if (err?.is_transient === true || code === 1 || code === 2 || status >= 500) {
    return { code: "provider_error", retryable: true, message };
  }
  if (code === 100 && err?.error_subcode === 33) return { code: "not_found", retryable: false, message };
  if (status === 404) return { code: "not_found", retryable: false, message };
  return { code: "bad_request", retryable: false, message };
}

const DATE_PRESETS = new Set([
  "today", "yesterday", "this_month", "last_month", "this_quarter", "maximum", "data_maximum",
  "last_3d", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d", "last_week_mon_sun",
  "last_week_sun_sat", "last_quarter", "last_year", "this_week_mon_today", "this_week_sun_today",
  "this_year",
]);

export function normalizeDatePreset(raw: unknown): string {
  const s = String(raw ?? "last_30d").trim().toLowerCase();
  if (DATE_PRESETS.has(s)) return s;
  throw new ConnectorApiError(PROVIDER, "bad_request", `${PROVIDER}: datePreset must be one of ${[...DATE_PRESETS].join(", ")}.`);
}

/** "act_123" or "123" → "act_123". */
export function normalizeAdAccountId(raw: unknown): string {
  const s = String(raw ?? "").trim().replace(/^act_/, "");
  if (!/^\d{1,20}$/.test(s)) {
    throw new ConnectorApiError(PROVIDER, "bad_request", `${PROVIDER}: adAccountId must look like act_123456789.`);
  }
  return `act_${s}`;
}

export function normalizeGraphId(raw: unknown, field: string): string {
  const s = String(raw ?? "").trim();
  if (!/^\d{1,30}$/.test(s)) {
    throw new ConnectorApiError(PROVIDER, "bad_request", `${PROVIDER}: ${field} must be a numeric id.`);
  }
  return s;
}

export function appSecretProof(token: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(token).digest("hex");
}

async function graphGet<T>(auth: MetaAuth, path: string, query: Record<string, string | number | undefined>, deps: LiveDeps): Promise<T> {
  const call = (token: string) =>
    liveRequest<T>(
      {
        provider: PROVIDER,
        url: `${metaGraphBase()}${path}`,
        query: { ...query, ...(auth.appSecret ? { appsecret_proof: appSecretProof(token, auth.appSecret) } : {}) },
        auth: { token },
        classify: classifyMeta,
      },
      deps,
    );
  try {
    return await call(auth.token);
  } catch (err) {
    // The proof is bound to the token, so refresh is handled here (once)
    // rather than inside liveRequest. Meta issues no refresh tokens, so the
    // vault refresher normally flips the connection to needs_reauth.
    if (!(err instanceof ConnectorApiError) || err.code !== "auth_rejected" || !auth.refresh) throw err;
    const refresh = auth.refresh;
    auth.refresh = undefined; // one refresh per invocation
    const next = await refresh().catch(() => null);
    if (!next) {
      throw new ConnectorApiError(
        PROVIDER,
        "auth_rejected",
        `${PROVIDER} rejected the stored token — reconnect the integration.`,
        err.status,
      );
    }
    auth.token = next;
    return call(next);
  }
}

interface Paged<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

async function graphList<T>(
  auth: MetaAuth,
  path: string,
  query: Record<string, string | number | undefined>,
  deps: LiveDeps,
  maxRows: number,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await graphGet<Paged<T>>(auth, path, { ...query, after }, deps);
    out.push(...(res.data ?? []));
    after = res.paging?.next ? res.paging?.cursors?.after : undefined;
    if (!after || out.length >= maxRows) break;
  }
  return out.slice(0, maxRows);
}

const LEAD_ACTIONS = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];

interface InsightRow {
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
}

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function shapeInsights(row: InsightRow | undefined) {
  const spend = num(row?.spend);
  const actions = row?.actions ?? [];
  let leads = 0;
  for (const t of LEAD_ACTIONS) {
    const hit = actions.find((a) => a.action_type === t);
    if (hit) {
      leads = num(hit.value);
      break;
    }
  }
  return {
    spend,
    impressions: num(row?.impressions),
    clicks: num(row?.clicks),
    // Meta reports CTR as a percentage; the adapter contract is a fraction.
    ctr: Math.round((num(row?.ctr) / 100) * 10_000) / 10_000,
    cpc: num(row?.cpc),
    leads,
    costPerLead: leads > 0 ? Math.round((spend / leads) * 100) / 100 : null,
  };
}

const INSIGHT_FIELDS = "spend,impressions,clicks,ctr,cpc,actions";

export async function metaListAdAccounts(auth: MetaAuth, deps: LiveDeps = {}) {
  const rows = await graphList<{ id?: string; name?: string; account_status?: number; currency?: string }>(
    auth,
    "/me/adaccounts",
    { fields: "id,name,account_id,account_status,currency", limit: 100 },
    deps,
    500,
  );
  return rows.map((r) => ({ id: r.id ?? "", name: r.name ?? "", accountStatus: r.account_status ?? null, currency: r.currency ?? null }));
}

export async function metaAccountInsights(auth: MetaAuth, adAccountId: string, datePreset: string, deps: LiveDeps = {}) {
  const res = await graphGet<Paged<InsightRow>>(
    auth,
    `/${adAccountId}/insights`,
    { level: "account", date_preset: datePreset, fields: INSIGHT_FIELDS },
    deps,
  );
  return { adAccountId, datePreset, ...shapeInsights(res.data?.[0]) };
}

export async function metaListCampaigns(auth: MetaAuth, adAccountId: string, deps: LiveDeps = {}) {
  const rows = await graphList<{ id?: string; name?: string; status?: string; effective_status?: string; objective?: string }>(
    auth,
    `/${adAccountId}/campaigns`,
    { fields: "id,name,status,effective_status,objective", limit: 100 },
    deps,
    500,
  );
  return rows.map((r) => ({
    id: r.id ?? "",
    name: r.name ?? "",
    status: r.status ?? "",
    effectiveStatus: r.effective_status ?? "",
    objective: r.objective ?? "",
  }));
}

export async function metaCampaignInsights(auth: MetaAuth, campaignId: string, datePreset: string, deps: LiveDeps = {}) {
  const res = await graphGet<Paged<InsightRow>>(
    auth,
    `/${campaignId}/insights`,
    { date_preset: datePreset, fields: INSIGHT_FIELDS },
    deps,
  );
  return { campaignId, datePreset, ...shapeInsights(res.data?.[0]) };
}

/** Health check: the token's own user id. */
export async function metaPing(auth: MetaAuth, deps: LiveDeps = {}) {
  await graphGet<{ id?: string }>(auth, "/me", { fields: "id" }, deps);
  return { reachable: true };
}
