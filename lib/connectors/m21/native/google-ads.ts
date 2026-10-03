// ShapesOS — M21 Google Ads adapter.
//
// LIVE WIRING (Phase 4b): with a vault credential this adapter calls the
// Google Ads API over REST (lib/connectors/m21/live/google-ads.ts):
//   GET  https://googleads.googleapis.com/v25/customers:listAccessibleCustomers
//     → list_accounts() (+ customer.descriptive_name per account) + health check
//   POST https://googleads.googleapis.com/v25/customers/{customerId}/googleAds:search
//     GAQL FROM campaign → campaign_report(); FROM keyword_view → keyword_report()
//     (nextPageToken pagination)
// Auth: OAuth2 Bearer (scope adwords) + the developer-token header (the
// app's GOOGLE_ADS_DEVELOPER_TOKEN, or a BYO developerToken in the credential
// payload) + login-customer-id (projectConfig.loginCustomerId, args, or the
// credential payload) for manager-account setups. Refresh-on-401 through
// the vault; quota errors / 429 / 5xx back off and retry.
// Docs: https://developers.google.com/google-ads/api/rest/overview
//
// MOCK MODE (no credential): deterministic demo account data; every row
// flagged mock: true, names carry "(MOCK)". No network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, mockOk, liveOk, fail } from "../types";
import { liveFailure, tokenSourceFrom, ConnectorApiError, type LiveDeps } from "../live/http";
import {
  googleAdsCampaignReport,
  googleAdsKeywordReport,
  googleAdsListAccessible,
  googleAdsListAccounts,
  normalizeCustomerId,
  type GoogleAdsAuth,
} from "../live/google-ads";

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export class GoogleAdsAdapter implements ConnectorAdapter {
  readonly key = "google-ads";
  readonly displayName = "Google Ads";
  readonly authType = "oauth2" as const;
  readonly configSchema = {
    type: "object",
    properties: {
      customerId: {
        type: "string",
        description: "Google Ads customer id (10 digits, no dashes). Also accepted per-project via ProjectDataSource.projectConfig.",
      },
    },
  };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_accounts",
        description: "List Google Ads customer accounts the connected user can access.",
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "campaign_report",
        description: "Campaign performance (impressions, clicks, cost, conversions) over a date range.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            customerId: strProp("Google Ads customer id (10 digits)."),
            dateRange: strProp("e.g. LAST_30_DAYS, LAST_7_DAYS, or YYYY-MM-DD..YYYY-MM-DD."),
          },
          required: ["customerId"],
        },
      },
      {
        name: "keyword_report",
        description: "Keyword-level performance for a campaign.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            customerId: strProp("Google Ads customer id (10 digits)."),
            campaignId: strProp("Campaign id."),
            dateRange: strProp("e.g. LAST_30_DAYS (default) or YYYY-MM-DD..YYYY-MM-DD."),
          },
          required: ["customerId", "campaignId"],
        },
      },
    ];
  }

  /** Live auth: bearer + developer token + optional manager login id. */
  private adsAuth(
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
    args: Record<string, unknown> = {},
  ): GoogleAdsAuth | null {
    const base = tokenSourceFrom(credential, ctx);
    if (!base) return null;
    const developerToken =
      optionalString(credential?.payload.developerToken) ??
      optionalString(process.env.GOOGLE_ADS_DEVELOPER_TOKEN);
    if (!developerToken) {
      throw new ConnectorApiError(
        this.displayName,
        "config_missing",
        "Google Ads needs a developer token: set GOOGLE_ADS_DEVELOPER_TOKEN (Google Ads API Center) before live calls.",
      );
    }
    const login =
      optionalString(args.loginCustomerId) ??
      optionalString(ctx.projectConfig?.loginCustomerId) ??
      optionalString(credential?.payload.loginCustomerId);
    return {
      ...base,
      developerToken,
      ...(login ? { loginCustomerId: normalizeCustomerId(login, "loginCustomerId") } : {}),
    };
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    if (!tokenSourceFrom(credential, ctx)) return this.mockInvoke(tool, args, ctx);
    try {
      const auth = this.adsAuth(credential, ctx, args);
      if (!auth) return this.mockInvoke(tool, args, ctx);
      switch (tool) {
        case "list_accounts":
          return liveOk(await googleAdsListAccounts(auth, this.deps));
        case "campaign_report": {
          const customerId = normalizeCustomerId(args.customerId ?? ctx.projectConfig?.customerId);
          const campaigns = await googleAdsCampaignReport(auth, { customerId, dateRange: args.dateRange }, this.deps);
          return liveOk({ customerId, dateRange: args.dateRange ?? "LAST_30_DAYS", campaigns });
        }
        case "keyword_report": {
          const customerId = normalizeCustomerId(args.customerId ?? ctx.projectConfig?.customerId);
          const campaignId = String(args.campaignId ?? "").trim();
          const keywords = await googleAdsKeywordReport(
            auth,
            { customerId, campaignId, dateRange: args.dateRange },
            this.deps,
          );
          return liveOk({ customerId, campaignId, keywords });
        }
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return liveFailure(err, this.displayName);
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    try {
      const auth = this.adsAuth(credential, ctx);
      if (!auth) return { ok: false, error: "No access token stored.", errorCode: "not_connected" };
      const ids = await googleAdsListAccessible(auth, this.deps);
      return liveOk({ reachable: true, accounts: ids.length });
    } catch (err) {
      return liveFailure(err, this.displayName);
    }
  }

  private mockInvoke(tool: string, args: Record<string, unknown>, ctx: InvokeContext): InvokeResult {
    const customerId =
      (args.customerId as string | undefined) ??
      (ctx.projectConfig?.customerId as string | undefined) ??
      "1234567890";
    switch (tool) {
      case "list_accounts":
        return mockOk([
          { id: "1234567890", name: "Harbor Dental Studio (MOCK)", currency: "USD", mock: true },
          { id: "0987654321", name: "Harbor Dental — Display (MOCK)", currency: "USD", mock: true },
        ]);
      case "campaign_report":
        return mockOk({
          customerId,
          dateRange: args.dateRange ?? "LAST_30_DAYS",
          campaigns: [
            { id: "g_camp_1", name: "Implants — Exact (MOCK)", status: "ENABLED", impressions: 42110, clicks: 2012, cost: 3118.45, conversions: 96, ctr: 0.0478, avgCpc: 1.55, mock: true },
            { id: "g_camp_2", name: "Whitening — Phrase (MOCK)", status: "ENABLED", impressions: 28804, clicks: 1104, cost: 1480.2, conversions: 41, ctr: 0.0383, avgCpc: 1.34, mock: true },
            { id: "g_camp_3", name: "Brand Terms (MOCK)", status: "PAUSED", impressions: 9021, clicks: 610, cost: 244.9, conversions: 28, ctr: 0.0676, avgCpc: 0.4, mock: true },
          ],
          mock: true,
        });
      case "keyword_report":
        return mockOk({
          customerId,
          campaignId: args.campaignId,
          keywords: [
            { keyword: "dental implants greenville nc (MOCK)", matchType: "EXACT", impressions: 8210, clicks: 512, cost: 891.2, conversions: 31, avgPosition: 1.9, mock: true },
            { keyword: "emergency dentist near me (MOCK)", matchType: "PHRASE", impressions: 12044, clicks: 488, cost: 712.4, conversions: 22, avgPosition: 2.4, mock: true },
            { keyword: "teeth whitening cost (MOCK)", matchType: "EXACT", impressions: 6902, clicks: 244, cost: 322.1, conversions: 9, avgPosition: 3.1, mock: true },
          ],
          mock: true,
        });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
