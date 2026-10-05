// ShapesOS — Phase 15.4 (zernio): the Zernio connector (28th built-in).
//
// LIVE WIRING: a PLATFORM key (ZERNIO_API_KEY, LIVE / pre-added — no
// per-customer credential, so authType is "none" and the vault holds
// nothing). Every call is scoped to the workspace's own Zernio profile and
// every account / ad account / campaign id is checked to be that
// workspace's before use (lib/zernio/tenancy.ts):
//   accounts            listAccounts + getAllAccountsHealth (?profileId=)
//   ads_accounts        listAdAccounts
//   ads_campaigns       getAdTree (?profileId=)
//   ads_insights        getCampaignAnalytics (after the campaign ownership check)
//   ads_create          createStandaloneAd — validateOnly dry run first (the
//                       proposal shows it), real create after the person confirms
//   ads_pause           updateAdCampaignStatus { status: paused }
//   ads_resume          updateAdCampaignStatus { status: active }
//   ads_update_budget   updateAdCampaign { budget } — raise vs lower decided
//                       from a live read (getAdAccountLiveEntities)
//   ads_create_lead_form createLeadForm
//   ads_create_audience  createAdAudience
// Tiers (lib/agents/grants.ts connectorAction, enforced by
// lib/zernio/__tests__/zernio-tiers.test.ts): reads Tier 0; create Tier 3
// (buy_media); pause Tier 2; resume Tier 3; budget raise Tier 3, lower Tier 2;
// lead forms and audiences Tier 2. Social posts are NOT a tool here: they go
// through the social service and its approvals (lib/social/zernio.ts).
//
// MOCK MODE (no ZERNIO_API_KEY, fakes allowed — dev / tests / demo): the same
// code runs against the labelled FAKE Zernio (lib/zernio/fake.ts); every
// result is flagged mock: true and every invented name says "(MOCK)". In
// production without the key every tool answers "Zernio is not connected".

import type { ConnectorAdapter, ConnectorToolDef, DecryptedCredential, InvokeContext, InvokeResult } from "../types";
import { fail, numProp, strProp } from "../types";
import { liveFailure } from "../live/http";
import { notConnectedResult } from "../no-fakes";
import type { ZernioClient } from "@/lib/zernio/client";
import { ZernioNotConfiguredError, activeZernioMode } from "@/lib/zernio/config";
import type { ZernioScope } from "@/lib/zernio/tenancy";

// The tenancy / ads modules need the database: imported on first use, so
// importing the connector registry never opens a Prisma client.
const tenancy = () => import("@/lib/zernio/tenancy");
const ads = () => import("@/lib/zernio/ads");

const objProp = (description: string) => ({ type: "object", description });

