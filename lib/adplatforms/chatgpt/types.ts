// Marketr — Wave 2 ChatGPT Ads slice 1: domain types + pure validation.
//
// Conversational-intent campaigns bought through the Phase 18 StackAdapt
// rail (a confirmed OpenAI launch partner). There is no public self-serve
// OpenAI ads API — the buying on-ramp is StackAdapt, so no new AdPlatformKey
// is introduced. ChatGPTCampaign is a 1:1 extension of PaidAdCampaign; every
// spend action still flows through the Phase 18 SpendProposal → SpendApproval
// gate. This module never touches media spend directly.
//
// This file is pure (no Prisma, no I/O) so the rules below are unit-testable
// without a database.

export type ChatGPTCampaignStatus =
  | "draft"
  | "proposed"
  | "approved"
  | "live"
  | "paused"
  | "ended";

export type ChatGPTTier = "free" | "go";
export type ChatGPTBidStrategy = "cpc" | "cpm";
export type CreativeVariantSource = "ai_generated" | "human";
export type CreativeApprovalStatus = "pending" | "approved" | "rejected";

export interface ChatGPTCampaignDraftInput {
  name: string;
  objective?: string;
  targetTiers: ChatGPTTier[];
  topicIntentTags: string[];
  budgetDailyCents?: number | null;
  budgetTotalCents?: number | null;
  bidStrategy?: ChatGPTBidStrategy;
  accountId: string;
}

export interface CreativeVariantInput {
  headline: string;
  body: string;
  ctaLabel?: string;
  locale?: string;
  source: CreativeVariantSource;
  /** Required when source is ai_generated — "who made this ad" must be answerable. */
  aiProviderUsed?: string;
  aiModelUsed?: string;
  parentVariantId?: string;
}

export class ChatGPTAdsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ChatGPTAdsError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Status machine: draft → proposed → approved → live → paused → ended.
// Paused campaigns may resume (paused → live). Anything non-terminal may end.
// Proposed campaigns may be sent back to draft. Nothing leaves `ended`.
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Record<ChatGPTCampaignStatus, ChatGPTCampaignStatus[]> = {
  draft: ["proposed", "ended"],
  proposed: ["approved", "draft", "ended"],
  approved: ["live", "ended"],
  live: ["paused", "ended"],
  paused: ["live", "ended"],
  ended: [],
};

export function isValidStatusTransition(
  from: ChatGPTCampaignStatus,
  to: ChatGPTCampaignStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertStatusTransition(
  from: ChatGPTCampaignStatus,
  to: ChatGPTCampaignStatus,
): void {
  if (!isValidStatusTransition(from, to)) {
    throw new ChatGPTAdsError(
      "INVALID_STATUS_TRANSITION",
      `Cannot move ChatGPT campaign from ${from} to ${to}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Draft validation. Fail closed: no budget cap, no campaign. The spec's
// propose_chatgpt_campaign requires a budget cap before a SpendProposal may
// be emitted — autopilot never proposes uncapped spend.
// ---------------------------------------------------------------------------

export function validateCampaignDraft(input: ChatGPTCampaignDraftInput): void {
  if (!input.name || input.name.trim().length === 0) {
    throw new ChatGPTAdsError("NAME_REQUIRED", "Campaign name is required.");
  }
  if (!input.accountId || input.accountId.trim().length === 0) {
    throw new ChatGPTAdsError(
      "ACCOUNT_REQUIRED",
      "A linked StackAdapt ad account is required.",
    );
  }
  if (!Array.isArray(input.targetTiers) || input.targetTiers.length === 0) {
    throw new ChatGPTAdsError(
      "TIERS_REQUIRED",
      "At least one ChatGPT tier (Free/Go) must be targeted.",
    );
  }
  for (const tier of input.targetTiers) {
    if (tier !== "free" && tier !== "go") {
      throw new ChatGPTAdsError("INVALID_TIER", `Unknown ChatGPT tier: ${tier}.`);
    }
  }
  const daily = input.budgetDailyCents ?? null;
  const total = input.budgetTotalCents ?? null;
  if (daily == null && total == null) {
    throw new ChatGPTAdsError(
      "BUDGET_CAP_REQUIRED",
      "A daily or total budget cap is required before a campaign can be proposed.",
    );
  }
  for (const [label, value] of [
    ["daily", daily],
    ["total", total],
  ] as const) {
    if (value != null && (!Number.isInteger(value) || value <= 0)) {
      throw new ChatGPTAdsError(
        "INVALID_BUDGET",
        `Budget ${label} must be a positive integer number of cents.`,
      );
    }
  }
  if (input.bidStrategy && input.bidStrategy !== "cpc" && input.bidStrategy !== "cpm") {
    throw new ChatGPTAdsError(
      "INVALID_BID_STRATEGY",
      `Unknown bid strategy: ${input.bidStrategy}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Creative variant validation. AI-generated variants must carry provenance;
// human variants may omit it. Policy flags are review output, not input.
// ---------------------------------------------------------------------------

export function validateCreativeVariant(input: CreativeVariantInput): void {
  if (!input.headline || input.headline.trim().length === 0) {
    throw new ChatGPTAdsError("HEADLINE_REQUIRED", "Variant headline is required.");
  }
  if (!input.body || input.body.trim().length === 0) {
    throw new ChatGPTAdsError("BODY_REQUIRED", "Variant body is required.");
  }
  if (input.locale && !/^[a-z]{2}(-[A-Z]{2})?$/.test(input.locale)) {
    throw new ChatGPTAdsError(
      "INVALID_LOCALE",
      `Locale must look like "en" or "en-US", got: ${input.locale}.`,
    );
  }
  if (input.source === "ai_generated" && !input.aiProviderUsed) {
    throw new ChatGPTAdsError(
      "AI_PROVENANCE_REQUIRED",
      "AI-generated variants must record which provider made them.",
    );
  }
}

/**
 * Build a localized/mutated child variant from a parent. The child keeps the
 * parent link (lineage) and inherits locale-appropriate defaults; the caller
 * supplies the new copy. Approval always resets to pending — a child is never
 * born approved.
 */
export function deriveChildVariant(
  parent: { id: string; source: CreativeVariantSource; aiProviderUsed?: string | null; aiModelUsed?: string | null },
  child: Omit<CreativeVariantInput, "parentVariantId">,
): CreativeVariantInput & { parentVariantId: string } {
  const merged: CreativeVariantInput & { parentVariantId: string } = {
    ...child,
    // Provenance follows the lineage when the child doesn't declare its own.
    aiProviderUsed: child.aiProviderUsed ?? parent.aiProviderUsed ?? undefined,
    aiModelUsed: child.aiModelUsed ?? parent.aiModelUsed ?? undefined,
    parentVariantId: parent.id,
  };
  // Validate AFTER inheritance — a localized child is allowed to ride the
  // parent's provenance rather than re-declaring it.
  validateCreativeVariant(merged);
  return merged;
}

/** Ads Manager console deep link (no public ads API — console embed is the integration). */
export function adsManagerDeepLink(params: { campaignName: string }): string {
  const base = "https://ads.openai.com/";
  return `${base}?utm_source=marketr&utm_medium=console-link&utm_campaign=${encodeURIComponent(params.campaignName)}`;
}
