// Marketr — Phase 8 G1: connector framework config (SPEC-PHASE8.md §2 G1).
//
// Three tiers, honest labels:
//   Tier W (webhook/push): hubspot, shopify, meta ads, salesforce CDC
//   Tier S (scheduled pull): google_ads, meta insights, tiktok, linkedin
//   Tier M (manual/assisted): woocommerce (gentle polling), csv import,
//     onboarding-wizard bootstrap from the Phase 6 Intelligence Report.
//
// All connectors fail honestly without creds (fake/test mode default).
// Credentials live in the vault — never in graph payloads or logs (§9.9).

import type { GraphConnectorPlatform, GraphSyncTier } from "@prisma/client";

export type TierWPlatform = "hubspot" | "shopify" | "meta" | "salesforce";
export type TierSPlatform = "google_ads" | "meta" | "tiktok" | "linkedin";
export type TierMPlatform = "woocommerce";

export const TIER_W: TierWPlatform[] = ["hubspot", "shopify", "meta", "salesforce"];
export const TIER_S: TierSPlatform[] = ["google_ads", "meta", "tiktok", "linkedin"];

export interface PlatformSpec {
  platform: GraphConnectorPlatform;
  displayName: string;
  tier: GraphSyncTier;
  signatureScheme: string;
  rateBudget: RateBudget;
  honestyNote: string;
}

export interface RateBudget {
  /** max billable operations per rolling 24h (Google Ads Basic = 15k) */
  dailyOps: number;
  /** max calls per rolling hour (Meta = 200/ad account) */
  hourlyCalls?: number;
  /** minimum seconds between polls (WooCommerce gentle polling) */
  minPollIntervalSec?: number;
  windowStart?: string;
  usedOps?: number;
  usedThisHour?: number;
  hourWindowStart?: string;
}

export const PLATFORM_SPECS: Record<GraphConnectorPlatform, PlatformSpec> = {
  hubspot: {
    platform: "hubspot",
    displayName: "HubSpot",
    tier: "webhook",
    signatureScheme: "X-HubSpot-Signature-v3: base64 HMAC-SHA256(app secret, method+uri+body+timestamp)",
    rateBudget: { dailyOps: 86_400, hourlyCalls: 36_000 }, // 100 req/10s per account
    honestyNote: "Webhooks are near-real-time; CRM Search and reporting are pulled.",
  },
  salesforce: {
    platform: "salesforce",
    displayName: "Salesforce",
    tier: "webhook",
    signatureScheme: "CometD streaming subscription (Platform Events / CDC) — no per-request signature; org-level OAuth",
    rateBudget: { dailyOps: 100_000 }, // Enterprise base; shared with the client's other integrations
    honestyNote: "Push via Platform Events/CDC streaming subscription per org; bulk via scheduled pull. The API budget is shared with every other integration the client runs.",
  },
  shopify: {
    platform: "shopify",
    displayName: "Shopify",
    tier: "webhook",
    signatureScheme: "X-Shopify-Hmac-Sha256: base64 HMAC-SHA256(app secret, raw body)",
    rateBudget: { dailyOps: 86_400_000, hourlyCalls: 3_600_000 }, // 1000 cost-points/sec bucket per store
    honestyNote: "Webhooks are near-real-time; GraphQL cost-based pull for the rest.",
  },
  woocommerce: {
    platform: "woocommerce",
    displayName: "WooCommerce",
    tier: "manual",
    signatureScheme: "WooCommerce-Signature: base64 HMAC-SHA256(webhook secret, raw body) — host-dependent delivery",
    rateBudget: { dailyOps: 96, minPollIntervalSec: 900 }, // gentle: ≤ every 15 min, small pages
    honestyNote: "No central OAuth — per-site consumer key handoff. Webhooks are best-effort (host-dependent); polling is gentle by design and never melts a shared host.",
  },
  google_ads: {
    platform: "google_ads",
    displayName: "Google Ads",
    tier: "scheduled",
    signatureScheme: "OAuth2 + developer token (no webhooks exist)",
    rateBudget: { dailyOps: 15_000 }, // Basic tier; Standard is unlimited
    honestyNote: "Pull-only. Daily GAQL SearchStream at account/campaign rollup; 3-day lookback for attribution restatements; full monthly resync.",
  },
  meta: {
    platform: "meta",
    displayName: "Meta",
    tier: "webhook",
    signatureScheme: "X-Hub-Signature-256: hex HMAC-SHA256(app secret, raw body)",
    rateBudget: { dailyOps: 4_800, hourlyCalls: 200 }, // per ad account
    honestyNote: "Webhooks for ad-object changes (88 notification types); Insights are pulled via async jobs, not hourly polling. Historical breakdowns beyond 13 months return empty (platform restriction).",
  },
  tiktok: {
    platform: "tiktok",
    displayName: "TikTok",
    tier: "scheduled",
    signatureScheme: "OAuth2 Access-Token header (no ads webhooks exist)",
    rateBudget: { dailyOps: 1_000 },
    honestyNote: "Pull-only. Nightly batched reporting pulls per advertiser; app-level caps are shared across all clients — batch aggressively.",
  },
  linkedin: {
    platform: "linkedin",
    displayName: "LinkedIn",
    tier: "scheduled",
    signatureScheme: "OAuth2 (no ads webhooks; Social Actions webhook push disabled on Development tier)",
    rateBudget: { dailyOps: 500 }, // Development tier — agency scale needs Standard approval
    honestyNote: "Development tier (500 calls/day) is unusable at agency scale; Standard-tier approval per use case is the gate. Longest-lead dependency — start day one.",
  },
};

export function platformSpec(p: GraphConnectorPlatform): PlatformSpec {
  return PLATFORM_SPECS[p];
}

/** Connector modes. "fake" is the default: fixtures, no network, honest labels. */
export type ConnectorMode = "fake" | "live";

/**
 * Resolve the mode for a connector. Live requires BOTH a configured auth_ref
 * in the vault AND an explicit live flag — missing creds fail honestly into
 * fake mode instead of throwing mid-sync.
 */
export function resolveMode(connector: {
  authRef: string | null;
  status: string;
}): { mode: ConnectorMode; reason: string } {
  if (
    connector.authRef &&
    connector.status === "connected" &&
    process.env.GRAPH_CONNECTORS_LIVE === "1"
  ) {
    return { mode: "live", reason: "vault credentials present and live mode enabled" };
  }
  const reason = !connector.authRef
    ? "no credentials in vault — running in fake mode"
    : connector.status !== "connected"
      ? `connector status is ${connector.status} — running in fake mode`
      : "GRAPH_CONNECTORS_LIVE not set — running in fake mode";
  return { mode: "fake", reason };
}
