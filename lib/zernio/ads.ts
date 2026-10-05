// ShapesOS — Phase 15.4 (zernio): paid ads through Zernio, scoped to the
// workspace's profile.
//
// Money rules (owner, 2026-10-05 — "ads creation and budget increases are
// money"):
//   - Creating an ad is Tier 3 (buy_media): never automated, always asks.
//     A validateOnly dry run of the EXACT payload (createStandaloneAd with
//     validateOnly: true) runs before the person is asked, and the real create
//     runs only after they confirm, only for a payload whose dry run passed —
//     or that the platform cannot dry-run (Zernio answers 501
//     feature_not_available outside Meta, Google PMax / Demand Gen and OpenAI;
//     the proposal says so plainly). A failed dry run never creates.
//   - One dry run per real create (Meta counts validateOnly as a write and
//     allows 30 creates per ad account per rolling 5 minutes): the receipt in
//     zernio_ad_validations is consumed by exactly one create, and creates for
//     one ad account run one at a time (advisory lock), honouring Retry-After.
//   - New ads are created PAUSED unless the request says ACTIVE.
//   - Pausing stops delivery (Tier 2); resuming restarts it (Tier 3).
//   - A budget change is Tier 3 when it raises spend and Tier 2 only when a
//     LIVE read of the current budget (getAdAccountLiveEntities, Meta) shows
//     the new amount is not higher in the same budget type. Anything we cannot
//     read live (Google, a type change, a missing budget) counts as a raise.

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { ZernioError } from "./client";
import {
  ZERNIO_BUDGET_UPDATE_PLATFORMS,
  campaignPlatformForAccount,
  type ZernioBudget,
  type ZernioCampaignDoc,
} from "./spec";
import {
  ZernioScopeError,
  requireOwnedAccount,
  requireOwnedAdAccount,
  requireOwnedCampaign,
  type ZernioScope,
} from "./tenancy";

/** How long a passing dry run stays usable for its create. */
export const AD_VALIDATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * createStandaloneAd request properties ShapesOS forwards (the spec's
 * requestBody property list); anything else the model sends is dropped, and
 * validateOnly is always set by this module, never by the caller.
 */
const CREATE_AD_FIELDS = new Set([
  "accountId", "adAccountId", "name", "campaignName", "adSetName", "adName", "tracking", "goal", "smartTargeting",
  "optimizationGoal", "billingEvent", "buyingType", "rfPredictionId", "creativeFeatures", "multiAdvertiser", "aiDisclosure",
  "budgetAmount", "budgetType", "status", "campaignStatus", "adSetStatus", "adStatus", "budgetLevel", "currency", "headline",
  "longHeadline", "body", "description", "bodies", "headlines", "descriptions", "callToAction", "linkUrl", "leadGenFormId",
  "imageUrl", "images", "video", "creatives", "adSetId", "existingCampaignId", "phoneNumber", "existingCreativeId",
  "businessName", "boardId", "organizationId", "targeting", "countries", "countryGroups", "cities", "regions", "ageMin",
  "ageMax", "interests", "zips", "metros", "customLocations", "behaviors", "workPositions", "workEmployers", "workIndustries",
  "incomeTier", "languages", "placements", "savedTargetingId", "rawTargeting", "specialAdCategories", "specialAdCategoryCountry",
  "regionalRegulatedCategories", "regionalRegulationIdentities", "endDate", "startDate", "pageId", "instagramAccountId",
  "dynamicCreative", "carouselCards", "defaultLocale", "translations", "placementAssets", "audienceId", "campaignType",
  "locationTargetingType", "assetGroup", "demandGen", "keywords", "negativeKeywords", "campaignNegativeKeywords",
  "additionalHeadlines", "additionalDescriptions", "sitelinks", "callouts", "structuredSnippets", "advantageAudience",
  "attributionSpec", "gender", "bidStrategy", "bidAmount", "roasAverageFloor", "portfolioBidStrategyId", "valueRuleSetId",
  "valueRulesApplied", "platformSpecificData", "dsaBeneficiary", "dsaPayor", "brandIdentity", "identityId", "identityType",
  "smartPlus", "userOs", "userDevice", "isSkadnetworkAttribution", "campaignAttribution", "promotedObject",
]);