export const ZERNIO_TOOLS: ConnectorToolDef[] = [
  {
    name: "accounts",
    description: "List the social and ads accounts connected to this workspace's Zernio profile, with their health.",
    mutating: false,
    argsSchema: { type: "object", properties: {} },
  },
  {
    name: "ads_accounts",
    description: "List the platform ad accounts (Meta act_…, Google customer ids, TikTok advertisers …) under this workspace's Zernio ads connections.",
    mutating: false,
    argsSchema: { type: "object", properties: { accountId: strProp("Optional Zernio ads account id (from accounts); omit for all of them.") } },
  },
  {
    name: "ads_campaigns",
    description: "Campaign, ad set and ad tree with rolled-up metrics for this workspace's ad accounts (Meta, Google, TikTok, LinkedIn, Pinterest, X, OpenAI).",
    mutating: false,
    argsSchema: {
      type: "object",
      properties: {
        accountId: strProp("Optional Zernio ads account id."),
        adAccountId: strProp("Optional platform ad account id (act_…)."),
        fromDate: strProp("YYYY-MM-DD (default 90 days ago)."),
        toDate: strProp("YYYY-MM-DD (default today)."),
        limit: numProp("Campaigns to return (1–100, default 20)."),
      },
    },
  },
  {
    name: "ads_insights",
    description: "Performance analytics for one campaign: summary metrics and a daily timeline.",
    mutating: false,
    argsSchema: {
      type: "object",
      properties: {
        campaignId: strProp("Platform campaign id (platformCampaignId from ads_campaigns)."),
        platform: strProp("facebook, instagram, google, tiktok, linkedin, pinterest, twitter or openai (when the id is ambiguous)."),
        fromDate: strProp("YYYY-MM-DD."),
        toDate: strProp("YYYY-MM-DD."),
      },
      required: ["campaignId"],
    },
  },
  {
    name: "ads_create",
    description:
      "Create a paid ad (campaign, ad set and ad) on one of this workspace's ad accounts. A dry run validates the exact ad first; it is created only after you confirm, PAUSED unless status is ACTIVE. Spends money.",
    mutating: true,
    argsSchema: {
      type: "object",
      properties: {
        ad: objProp(
          "The ad, as Zernio's createStandaloneAd fields: accountId (Zernio ads account), adAccountId, name, goal, budgetAmount (WHOLE currency units, 50 = $50.00), budgetType (daily | lifetime), headline, body, linkUrl, imageUrl, callToAction, countries, status (PAUSED default).",
        ),
      },
      required: ["ad"],
    },
  },
  {
    name: "ads_pause",
    description: "Pause a campaign on its ad network so it stops delivering. Resuming it is a separate step.",
    mutating: true,
    argsSchema: {
      type: "object",
      properties: { campaignId: strProp("Platform campaign id."), platform: strProp("The campaign's platform (when the id is ambiguous).") },
      required: ["campaignId"],
    },
  },
  {
    name: "ads_resume",
    description: "Resume a paused campaign so it delivers again. It restarts spend on the ad network, so it always asks.",
    mutating: true,
    argsSchema: {
      type: "object",
      properties: { campaignId: strProp("Platform campaign id."), platform: strProp("The campaign's platform (when the id is ambiguous).") },
      required: ["campaignId"],
    },
  },
  {
    name: "ads_update_budget",
    description: "Change a campaign's daily or lifetime budget (whole currency units). Raising it always asks; lowering it can run under an auto-approve rule.",
    mutating: true,
    argsSchema: {
      type: "object",
      properties: {
        campaignId: strProp("Platform campaign id."),
        platform: strProp("facebook, instagram or google."),
        amount: numProp("The new budget in WHOLE currency units (8 = $8.00)."),
        type: strProp("daily (default) or lifetime."),
      },
      required: ["campaignId", "amount"],
    },
  },
  {
    name: "ads_create_lead_form",
    description: "Create a lead form on a Facebook Page or a LinkedIn ads account (questions and a privacy policy link).",
    mutating: true,
    argsSchema: {
      type: "object",
      properties: {
        accountId: strProp("Zernio account id (facebook, metaads or linkedinads)."),
        adAccountId: strProp("LinkedIn ad account id (LinkedIn only)."),
        name: strProp("Form name."),
        privacyPolicyUrl: strProp("https link to your privacy policy."),
        platformSpecificData: objProp("The form content (questions, thank-you screen …) in Zernio's platformSpecificData shape."),
      },
      required: ["accountId", "name", "privacyPolicyUrl"],
    },
  },
  {
    name: "ads_create_audience",
    description: "Create a custom audience (customer list, website visitors, lookalike …) on one of this workspace's ad accounts.",
    mutating: true,
    argsSchema: {
      type: "object",
      properties: {
        accountId: strProp("Zernio ads account id."),
        adAccountId: strProp("Platform ad account id (not needed for saved_targeting)."),
        name: strProp("Audience name."),
        type: strProp("customer_list, website, lookalike, meta_engagement, saved_targeting, …"),
        settings: objProp("Type-specific fields (pixelId, retentionDays, ratio, seed audience …)."),
      },
      required: ["accountId", "name", "type"],
    },
  },
];

export const ZERNIO_READ_TOOLS: ReadonlySet<string> = new Set(ZERNIO_TOOLS.filter((t) => !t.mutating).map((t) => t.name));

function ok(scope: ZernioScope, data: unknown): InvokeResult {
  return { ok: true, data, mock: scope.mode === "mock" };
}

function failure(err: unknown): InvokeResult {
  if (err instanceof ZernioNotConfiguredError) return notConnectedResult("Zernio");
  // ZernioScopeError (lib/zernio/tenancy.ts): an id that is not this workspace's.
  if (err instanceof Error && err.name === "ZernioScopeError") return { ok: false, error: err.message, errorCode: "forbidden", mock: false };
  return liveFailure(err, "Zernio");
}

export class ZernioAdapter implements ConnectorAdapter {
  readonly key = "zernio";
  readonly displayName = "Zernio";
  /** Platform key: the customer brings no credential (ZERNIO_API_KEY is server-side). */
  readonly authType = "none" as const;
  readonly configSchema = { type: "object", properties: {} };

