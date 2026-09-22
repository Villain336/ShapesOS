// Marketr — M21 Meta Ads adapter.
//
// LIVE WIRING (not yet implemented): this adapter is MOCK-ONLY today. The
// live pass must call the Meta Marketing API (Graph API v19+):
//   GET  https://graph.facebook.com/v21.0/me/adaccounts?fields=name,account_id,account_status
//     → list_ad_accounts()
//   GET  https://graph.facebook.com/v21.0/act_{accountId}/insights?date_preset=last_30d&fields=spend,impressions,clicks,ctr,actions
//     → account_insights()
//   GET  https://graph.facebook.com/v21.0/act_{accountId}/campaigns?fields=name,status,objective,effective_status
//     → list_campaigns()
//   GET  https://graph.facebook.com/v21.0/{campaignId}/insights?fields=spend,impressions,clicks,ctr,actions&breakdowns=...
//     → campaign_insights()
// Auth: OAuth2 Bearer access_token (scopes ads_read, ads_management via
// Facebook Login); refresh via lib/vault/refresh.ts. Note: Marketr already
// has a Meta ADS data path in lib/ads (M21 part A); the live pass should
// reuse that code rather than duplicating Graph calls. Docs:
// https://developers.facebook.com/docs/marketing-api
//
// MOCK MODE: deterministic demo ad account data; every row flagged
// mock: true, names carry "(MOCK)". No network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, mockOk, fail } from "../types";

export class MetaAdsAdapter implements ConnectorAdapter {
  readonly key = "meta-ads";
  readonly displayName = "Meta Ads";
  readonly authType = "oauth2" as const;
  readonly configSchema = {
    type: "object",
    properties: {
      adAccountId: {
        type: "string",
        description: "Default Meta ad account id (act_123…). Also accepted per-project via ProjectDataSource.projectConfig.",
      },
    },
  };

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_ad_accounts",
        description: "List Meta ad accounts the connected user can access.",
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "account_insights",
        description: "Aggregate spend/impressions/clicks/leads for an ad account over a date preset.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            adAccountId: strProp("Meta ad account id (act_123…)."),
            datePreset: strProp("e.g. last_30d, last_7d, this_month."),
          },
          required: ["adAccountId"],
        },
      },
      {
        name: "list_campaigns",
        description: "List campaigns in an ad account with status and objective.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { adAccountId: strProp("Meta ad account id (act_123…).") },
          required: ["adAccountId"],
        },
      },
      {
        name: "campaign_insights",
        description: "Spend and performance breakdown for one campaign.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { campaignId: strProp("Meta campaign id.") },
          required: ["campaignId"],
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
    const adAccountId =
      (args.adAccountId as string | undefined) ??
      (ctx.projectConfig?.adAccountId as string | undefined) ??
      "act_123456789";
    switch (tool) {
      case "list_ad_accounts":
        return mockOk([
          { id: "act_123456789", name: "Harbor Dental Studio (MOCK)", accountStatus: 1, currency: "USD", mock: true },
          { id: "act_987654321", name: "Harbor Dental — Retargeting (MOCK)", accountStatus: 1, currency: "USD", mock: true },
        ]);
      case "account_insights":
        return mockOk({
          adAccountId,
          datePreset: args.datePreset ?? "last_30d",
          spend: 2480.55,
          impressions: 184203,
          clicks: 4211,
          ctr: 0.0229,
          leads: 187,
          costPerLead: 13.27,
          mock: true,
        });
      case "list_campaigns":
        return mockOk({
          adAccountId,
          campaigns: [
            { id: "camp_1", name: "Implants — Search Intent (MOCK)", status: "ACTIVE", objective: "LEAD_GENERATION", mock: true },
            { id: "camp_2", name: "Whitening — Broad (MOCK)", status: "ACTIVE", objective: "LINK_CLICKS", mock: true },
            { id: "camp_3", name: "Brand — Retargeting (MOCK)", status: "PAUSED", objective: "BRAND_AWARENESS", mock: true },
          ],
          mock: true,
        });
      case "campaign_insights":
        return mockOk({
          campaignId: args.campaignId,
          spend: 912.4,
          impressions: 70210,
          clicks: 1840,
          ctr: 0.0262,
          leads: 74,
          costPerLead: 12.33,
          mock: true,
        });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