/** The model sends the ad either as an `ad` object/JSON string or as flat args. */
function adSpecFrom(args: Record<string, unknown>): Record<string, unknown> {
  let spec: unknown = args.ad ?? args;
  if (typeof spec === "string") {
    try {
      spec = JSON.parse(spec);
    } catch {
      throw new ZernioScopeError("The ad must be a JSON object (createStandaloneAd fields).");
    }
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new ZernioScopeError("The ad must be a JSON object.");
  return spec as Record<string, unknown>;
}

export interface CreateAdPlan {
  body: Record<string, unknown>;
  hash: string;
  platform: string;
  accountId: string;
  adAccountId: string;
  /** Plain-words summary for the proposal. */
  summary: string;
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export function payloadHash(body: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(stable(body))).digest("hex");
}

/**
 * Build the createStandaloneAd body from the model's spec (whitelisted
 * fields, PAUSED unless ACTIVE is asked for) — PURE, no ownership checks.
 */
export function buildCreateAdBody(args: Record<string, unknown>): Record<string, unknown> {
  const spec = adSpecFrom(args);
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec)) {
    if (CREATE_AD_FIELDS.has(k) && v !== undefined && v !== null) body[k] = v;
  }
  for (const f of ["accountId", "adAccountId", "name"]) {
    if (typeof body[f] !== "string" || !String(body[f]).trim()) throw new ZernioScopeError(`The ad needs ${f}.`);
  }
  const attach = typeof body.adSetId === "string" || typeof body.existingCampaignId === "string";
  if (!attach) {
    if (typeof body.budgetAmount !== "number" || !Number.isFinite(body.budgetAmount) || body.budgetAmount <= 0) {
      throw new ZernioScopeError("The ad needs budgetAmount: a positive number in WHOLE currency units (50 = $50.00, not cents).");
    }
    if (body.budgetType !== "daily" && body.budgetType !== "lifetime") throw new ZernioScopeError('The ad needs budgetType "daily" or "lifetime".');
  }
  if (body.status !== "ACTIVE" && body.status !== "PAUSED") body.status = "PAUSED";
  delete body.validateOnly;
  return body;
}

function planSummary(body: Record<string, unknown>, platform: string): string {
  const budget =
    typeof body.budgetAmount === "number" ? `${body.budgetAmount} ${String(body.currency ?? "(account currency)")} ${String(body.budgetType)}` : "inherited from the existing ad set";
  return `"${String(body.name)}" on ${platform} (ad account ${String(body.adAccountId)}), budget ${budget}, created ${body.status === "ACTIVE" ? "ACTIVE — it starts delivering" : "PAUSED — nothing delivers until it is resumed"}`;
}

/** Ownership-checked plan: the account and ad account are this workspace's. */
export async function planCreateAd(scope: ZernioScope, args: Record<string, unknown>): Promise<CreateAdPlan> {
  const body = buildCreateAdBody(args);
  const account = await requireOwnedAccount(scope, body.accountId, { category: "ads" });
  const adAccountId = await requireOwnedAdAccount(scope, account, body.adAccountId);
  const platform = campaignPlatformForAccount(account.platform) ?? account.platform;
  return { body, hash: payloadHash(body), platform, accountId: account.accountId, adAccountId, summary: planSummary(body, platform) };
}