  constructor(private readonly deps: { client?: ZernioClient } = {}) {}

  listTools(): ConnectorToolDef[] {
    return ZERNIO_TOOLS.map((t) => ({ ...t }));
  }

  private async scope(ctx: InvokeContext): Promise<ZernioScope> {
    return (await tenancy()).getZernioScope(ctx.workspaceId, { client: this.deps.client, userId: ctx.userId });
  }

  private off(): boolean {
    return !this.deps.client && activeZernioMode() === "off";
  }

  async invoke(tool: string, args: Record<string, unknown>, _credential: DecryptedCredential | null, ctx: InvokeContext): Promise<InvokeResult> {
    if (!ZERNIO_TOOLS.some((t) => t.name === tool)) return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    if (this.off()) return notConnectedResult("Zernio");
    try {
      const scope = await this.scope(ctx);
      const {
        campaignInsights, campaignTree, createAd, createAudience, createLeadForm, listAdAccountsForWorkspace, setCampaignStatus, updateCampaignBudget,
      } = await ads();
      switch (tool) {
        case "accounts":
          return ok(scope, { profileId: scope.profileId, accounts: await (await tenancy()).syncZernioAccounts(scope) });
        case "ads_accounts":
          return ok(scope, await listAdAccountsForWorkspace(scope, args));
        case "ads_campaigns":
          return ok(scope, await campaignTree(scope, args));
        case "ads_insights":
          return ok(scope, await campaignInsights(scope, args));
        case "ads_create": {
          const out = await createAd(scope, args);
          return ok(scope, { ...out, validationNote: out.validation === "unsupported" ? "created without a platform dry run (not available on this network)" : "dry run passed before the create" });
        }
        case "ads_pause":
          return ok(scope, await setCampaignStatus(scope, args, "paused"));
        case "ads_resume":
          return ok(scope, await setCampaignStatus(scope, args, "active"));
        case "ads_update_budget":
          return ok(scope, await updateCampaignBudget(scope, args));
        case "ads_create_lead_form":
          return ok(scope, await createLeadForm(scope, args));
        case "ads_create_audience":
          return ok(scope, await createAudience(scope, args));
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return failure(err);
    }
  }

  /**
   * ads_update_budget is "update_campaign_budget" (Tier 3) unless a live read
   * shows the new budget is not higher — then "lower_campaign_budget" (Tier 2).
   * Any error keeps the Tier-3 default (null).
   */
  async resolveAction(tool: string, args: Record<string, unknown>, ctx: InvokeContext): Promise<string | null> {
    if (tool !== "ads_update_budget" || this.off()) return null;
    try {
      const d = await (await ads()).budgetDirection(await this.scope(ctx), args);
      return d.direction === "lower" ? "lower_campaign_budget" : "update_campaign_budget";
    } catch {
      return null;
    }
  }

  /** ads_create: the validateOnly dry run shown with the proposal; a failed dry run is never proposed. */
  async preflight(tool: string, args: Record<string, unknown>, ctx: InvokeContext): Promise<InvokeResult | null> {
    if (tool === "ads_update_budget") {
      if (this.off()) return notConnectedResult("Zernio");
      try {
        const scope = await this.scope(ctx);
        const d = await (await ads()).budgetDirection(scope, args);
        return ok(scope, { summary: d.reason, direction: d.direction });
      } catch (err) {
        return failure(err);
      }
    }
    if (tool !== "ads_create") return null;
    if (this.off()) return notConnectedResult("Zernio");
    try {
      const scope = await this.scope(ctx);
      const dry = await (await ads()).dryRunCreateAd(scope, args);
      if (dry.status === "failed") return { ok: false, error: dry.message, errorCode: "bad_request", mock: scope.mode === "mock" };
      return ok(scope, { summary: `${dry.plan.summary}. ${dry.message}`, dryRun: dry.status, validationId: dry.validationId });
    } catch (err) {
      return failure(err);
    }
  }

  /** Cheap liveness: the workspace's profile on Zernio (getProfile). */
  async healthCheck(_credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    if (this.off()) return notConnectedResult("Zernio");
    try {
      const scope = await this.scope(ctx);
      const p = await scope.client.getProfile(scope.profileId);
      return ok(scope, { profileId: p._id, rateLimit: scope.client.lastRateLimit });
    } catch (err) {
      return failure(err);
    }
  }
}

