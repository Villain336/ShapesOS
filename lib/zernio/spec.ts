// ShapesOS — Phase 15.4 (zernio): what the Zernio API looks like, from its
// OpenAPI spec (v1.217.1, https://zernio.com/openapi.yaml, read 2026-10-05).
// PURE and client-safe: constants and response shapes only. Every shape
// names the operationId it comes from, so a reviewer can check it against
// the spec instead of trusting this file.
//
// Base URL https://zernio.com/api, versioned paths /v1/…, Bearer API key.
// Every 4xx/5xx body is an ErrorResponse; rate limits come back in
// X-RateLimit-Limit / -Remaining / -Reset (read, never hard-coded).

export const ZERNIO_DEFAULT_BASE_URL = "https://zernio.com/api";
export const ZERNIO_SPEC_VERSION = "1.217.1";

/** getConnectUrl (GET /v1/connect/{platform}) — the 16 posting platforms. */
export const ZERNIO_SOCIAL_PLATFORMS = [
  "facebook",
  "instagram",
  "linkedin",
  "twitter",
  "tiktok",
  "youtube",
  "threads",
  "reddit",
  "pinterest",
  "bluesky",
  "googlebusiness",
  "telegram",
  "snapchat",
  "discord",
  "slack",
  "whatsapp",
] as const;
export type ZernioSocialPlatform = (typeof ZERNIO_SOCIAL_PLATFORMS)[number];

export const ZERNIO_PLATFORM_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  twitter: "X",
  tiktok: "TikTok",
  youtube: "YouTube",
  threads: "Threads",
  reddit: "Reddit",
  pinterest: "Pinterest",
  bluesky: "Bluesky",
  googlebusiness: "Google Business",
  telegram: "Telegram",
  snapchat: "Snapchat",
  discord: "Discord",
  slack: "Slack",
  whatsapp: "WhatsApp",
  // Ads account platforms (SocialAccount.platform) and campaign platforms.
  metaads: "Meta Ads",
  googleads: "Google Ads",
  tiktokads: "TikTok Ads",
  linkedinads: "LinkedIn Ads",
  pinterestads: "Pinterest Ads",
  xads: "X Ads",
  openaiads: "OpenAI Ads",
  google: "Google Ads",
  openai: "OpenAI Ads",
  shopify: "Shopify",
  wordpress: "WordPress",
};

/**
 * getConnectUrl: "snapchat is a closed beta with no public release date: it
 * returns 403 PLATFORM_BETA_RESTRICTED until the account is approved".
 */
export const ZERNIO_CLOSED_BETA_PLATFORMS: ReadonlySet<string> = new Set(["snapchat"]);

/** connectAds (GET /v1/connect/{platform}/ads) path values. */
export const ZERNIO_ADS_CONNECT_PLATFORMS = [
  "facebook",
  "instagram",
  "linkedin",
  "tiktok",
  "twitter",
  "pinterest",
  "googleads",
] as const;
export type ZernioAdsConnectPlatform = (typeof ZERNIO_ADS_CONNECT_PLATFORMS)[number];

export interface ZernioAdNetwork {
  key: "meta" | "google" | "tiktok" | "linkedin" | "pinterest" | "x" | "openai";
  label: string;
  /** How the ad account is connected. */
  connect:
    | { kind: "oauth"; platform: ZernioAdsConnectPlatform; needsPostingAccount?: ZernioSocialPlatform }
    | { kind: "credentials" };
  /** SocialAccount.platform of the ads connection (GET /v1/accounts). */
  accountPlatform: string;
}

/**
 * The 7 ad networks (spec x-long-description). connectAds notes: Meta needs a
 * Facebook Page; X Ads needs an existing X posting account (accountId is
 * REQUIRED); OpenAI Ads is connected with a ChatGPT Ads Manager key
 * (connectOpenAIAdsCredentials) — the customer's own key, passed through to
 * Zernio and never stored by ShapesOS.
 */
export const ZERNIO_AD_NETWORKS: readonly ZernioAdNetwork[] = [
  { key: "meta", label: "Meta (Facebook and Instagram)", connect: { kind: "oauth", platform: "facebook" }, accountPlatform: "metaads" },
  { key: "google", label: "Google Ads", connect: { kind: "oauth", platform: "googleads" }, accountPlatform: "googleads" },
  { key: "tiktok", label: "TikTok Ads", connect: { kind: "oauth", platform: "tiktok" }, accountPlatform: "tiktokads" },
  { key: "linkedin", label: "LinkedIn Ads", connect: { kind: "oauth", platform: "linkedin" }, accountPlatform: "linkedinads" },
  { key: "pinterest", label: "Pinterest Ads", connect: { kind: "oauth", platform: "pinterest" }, accountPlatform: "pinterestads" },
  { key: "x", label: "X Ads", connect: { kind: "oauth", platform: "twitter", needsPostingAccount: "twitter" }, accountPlatform: "xads" },
  { key: "openai", label: "OpenAI Ads (ChatGPT)", connect: { kind: "credentials" }, accountPlatform: "openaiads" },
];