/** Run fn holding the per-ad-account create lock (Zernio: send creates for one ad account sequentially). */
async function withAdAccountLock<T>(scope: ZernioScope, adAccountId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return withWorkspaceScope(
    scope.workspaceId,
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`zernio-adcreate:${scope.mode}:${adAccountId}`}, 0))`;
      return fn(tx as unknown as Prisma.TransactionClient);
    },
    { timeoutMs: 180_000 },
  );
}

export type DryRunStatus = "passed" | "unsupported" | "failed";

export interface DryRunOutcome {
  status: DryRunStatus;
  validationId: string | null;
  message: string;
  plan: CreateAdPlan;
  retryAfterSec?: number | null;
}

async function runDryRun(scope: ZernioScope, plan: CreateAdPlan, tx: Prisma.TransactionClient): Promise<DryRunOutcome> {
  let status: DryRunStatus;
  let message: string;
  let result: Record<string, unknown> = {};
  let retryAfterSec: number | null = null;
  try {
    const r = await scope.client.validateStandaloneAd(plan.body);
    status = "passed";
    const nodes = (r.results ?? []).map((n) => `${n.node} ${n.status}${n.reason ? ` (${n.reason})` : ""}`).join(", ");
    message = `Dry run passed on ${plan.platform}${nodes ? `: ${nodes}` : ""}. Nothing was created.`;
    result = r as unknown as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ZernioError && e.status === 501 && e.zernioCode === "feature_not_available") {
      status = "unsupported";
      message = `Zernio cannot dry-run ads on ${plan.platform} (validateOnly is Meta, Google Performance Max / Demand Gen and OpenAI only), so this create goes out unvalidated if you confirm.`;
      result = { code: e.zernioCode };
    } else if (e instanceof ZernioError && e.code === "rate_limited") {
      // Not a verdict on the ad: no receipt is stored, the person is told when to retry.
      retryAfterSec = e.retryAfterSec;
      return {
        status: "failed",
        validationId: null,
        message: `Zernio is limiting ad writes on this ad account${e.retryAfterSec ? ` — try again in ${e.retryAfterSec} s` : ""}. Nothing was created.`,
        plan,
        retryAfterSec,
      };
    } else if (e instanceof ZernioError) {
      status = "failed";
      message = `The dry run failed, so nothing will be created: ${e.message}`;
      result = { status: e.status ?? null, code: e.zernioCode, details: e.details };
    } else {
      throw e;
    }
  }
  const row = await tx.zernioAdValidation.create({
    data: {
      workspaceId: scope.workspaceId,
      payloadHash: plan.hash,
      accountId: plan.accountId,
      adAccountId: plan.adAccountId,
      status,
      result: result as Prisma.InputJsonValue,
    },
  });
  return { status, validationId: row.id, message, plan, retryAfterSec };
}

/**
 * The dry run the proposal shows (validateOnly). Called BEFORE the person is
 * asked; a failed dry run means no proposal at all.
 */
export async function dryRunCreateAd(scope: ZernioScope, args: Record<string, unknown>): Promise<DryRunOutcome> {
  const plan = await planCreateAd(scope, args);
  return withAdAccountLock(scope, plan.adAccountId, (tx) => runDryRun(scope, plan, tx));
}

export interface CreateAdOutcome {
  created: true;
  validation: DryRunStatus;
  ad: unknown;
  summary: string;
}

/**
 * The real create (after the person confirmed). Needs an unused passing (or
 * platform-unsupported) dry run of the same payload from the last 24 h; when
 * there is none it runs the dry run first. Exactly one create consumes a
 * receipt; the create carries an Idempotency-Key derived from it, so a
 * network retry can never place a second ad.
 */
export async function createAd(scope: ZernioScope, args: Record<string, unknown>): Promise<CreateAdOutcome> {
  const plan = await planCreateAd(scope, args);
  return withAdAccountLock(scope, plan.adAccountId, async (tx) => {
    const since = new Date(Date.now() - AD_VALIDATION_TTL_MS);
    let receipt = await tx.zernioAdValidation.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        payloadHash: plan.hash,
        status: { in: ["passed", "unsupported"] },
        consumedAt: null,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
    });
    let validation: DryRunStatus;
    if (!receipt) {
      const dry = await runDryRun(scope, plan, tx);
      if (dry.status === "failed" || !dry.validationId) throw new ZernioScopeError(dry.message);
      receipt = await tx.zernioAdValidation.findUniqueOrThrow({ where: { id: dry.validationId } });
    }
    validation = receipt.status as DryRunStatus;
    const claimed = await tx.zernioAdValidation.updateMany({ where: { id: receipt.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (claimed.count !== 1) throw new ZernioScopeError("This ad was already created from its dry run.");
    const r = await scope.client.createStandaloneAd(plan.body, { idempotencyKey: `shapesos-ad-${receipt.id}` });
    return { created: true as const, validation, ad: r.data, summary: plan.summary };
  });
}

// ---------------------------------------------------------------------------
// Status and budget
// ---------------------------------------------------------------------------

export async function setCampaignStatus(
  scope: ZernioScope,
  args: Record<string, unknown>,
  status: "active" | "paused",
): Promise<Record<string, unknown>> {
  const c = await requireOwnedCampaign(scope, args.campaignId, args.platform);
  const out = await scope.client.updateAdCampaignStatus(c.platformCampaignId, { status, platform: c.platform });
  return { campaignId: c.platformCampaignId, platform: c.platform, campaignName: c.campaignName ?? null, ...out };
}

export interface BudgetRequest {
  amount: number;
  type: "daily" | "lifetime";
}

export function parseBudgetRequest(args: Record<string, unknown>): BudgetRequest {
  const amount = typeof args.amount === "number" ? args.amount : Number(args.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new ZernioScopeError("amount must be a positive number in WHOLE currency units (8 = $8.00).");
  const type = args.type ?? args.budgetType ?? "daily";
  if (type !== "daily" && type !== "lifetime") throw new ZernioScopeError('type must be "daily" or "lifetime".');
  return { amount, type };
}

export interface BudgetDirection {
  /** "lower" only when a live read proves the new budget is not higher. */
  direction: "lower" | "raise";
  current: ZernioBudget | null;
  currency: string | null;
  reason: string;
  campaign: ZernioCampaignDoc;
}

/**
 * Decide raise vs lower from the CURRENT budget read server-side, never from
 * the model's claim. Only Meta has a live budget read
 * (getAdAccountLiveEntities); everywhere else, and on any doubt, it is a raise.
 */
export async function budgetDirection(scope: ZernioScope, args: Record<string, unknown>): Promise<BudgetDirection> {
  const req = parseBudgetRequest(args);
  const campaign = await requireOwnedCampaign(scope, args.campaignId, args.platform);
  const raise = (reason: string, current: ZernioBudget | null = null, currency: string | null = null): BudgetDirection => ({
    direction: "raise", current, currency, reason, campaign,
  });
  if (campaign.platform !== "facebook" && campaign.platform !== "instagram") {
    return raise(`No live budget read on ${campaign.platform}, so the change is treated as a raise.`);
  }
  if (!campaign.accountId || !campaign.platformAdAccountId) return raise("The campaign's ad account is unknown.");
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const live = await scope.client.getAdAccountLiveCampaigns({ accountId: campaign.accountId, adAccountId: campaign.platformAdAccountId, after });
    const hit = live.campaigns.find((c) => c.platformCampaignId === campaign.platformCampaignId);
    if (hit) {
      const current: ZernioBudget | null =
        hit.budget ??
        (typeof hit.dailyBudget === "number" ? { amount: hit.dailyBudget, type: "daily" } : typeof hit.lifetimeBudget === "number" ? { amount: hit.lifetimeBudget, type: "lifetime" } : null);
      if (!current) return raise("The campaign has no campaign-level budget (its ad sets carry it).", null, live.currency);
      if (current.type !== req.type) return raise(`It changes the budget type (${current.type} → ${req.type}).`, current, live.currency);
      if (req.amount > current.amount) return raise(`It raises the ${current.type} budget from ${current.amount} to ${req.amount} ${live.currency ?? ""}.`.trim(), current, live.currency);
      return {
        direction: "lower",
        current,
        currency: live.currency,
        reason: `It lowers the ${current.type} budget from ${current.amount} to ${req.amount} ${live.currency ?? ""} (read live from Meta).`.trim(),
        campaign,
      };
    }
    if (!live.after) break;
    after = live.after;
  }
  return raise("The campaign's current budget could not be read live.");
}

/** updateAdCampaign (budget) on an owned campaign. The tier was decided before this runs. */
export async function updateCampaignBudget(scope: ZernioScope, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const req = parseBudgetRequest(args);
  const c = await requireOwnedCampaign(scope, args.campaignId, args.platform);
  if (!ZERNIO_BUDGET_UPDATE_PLATFORMS.has(c.platform)) {
    throw new ZernioScopeError(`Zernio changes campaign budgets on Meta and Google only (this campaign is on ${c.platform}).`);
  }
  if (c.budgetLevel === "adset") throw new ZernioScopeError("This campaign's budget lives on its ad sets (ABO); change it there in the ad network.");
  const out = await scope.client.updateAdCampaignBudget(c.platformCampaignId, { platform: c.platform, budget: req });
  return { campaignId: c.platformCampaignId, platform: c.platform, ...out };
}

// ---------------------------------------------------------------------------
// Lead forms and audiences (Tier 2)
// ---------------------------------------------------------------------------

function objectArg(v: unknown, name: string): Record<string, unknown> | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  let o = v;
  if (typeof o === "string") {
    try {
      o = JSON.parse(o);
    } catch {
      throw new ZernioScopeError(`${name} must be a JSON object.`);
    }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new ZernioScopeError(`${name} must be a JSON object.`);
  return o as Record<string, unknown>;
}

/** createLeadForm — on an owned Meta (facebook / metaads) or LinkedIn ads account. */
export async function createLeadForm(scope: ZernioScope, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const account = await requireOwnedAccount(scope, args.accountId);
  if (!["facebook", "metaads", "linkedinads"].includes(account.platform)) {
    throw new ZernioScopeError("Lead forms live on a Facebook Page or a Meta / LinkedIn ads connection.");
  }
  const name = typeof args.name === "string" ? args.name.trim().slice(0, 200) : "";
  const privacyPolicyUrl = typeof args.privacyPolicyUrl === "string" ? args.privacyPolicyUrl.trim() : "";
  if (!name || !/^https:\/\//.test(privacyPolicyUrl)) throw new ZernioScopeError("A lead form needs a name and an https privacyPolicyUrl.");
  const body: Record<string, unknown> = { accountId: account.accountId, name, privacyPolicyUrl };
  const psd = objectArg(args.platformSpecificData, "platformSpecificData");
  if (psd) body.platformSpecificData = psd;
  if (account.platform === "linkedinads") body.adAccountId = await requireOwnedAdAccount(scope, account, args.adAccountId);
  return scope.client.createLeadForm(body);
}

const AUDIENCE_TYPES = new Set([
  "customer_list", "company_list", "engagement", "meta_engagement", "tiktok_engagement", "pinterest_engagement",
  "website", "website_retargeting", "lookalike", "saved_targeting",
]);

/** createAdAudience — on an owned ads account and ad account. */
export async function createAudience(scope: ZernioScope, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const account = await requireOwnedAccount(scope, args.accountId, { category: "ads" });
  const type = typeof args.type === "string" ? args.type : "";
  if (!AUDIENCE_TYPES.has(type)) throw new ZernioScopeError(`type must be one of ${[...AUDIENCE_TYPES].join(", ")}.`);
  const name = typeof args.name === "string" ? args.name.trim().slice(0, 200) : "";
  if (!name) throw new ZernioScopeError("An audience needs a name.");
  const body: Record<string, unknown> = { ...(objectArg(args.settings, "settings") ?? {}), accountId: account.accountId, name, type };
  if (type !== "saved_targeting") body.adAccountId = await requireOwnedAdAccount(scope, account, args.adAccountId);
  return scope.client.createAdAudience(body);
}

// ---------------------------------------------------------------------------
// Reads (Tier 0)
// ---------------------------------------------------------------------------

export async function listAdAccountsForWorkspace(scope: ZernioScope, args: Record<string, unknown>): Promise<unknown> {
  const { mirroredAccounts } = await import("./tenancy");
  const rows = args.accountId
    ? [await requireOwnedAccount(scope, args.accountId, { category: "ads" })]
    : (await mirroredAccounts(scope.workspaceId, scope.mode)).filter((r) => r.category === "ads" && r.status !== "disconnected");
  const out = [];
  for (const r of rows) {
    const adAccounts = await scope.client.listAdAccounts({ accountId: r.accountId });
    await withWorkspaceScope(scope.workspaceId, (tx) => tx.zernioAccount.update({ where: { id: r.id }, data: { adAccountIds: adAccounts.map((a) => a.id) } }));
    out.push({ accountId: r.accountId, platform: r.platform, adAccounts });
  }
  return out;
}

function isoDate(v: unknown): string | undefined {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

export async function campaignTree(scope: ZernioScope, args: Record<string, unknown>): Promise<unknown> {
  if (args.accountId) await requireOwnedAccount(scope, args.accountId, { category: "ads" });
  const tree = await scope.client.getAdTree({
    profileId: scope.profileId,
    accountId: typeof args.accountId === "string" ? args.accountId : undefined,
    adAccountId: typeof args.adAccountId === "string" ? args.adAccountId : undefined,
    fromDate: isoDate(args.fromDate),
    toDate: isoDate(args.toDate),
    limit: Math.min(Math.max(Number(args.limit) || 20, 1), 100),
  });
  // Belt and braces: only campaigns Zernio filed under OUR profile.
  return tree.campaigns.filter((c) => !c.profileId || c.profileId === scope.profileId);
}

export async function campaignInsights(scope: ZernioScope, args: Record<string, unknown>): Promise<unknown> {
  const c = await requireOwnedCampaign(scope, args.campaignId, args.platform);
  return scope.client.getCampaignAnalytics(c.platformCampaignId, { platform: c.platform, fromDate: isoDate(args.fromDate), toDate: isoDate(args.toDate) });
}
