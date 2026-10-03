// ShapesOS — M21 Meta Ads adapter.
//
// LIVE WIRING (Phase 4b): with a vault credential this adapter calls the
// Meta Marketing API on a versioned Graph URL (default v26.0,
// META_GRAPH_API_VERSION overrides; lib/connectors/m21/live/meta-ads.ts):
//   GET /me/adaccounts?fields=id,name,account_id,account_status,currency
//     → list_ad_accounts() (cursor paging)
//   GET /act_{id}/insights?level=account&date_preset=…&fields=spend,impressions,clicks,ctr,cpc,actions
//     → account_insights()
//   GET /act_{id}/campaigns?fields=id,name,status,effective_status,objective
//     → list_campaigns() (cursor paging, max 500)
//   GET /{campaignId}/insights → campaign_insights()
//   GET /me?fields=id → health check
// Auth: Facebook Login user token (scope ads_read) as Bearer, plus
// appsecret_proof when the app secret is known. Meta issues no refresh
// tokens: an invalid token (error 190) flips the connection to
// needs_reauth. Throttling codes (4/17/32/613/80000-80014) back off and retry.
// Docs: https://developers.facebook.com/docs/marketing-api/insights
//
// MOCK MODE (no credential): deterministic demo ad account data; every row
// flagged mock: true, names carry "(MOCK)". No network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, mockOk, liveOk, fail } from "../types";
import { liveFailure, tokenSourceFrom, type LiveDeps } from "../live/http";
import {
  metaAccountInsights,
  metaCampaignInsights,
  metaListAdAccounts,
  metaListCampaigns,
  metaPing,
  normalizeAdAccountId,
  normalizeDatePreset,
  normalizeGraphId,
  type MetaAuth,
} from "../live/meta-ads";

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

  constructor(private readonly deps: LiveDeps = {}) {}

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
          properties: {
            campaignId: strProp("Meta campaign id."),
            datePreset: strProp("e.g. last_30d (default), last_7d, this_month."),
          },
          required: ["campaignId"],
        },
      },
    ];
  }

  private metaAuth(credential: DecryptedCredential | null, ctx: InvokeContext): MetaAuth | null {
    const base = tokenSourceFrom(credential, ctx);
    if (!base) return null;
    const fromPayload = credential?.payload.client_secret;
    const appSecret =
      typeof fromPayload === "string" && fromPayload
        ? fromPayload
        : (process.env.META_OAUTH_CLIENT_SECRET ?? "").trim() || undefined;
    return { ...base, ...(appSecret ? { appSecret } : {}) };
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const auth = this.metaAuth(credential, ctx);
    if (!auth) return this.mockInvoke(tool, args, ctx);
    try {
      switch (tool) {
        case "list_ad_accounts":
          return liveOk(await metaListAdAccounts(auth, this.deps));
        case "account_insights":
          return liveOk(
            await metaAccountInsights(
              auth,
              normalizeAdAccountId(args.adAccountId ?? ctx.projectConfig?.adAccountId),
              normalizeDatePreset(args.datePreset),
              this.deps,
            ),
          );
        case "list_campaigns": {
          const adAccountId = normalizeAdAccountId(args.adAccountId ?? ctx.projectConfig?.adAccountId);
          return liveOk({ adAccountId, campaigns: await metaListCampaigns(auth, adAccountId, this.deps) });
        }
        case "campaign_insights":
          return liveOk(
            await metaCampaignInsights(
              auth,
              normalizeGraphId(args.campaignId, "campaignId"),
              normalizeDatePreset(args.datePreset),
              this.deps,
            ),
          );
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return liveFailure(err, this.displayName);
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = this.metaAuth(credential, ctx);
    if (!auth) return { ok: false, error: "No access token stored.", errorCode: "not_connected" };
    try {
      return liveOk(await metaPing(auth, this.deps));
    } catch (err) {
      return liveFailure(err, this.displayName);
    }
  }

  private mockInvoke(tool: string, args: Record<string, unknown>, ctx: InvokeContext): InvokeResult {
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