/** SocialAccount.platform values that are ads connections. */
export const ZERNIO_ADS_ACCOUNT_PLATFORMS: ReadonlySet<string> = new Set(ZERNIO_AD_NETWORKS.map((n) => n.accountPlatform));

/** AdCampaign.platform values (GET /v1/ads/campaigns, PUT …/status). */
export const ZERNIO_CAMPAIGN_PLATFORMS = ["facebook", "instagram", "tiktok", "linkedin", "pinterest", "google", "twitter", "openai"] as const;
export type ZernioCampaignPlatform = (typeof ZERNIO_CAMPAIGN_PLATFORMS)[number];

/** updateAdCampaign (PUT /v1/ads/campaigns/{campaignId}) body.platform enum. */
export const ZERNIO_BUDGET_UPDATE_PLATFORMS: ReadonlySet<string> = new Set(["facebook", "instagram", "google"]);

/**
 * createStandaloneAd validateOnly: "Meta … Google Performance Max / Demand
 * Gen … ChatGPT (OpenAI) … Any other platform, or a Google campaignType other
 * than pmax or demand_gen, returns 501 feature_not_available."
 */
export function validateOnlySupported(platform: string, campaignType?: string | null): boolean {
  if (platform === "facebook" || platform === "instagram" || platform === "openai") return true;
  if (platform === "google") return campaignType === "pmax" || campaignType === "demand_gen";
  return false;
}

/** The ads account platform → the campaign platform it creates on. */
export function campaignPlatformForAccount(accountPlatform: string): ZernioCampaignPlatform | null {
  switch (accountPlatform) {
    case "metaads":
    case "facebook":
      return "facebook";
    case "instagram":
      return "instagram";
    case "googleads":
      return "google";
    case "tiktokads":
    case "tiktok":
      return "tiktok";
    case "linkedinads":
    case "linkedin":
      return "linkedin";
    case "pinterestads":
    case "pinterest":
      return "pinterest";
    case "xads":
    case "twitter":
      return "twitter";
    case "openaiads":
      return "openai";
    default:
      return null;
  }
}

/** GET /v1/accounts `category`: ads / communication / blogs / social. */
export function accountCategory(platform: string): "social" | "ads" | "communication" | "blogs" {
  if (ZERNIO_ADS_ACCOUNT_PLATFORMS.has(platform)) return "ads";
  if (["whatsapp", "telegram", "discord", "slack", "sms", "phone", "rcs"].includes(platform)) return "communication";
  if (platform === "shopify" || platform === "wordpress") return "blogs";
  return "social";
}

// ---------------------------------------------------------------------------
// Response shapes (only the fields ShapesOS reads)
// ---------------------------------------------------------------------------

/** components.schemas.ErrorResponse */
export interface ZernioErrorBody {
  error?: string;
  type?: string;
  code?: string;
  param?: string;
  platform?: string;
  details?: Record<string, unknown>;
}

/** components.schemas.Profile (listProfiles, createProfile, getProfile). */
export interface ZernioProfileDoc {
  _id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  createdAt?: string;
}

/** components.schemas.SocialAccount (listAccounts). profileId is a string or a populated Profile. */
export interface ZernioAccountDoc {
  _id: string;
  platform: string;
  profileId: string | { _id: string; name?: string; slug?: string };
  username?: string;
  displayName?: string;
  profileUrl?: string;
  isActive: boolean;
  needsReconnection?: boolean;
  enabled?: boolean;
  parentAccountId?: string | null;
}

/** The profile id of a SocialAccount, whichever form it came in. */
export function accountProfileId(a: Pick<ZernioAccountDoc, "profileId">): string | null {
  const p = a.profileId;
  if (typeof p === "string") return p;
  if (p && typeof p === "object" && typeof p._id === "string") return p._id;
  return null;
}

/** getAllAccountsHealth (GET /v1/accounts/health) → accounts[]. */
export interface ZernioAccountHealthRow {
  accountId: string;
  platform: string;
  username?: string;
  displayName?: string;
  profileId?: string;
  status: "healthy" | "warning" | "error";
  canPost?: boolean;
  canFetchAnalytics?: boolean;
  tokenValid?: boolean;
  needsReconnect?: boolean;
  issues?: string[];
}

