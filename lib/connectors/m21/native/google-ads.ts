// Marketr — M21 Google Ads adapter.
//
// LIVE WIRING (not yet implemented): this adapter is MOCK-ONLY today. The
// live pass must call the Google Ads API (REST or google-ads client lib):
//   GET https://googleads.googleapis.com/v17/customers:listAccessibleCustomers
//     → list_accounts()
//   POST https://googleads.googleapis.com/v17/customers/{customerId}/googleAds:search
//     GAQL: SELECT campaign.name, campaign.status, metrics.impressions,
//           metrics.clicks, metrics.cost_micros, metrics.conversions
//           FROM campaign WHERE segments.date DURING LAST_30_DAYS
//     → campaign_report()
// Auth: OAuth2 Bearer access_token (scope adwords) + a developer token
// (stored in the credential payload as developerToken) + a login customer
// id for MCC setups. Refresh via lib/vault/refresh.ts. Docs:
// https://developers.google.com/google-ads/api/docs/start
//
// MOCK MODE: deterministic demo account data; every row flagged mock: true,
// names carry "(MOCK)". No network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, mockOk, fail } from "../types";

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
            dateRange: strProp("e.g. LAST_30_DAYS, LAST_7_DAYS."),
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
          },
          required: ["customerId", "campaignId"],
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    _credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
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
