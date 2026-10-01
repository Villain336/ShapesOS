// Marketr — Phase 18 slice 2: Amazon Ads API v3 client.
//
// Pure network layer: no Prisma, no Next.js imports. fetchImpl is injectable
// so tests run against a mocked Amazon API — no live Amazon developer-program
// credentials exist, so the sandbox/mock path is the verified path.
//
// Endpoints verified 2026-09-30 against the Amazon Ads API docs and the
// official amzn/ads-advanced-tools-docs repo:
//   - profiles:            GET /v2/profiles
//   - SP v3:               POST /sp/campaigns/list, POST /sp/campaigns,
//                          PUT /sp/campaigns
//                          (Content-Type: application/vnd.spCampaign.v3+json)
//   - SB v4:               POST /sb/v4/campaigns/list, POST /sb/v4/campaigns,
//                          PUT /sb/v4/campaigns
//                          (Content-Type: application/vnd.sbcampaignresource.v4+json)
//   - reporting v3:        POST /reporting/reports,
//                          GET /reporting/reports/{reportId}
//                          (Content-Type: application/vnd.createasyncreportrequest.v3+json)
// Auth headers on every call: Authorization: Bearer <LWA access token>,
// Amazon-Ads-ClientId: <LWA client id>, Amazon-Advertising-API-Scope:
// <advertiser profile id> (profile-scoped calls).
//
// Sponsored TV: the STV REST surface could NOT be verified against official
// docs (only beta MCP prefixes), so STV create/list fail closed with
// STV_NOT_VERIFIED rather than guessing a path. Enable it in a later slice
// once a live credential confirms the endpoint.

export class AmazonAdsError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "AmazonAdsError";
    this.code = code;
    this.status = status;
  }
}

export const AMAZON_ADS_REGION_BASE_URLS = {
  NA: "https://advertising-api.amazon.com",
  EU: "https://advertising-api-eu.amazon.com",
  FE: "https://advertising-api-fe.amazon.com",
} as const;

export type AmazonAdsRegion = keyof typeof AMAZON_ADS_REGION_BASE_URLS;

export function regionBaseUrl(region: string | undefined): string {
  const key = (region ?? "NA").toUpperCase();
  if (key in AMAZON_ADS_REGION_BASE_URLS) {
    return AMAZON_ADS_REGION_BASE_URLS[key as AmazonAdsRegion];
  }
  throw new AmazonAdsError("UNKNOWN_REGION", `Unknown Amazon Ads region: ${region}`);
}

export interface AmazonAdsAuth {
  /** LWA access token. Never logged — error paths only carry status codes. */
  accessToken: string;
  /** LWA client id → Amazon-Ads-ClientId header. */
  clientId: string;
  /**
   * Advertiser profile id → Amazon-Advertising-API-Scope header. Optional at
   * construction: the profiles call (GET /v2/profiles) is unscoped, so the
   * OAuth callback can list profiles BEFORE any profile id is known. Every
   * profile-scoped call throws MISSING_AUTH when it is absent.
   */
  profileId?: string;
  /** Region base URL. Defaults to NA. */
  baseUrl?: string;
}

export type AmazonAdProduct = "sp" | "sb";

export type AmazonCampaignState = "ENABLED" | "PAUSED" | "ARCHIVED";

export interface AmazonProfile {
  profileId: number;
  countryCode: string;
  currencyCode: string;
  dailyBudget?: number;
  timezone?: string;
  accountInfo?: {
    marketplaceStringId?: string;
    sellerStringId?: string;
    type?: string;
    name?: string;
  };
}

export interface SpCampaign {
  campaignId?: string;
  name?: string;
  campaignType?: string;
  targetingType?: "AUTO" | "MANUAL";
  state?: AmazonCampaignState;
  dailyBudget?: number;
  startDate?: string;
  endDate?: string;
  portfolioId?: string;
  [k: string]: unknown;
}