/** listAdAccounts (GET /v1/ads/accounts) → accounts[]. */
export interface ZernioAdAccountDoc {
  id: string;
  name?: string;
  currency?: string;
  accountStatus?: unknown;
  selectable?: boolean;
  unusableReason?: string | null;
  billingStatus?: "ok" | "missing" | "unknown";
}

/** components.schemas.AdBudget */
export interface ZernioBudget {
  amount: number;
  type: "daily" | "lifetime";
}

/** components.schemas.AdMetrics (subset). ctr is a percentage. */
export interface ZernioAdMetrics {
  spend?: number;
  impressions?: number;
  reach?: number;
  clicks?: number;
  ctr?: number;
  cpc?: number;
  cpm?: number;
  conversions?: number;
  purchaseValue?: number;
  roas?: number;
}

/** components.schemas.AdCampaign / AdTreeCampaign (subset). */
export interface ZernioCampaignDoc {
  platformCampaignId: string;
  platform: string;
  campaignName?: string;
  status?: string;
  platformCampaignStatus?: string | null;
  budget?: ZernioBudget | null;
  campaignBudget?: ZernioBudget | null;
  budgetLevel?: "campaign" | "adset" | null;
  currency?: string | null;
  metrics?: ZernioAdMetrics;
  platformAdAccountId?: string;
  platformAdAccountName?: string | null;
  accountId?: string;
  profileId?: string;
  adCount?: number;
  /** AdTreeCampaign with timeIncrement=1: AdDailyMetrics[]. */
  daily?: Array<ZernioAdMetrics & { date: string }>;
}

/** getAdAccountLiveEntities (GET /v1/ads/accounts/live) → campaigns[]. */
export interface ZernioLiveCampaign {
  platformCampaignId: string;
  campaignName?: string | null;
  platformCampaignStatus?: string | null;
  status?: string;
  budget?: ZernioBudget | null;
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
}

/** components.schemas.CampaignAnalyticsResponse (subset). */
export interface ZernioCampaignAnalytics {
  campaign?: { id: string; name?: string | null; platform: string; currency?: string | null };
  analytics?: { summary?: ZernioAdMetrics; daily?: Array<ZernioAdMetrics & { date: string }> };
  backfillPending?: boolean;
}

/** createStandaloneAd 200 (validateOnly). */
export interface ZernioValidateResult {
  validateOnly: true;
  results?: Array<{ node: string; status: "validated" | "skipped"; reason?: string }>;
  message?: string;
}

/** createPost / getPost → post (components.schemas.Post, subset). */
export interface ZernioPostDoc {
  _id: string;
  status: "draft" | "scheduled" | "publishing" | "published" | "partial" | "failed" | "cancelled" | string;
  scheduledFor?: string;
  publishedAt?: string;
  platforms?: Array<{
    platform: string;
    accountId: string | { _id: string };
    status?: string;
    publishedAt?: string;
    platformPostUrl?: string;
    errorMessage?: string;
  }>;
}

/** getPostTimeline (GET /v1/analytics/post-timeline) → timeline[]. */
export interface ZernioTimelineRow {
  date: string;
  platform?: string;
  impressions?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  clicks?: number;
  views?: number;
}

/** getUsage metering mode (components.schemas.UsageMetering, subset). USD. */
export interface ZernioUsageMetering {
  supported?: boolean;
  totals?: { accounts?: number; ads?: number; total?: number };
  period?: { start?: string; end?: string };
}

/** Is this a Zernio-shaped object id (24 hex)? Ids from the model are untrusted. */
export function isZernioId(v: unknown): v is string {
  return typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);
}

// Phase 18.2 (WS=comms): the inbox (social DMs) documents ShapesOS reads
// (listInboxConversations / getInboxConversationMessages, spec v1.217.1).
export interface ZernioInboxConversation {
  id: string;
  platform: string;
  accountId: string;
  accountUsername?: string;
  participantId?: string;
  participantName?: string;
  participantPicture?: string | null;
  lastMessage?: string;
  updatedTime?: string;
  status?: "active" | "archived";
  unreadCount?: number | null;
  url?: string | null;
}

export interface ZernioInboxMessage {
  id: string;
  conversationId?: string;
  accountId?: string;
  platform?: string;
  message?: string;
  senderId?: string;
  senderName?: string | null;
  direction?: "incoming" | "outgoing";
  createdAt?: string;
  attachments?: { type?: string; url?: string; filename?: string | null }[];
  isDeleted?: boolean;
}