export interface SbCampaign {
  campaignId?: string;
  name?: string;
  state?: AmazonCampaignState;
  budgetType?: "DAILY" | "LIFETIME";
  budget?: number;
  startDate?: string;
  endDate?: string;
  brandEntityId?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Pure payload builders — tested without network
// ---------------------------------------------------------------------------

export interface SpCampaignCreateInput {
  name: string;
  targetingType: "auto" | "manual";
  /** Daily budget in minor units (cents) — converted to major units. */
  dailyBudgetCents: number;
  /** YYYYMMDD. */
  startDate: string;
  endDate?: string;
  state?: "enabled" | "paused";
  portfolioId?: string;
}

export interface SbCampaignCreateInput {
  name: string;
  dailyBudgetCents: number;
  startDate: string;
  endDate?: string;
  state?: "enabled" | "paused";
  /** SB brand entity id; required by Amazon for a launchable SB campaign. */
  brandEntityId?: string;
}

/** Major currency units (what the Amazon API takes) from minor units. */
export function centsToMajor(cents: number): number {
  return Math.round(cents) / 100;
}

export function majorToCents(major: number): number {
  return Math.round(major * 100);
}

function validateCreateInput(input: { name: string; dailyBudgetCents: number; startDate: string }) {
  if (!input.name || !input.name.trim()) {
    throw new AmazonAdsError("INVALID_INPUT", "Campaign name is required");
  }
  if (!Number.isFinite(input.dailyBudgetCents) || input.dailyBudgetCents <= 0) {
    throw new AmazonAdsError("INVALID_INPUT", "dailyBudgetCents must be a positive number");
  }
  if (!/^\d{8}$/.test(input.startDate)) {
    throw new AmazonAdsError("INVALID_INPUT", "startDate must be YYYYMMDD");
  }
}

const SP_V3_CONTENT_TYPE = "application/vnd.spCampaign.v3+json";
const SB_V4_CONTENT_TYPE = "application/vnd.sbcampaignresource.v4+json";
const REPORT_V3_CONTENT_TYPE = "application/vnd.createasyncreportrequest.v3+json";

/** POST /sp/campaigns body (v3). */
export function buildSpCampaignCreateBody(input: SpCampaignCreateInput): { campaigns: SpCampaign[] } {
  validateCreateInput(input);
  const campaign: SpCampaign = {
    name: input.name.trim(),
    targetingType: input.targetingType === "auto" ? "AUTO" : "MANUAL",
    state: input.state === "enabled" ? "ENABLED" : "PAUSED",
    dailyBudget: centsToMajor(input.dailyBudgetCents),
    startDate: input.startDate,
  };
  if (input.endDate) {
    if (!/^\d{8}$/.test(input.endDate)) {
      throw new AmazonAdsError("INVALID_INPUT", "endDate must be YYYYMMDD");
    }
    campaign.endDate = input.endDate;
  }
  if (input.portfolioId) campaign.portfolioId = input.portfolioId;
  return { campaigns: [campaign] };
}

/** POST /sb/v4/campaigns body (v4). */
export function buildSbCampaignCreateBody(input: SbCampaignCreateInput): { campaigns: SbCampaign[] } {
  validateCreateInput(input);
  const campaign: SbCampaign = {
    name: input.name.trim(),
    state: input.state === "enabled" ? "ENABLED" : "PAUSED",
    budgetType: "DAILY",
    budget: centsToMajor(input.dailyBudgetCents),
    startDate: input.startDate,
  };
  if (input.endDate) {
    if (!/^\d{8}$/.test(input.endDate)) {
      throw new AmazonAdsError("INVALID_INPUT", "endDate must be YYYYMMDD");
    }
    campaign.endDate = input.endDate;
  }
  if (input.brandEntityId) campaign.brandEntityId = input.brandEntityId;
  return { campaigns: [campaign] };
}

export interface CampaignUpdateInput {
  campaignId: string;
  state?: "enabled" | "paused" | "archived";
  dailyBudgetCents?: number;
}

/** PUT /sp/campaigns body (v3). Pause = { state: "PAUSED" }. */
export function buildSpCampaignUpdateBody(input: CampaignUpdateInput): { campaigns: SpCampaign[] } {
  if (!input.campaignId) throw new AmazonAdsError("INVALID_INPUT", "campaignId is required");
  const campaign: SpCampaign = { campaignId: input.campaignId };
  if (input.state) campaign.state = input.state.toUpperCase() as AmazonCampaignState;
  if (input.dailyBudgetCents !== undefined) {
    if (!Number.isFinite(input.dailyBudgetCents) || input.dailyBudgetCents <= 0) {
      throw new AmazonAdsError("INVALID_INPUT", "dailyBudgetCents must be a positive number");
    }
    campaign.dailyBudget = centsToMajor(input.dailyBudgetCents);
  }
  if (campaign.state === undefined && campaign.dailyBudget === undefined) {
    throw new AmazonAdsError("INVALID_INPUT", "Nothing to update: set state and/or dailyBudgetCents");
  }
  return { campaigns: [campaign] };
}

/** PUT /sb/v4/campaigns body (v4). */
export function buildSbCampaignUpdateBody(input: CampaignUpdateInput): { campaigns: SbCampaign[] } {
  if (!input.campaignId) throw new AmazonAdsError("INVALID_INPUT", "campaignId is required");
  const campaign: SbCampaign = { campaignId: input.campaignId };
  if (input.state) campaign.state = input.state.toUpperCase() as AmazonCampaignState;
  if (input.dailyBudgetCents !== undefined) {
    if (!Number.isFinite(input.dailyBudgetCents) || input.dailyBudgetCents <= 0) {
      throw new AmazonAdsError("INVALID_INPUT", "dailyBudgetCents must be a positive number");
    }
    campaign.budgetType = "DAILY";
    campaign.budget = centsToMajor(input.dailyBudgetCents);
  }
  if (campaign.state === undefined && campaign.budget === undefined) {
    throw new AmazonAdsError("INVALID_INPUT", "Nothing to update: set state and/or dailyBudgetCents");
  }
  return { campaigns: [campaign] };
}

// ---------------------------------------------------------------------------
// Reporting request builder (async report flow)
// ---------------------------------------------------------------------------

export type AmazonReportAdProduct = "SPONSORED_PRODUCTS" | "SPONSORED_BRANDS";

export interface CampaignReportRequestInput {
  name: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  adProduct: AmazonReportAdProduct;
  campaignIds?: string[];
}

/**
 * POST /reporting/reports body. One row per campaign per day.
 * Columns chosen for the AdReport normalization (reporting.ts):
 * date, campaignId, impressions, clicks, cost (major units), purchases7d,
 * sales7d. Format JSON (not GZIP_JSON) so the download parses without a
 * decompression dependency.
 */
export function buildCampaignReportRequest(input: CampaignReportRequestInput) {
  for (const d of [input.startDate, input.endDate]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new AmazonAdsError("INVALID_INPUT", "Report dates must be YYYY-MM-DD");
    }
  }
  return {
    name: input.name,
    startDate: input.startDate,
    endDate: input.endDate,
    configuration: {
      adProduct: input.adProduct,
      groupBy: ["campaign"],
      columns: ["date", "campaignId", "campaignName", "impressions", "clicks", "cost", "purchases7d", "sales7d"],
      reportTypeId: input.adProduct === "SPONSORED_PRODUCTS" ? "spCampaigns" : "sbCampaigns",
      timeUnit: "DAILY",
      format: "JSON",
      ...(input.campaignIds?.length ? { filters: [{ field: "campaignId", values: input.campaignIds }] } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface AmazonAdsClientOptions {
  auth: AmazonAdsAuth;
  fetchImpl?: typeof fetch;
}

interface ListCampaignsInput {
  adProduct: AmazonAdProduct;
  states?: AmazonCampaignState[];
  campaignIds?: string[];
  maxResults?: number;
}

export class AmazonAdsClient {
  private readonly auth: AmazonAdsAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: AmazonAdsClientOptions) {
    if (!options.auth?.accessToken) {
      throw new AmazonAdsError("MISSING_AUTH", "Amazon Ads access token is required");
    }
    if (!options.auth?.clientId) {
      throw new AmazonAdsError("MISSING_AUTH", "Amazon Ads LWA client id is required");
    }
    this.auth = options.auth;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.auth.baseUrl ?? AMAZON_ADS_REGION_BASE_URLS.NA).replace(/\/+$/, "");
  }

  private requireProfileId(): string {
    if (!this.auth.profileId) {
      throw new AmazonAdsError(
        "MISSING_AUTH",
        "Amazon Ads profile id is required for profile-scoped calls — list profiles first",
      );
    }
    return this.auth.profileId;
  }

  private baseHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.auth.accessToken}`,
      "Amazon-Ads-ClientId": this.auth.clientId,
    };
  }

  private scopedHeaders(contentType?: string): Record<string, string> {
    return {
      ...this.baseHeaders(),
      "Amazon-Advertising-API-Scope": this.requireProfileId(),
      Accept: "application/json",
      ...(contentType ? { "Content-Type": contentType } : {}),
    };
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; contentType?: string; scoped?: boolean } = {},
  ): Promise<T> {
    const { body, contentType, scoped = true } = options;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: scoped ? this.scopedHeaders(contentType) : this.baseHeaders(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new AmazonAdsError("NETWORK", `Amazon Ads request failed: ${e instanceof Error ? e.message : "network error"}`);
    }
    if (!res.ok) {
      // Never log tokens: only the status and the platform's error message.
      let detail = "";
      try {
        const errBody = (await res.json()) as { message?: string; code?: string };
        if (typeof errBody?.message === "string") detail = `: ${errBody.message}`;
        else if (typeof errBody?.code === "string") detail = `: ${errBody.code}`;
      } catch {
        /* non-JSON error body — status alone is enough */
      }
      if (res.status === 401 || res.status === 403) {
        throw new AmazonAdsError("AUTH_FAILED", `Amazon Ads auth failed (HTTP ${res.status})${detail}`, res.status);
      }
      if (res.status === 429) {
        throw new AmazonAdsError("RATE_LIMITED", `Amazon Ads rate limited (HTTP 429)${detail}`, 429);
      }
      throw new AmazonAdsError("API_ERROR", `Amazon Ads API error (HTTP ${res.status})${detail}`, res.status);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new AmazonAdsError("BAD_RESPONSE", "Amazon Ads returned a non-JSON response");
    }
  }

  // -- account ---------------------------------------------------------------

  /** GET /v2/profiles — the "account read". Unscoped (no profile header). */
  async listProfiles(): Promise<AmazonProfile[]> {
    const profiles = await this.request<AmazonProfile[]>("GET", "/v2/profiles", { scoped: false });
    if (!Array.isArray(profiles)) {
      throw new AmazonAdsError("BAD_RESPONSE", "Amazon Ads profiles response was not an array");
    }
    return profiles;
  }

  // -- campaigns --------------------------------------------------------------

  async listCampaigns(input: ListCampaignsInput): Promise<SpCampaign[] | SbCampaign[]> {
    const { adProduct } = input;
    if (adProduct !== "sp" && adProduct !== "sb") {
      throw new AmazonAdsError("UNSUPPORTED_AD_PRODUCT", `Ad product not supported: ${adProduct}`);
    }
    const path = adProduct === "sp" ? "/sp/campaigns/list" : "/sb/v4/campaigns/list";
    const contentType = adProduct === "sp" ? SP_V3_CONTENT_TYPE : SB_V4_CONTENT_TYPE;
    const body: Record<string, unknown> = {
      maxResults: input.maxResults ?? 100,
      stateFilter: { include: input.states ?? ["ENABLED", "PAUSED", "ARCHIVED"] },
    };
    if (input.campaignIds?.length) body.campaignIdFilter = { include: input.campaignIds };
    const res = await this.request<{ campaigns?: unknown[] }>("POST", path, { body, contentType });
    return (res.campaigns ?? []) as SpCampaign[] | SbCampaign[];
  }

  async getCampaign(adProduct: AmazonAdProduct, campaignId: string): Promise<SpCampaign | SbCampaign | null> {
    const rows = await this.listCampaigns({ adProduct, campaignIds: [campaignId], states: ["ENABLED", "PAUSED", "ARCHIVED"] });
    return (rows[0] as SpCampaign | SbCampaign) ?? null;
  }

  async createSpCampaign(input: SpCampaignCreateInput): Promise<SpCampaign> {
    const res = await this.request<{ campaigns?: SpCampaign[] }>("POST", "/sp/campaigns", {
      body: buildSpCampaignCreateBody(input),
      contentType: SP_V3_CONTENT_TYPE,
    });
    const created = res.campaigns?.[0];
    if (!created?.campaignId) {
      throw new AmazonAdsError("CREATE_FAILED", "Amazon Ads SP campaign create returned no campaignId");
    }
    return created;
  }

  async createSbCampaign(input: SbCampaignCreateInput): Promise<SbCampaign> {
    const res = await this.request<{ campaigns?: SbCampaign[] }>("POST", "/sb/v4/campaigns", {
      body: buildSbCampaignCreateBody(input),
      contentType: SB_V4_CONTENT_TYPE,
    });
    const created = res.campaigns?.[0];
    if (!created?.campaignId) {
      throw new AmazonAdsError("CREATE_FAILED", "Amazon Ads SB campaign create returned no campaignId");
    }
    return created;
  }

  /**
   * Fail closed: the Sponsored TV REST surface could not be verified against
   * official Amazon docs, so no path is guessed. Verify with a live
   * credential, then wire the real endpoint here.
   */
  async createStvCampaign(): Promise<never> {
    throw new AmazonAdsError(
      "STV_NOT_VERIFIED",
      "Sponsored TV campaign creation is not wired: the STV REST surface is unverified. Proposals for STV fail closed here.",
    );
  }

  async updateSpCampaign(input: CampaignUpdateInput): Promise<void> {
    await this.request("PUT", "/sp/campaigns", {
      body: buildSpCampaignUpdateBody(input),
      contentType: SP_V3_CONTENT_TYPE,
    });
  }

  async updateSbCampaign(input: CampaignUpdateInput): Promise<void> {
    await this.request("PUT", "/sb/v4/campaigns", {
      body: buildSbCampaignUpdateBody(input),
      contentType: SB_V4_CONTENT_TYPE,
    });
  }

  async pauseCampaign(adProduct: AmazonAdProduct, campaignId: string): Promise<void> {
    if (adProduct === "sp") await this.updateSpCampaign({ campaignId, state: "paused" });
    else await this.updateSbCampaign({ campaignId, state: "paused" });
  }

  async setCampaignBudget(adProduct: AmazonAdProduct, campaignId: string, dailyBudgetCents: number): Promise<void> {
    if (adProduct === "sp") await this.updateSpCampaign({ campaignId, dailyBudgetCents });
    else await this.updateSbCampaign({ campaignId, dailyBudgetCents });
  }

  // -- reporting ---------------------------------------------------------------

  async requestCampaignReport(input: CampaignReportRequestInput): Promise<string> {
    const res = await this.request<{ reportId?: string }>("POST", "/reporting/reports", {
      body: buildCampaignReportRequest(input),
      contentType: REPORT_V3_CONTENT_TYPE,
    });
    if (!res.reportId) {
      throw new AmazonAdsError("REPORT_FAILED", "Amazon Ads report request returned no reportId");
    }
    return res.reportId;
  }

  async getReportStatus(reportId: string): Promise<{ reportId: string; status: string; url?: string }> {
    const res = await this.request<{ reportId?: string; status?: string; url?: string; downloadUrl?: string }>(
      "GET",
      `/reporting/reports/${encodeURIComponent(reportId)}`,
    );
    return {
      reportId: res.reportId ?? reportId,
      status: res.status ?? "UNKNOWN",
      url: res.url ?? res.downloadUrl,
    };
  }

  /** Download a completed report (JSON rows). The URL is pre-signed; no auth headers. */
  async downloadReport(url: string): Promise<Record<string, unknown>[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "GET", headers: { Accept: "application/json" } });
    } catch (e) {
      throw new AmazonAdsError("NETWORK", `Report download failed: ${e instanceof Error ? e.message : "network error"}`);
    }
    if (!res.ok) {
      throw new AmazonAdsError("REPORT_FAILED", `Report download failed (HTTP ${res.status})`, res.status);
    }
    const text = await res.text();
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        throw new AmazonAdsError("BAD_RESPONSE", "Report download was not a JSON array");
      }
      return parsed as Record<string, unknown>[];
    } catch (e) {
      if (e instanceof AmazonAdsError) throw e;
      throw new AmazonAdsError("BAD_RESPONSE", "Report download was not valid JSON");
    }
  }
}
