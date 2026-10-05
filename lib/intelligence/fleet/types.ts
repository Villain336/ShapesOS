// Marketr — Phase 10 M4: competitor change fleet — shared types.
//
// Boundary map (docs/specs/SPEC-PHASE10.md §2, enforced in tests):
//   ✅ competitor sitemaps (public), polite self-fetch of public pages
//      (robots-respecting), Google Alerts as a consumer tool (docs only),
//      licensed review APIs (GBP API owned listings, Yelp Fusion,
//      DataForSEO Business Data).
//   🚫 unlicensed review scraping (G2/Capterra/Trustpilot at scale),
//      Reddit/Maps/chat-UI scraping, Yelp Open Dataset in the product.
//
// Safety (spec §4.3): the fleet PROPOSES — every summary carries a
// recommended_response as text; actions go through the Phase 9 approval
// executor. Nothing in this module ever auto-acts.

import type {
  CompetitorChangeStatus,
  CompetitorChangeType,
} from "@prisma/client";

export type { CompetitorChangeStatus, CompetitorChangeType };

/** Semantic buckets the fleet classifies changes into (drives the
 *  AI-summary prompt context + the Phase 9 mission-template routing). */
export type ChangeCategory =
  | "pricing"
  | "offer"
  | "positioning"
  | "content"
  | "reviews"
  | "seo"
  | "other";

/** A single entry parsed from a sitemap (urlset or sitemapindex). */
export interface SitemapEntry {
  url: string;
  lastmod?: string;
}

/** Result of diffing a freshly fetched sitemap against the previous state. */
export interface SitemapDiff {
  added: SitemapEntry[];
  removed: string[];
  /** Known URLs whose sitemap lastmod is newer than our last diff run. */
  updated: SitemapEntry[];
  totalSeen: number;
}

/** Normalized page snapshot for the changedetection.io pattern. */
export interface PageSnapshot {
  url: string;
  /** sha256 of normalizedText. */
  hash: string;
  /** Normalized visible text (tags stripped, whitespace collapsed), capped. */
  text: string;
  title?: string;
  metaDescription?: string;
  fetchedAt: string;
}

/** Pure-classifier output (testable without network). */
export interface ClassifiedChange {
  changeType: CompetitorChangeType;
  category: ChangeCategory;
  signals: string[];
}

/** A detected change row as served to the UI/API layer. */
export interface FleetChange {
  id: string;
  watchId: string;
  competitorDomain: string;
  url: string;
  detectedAt: string;
  changeType: CompetitorChangeType;
  category: ChangeCategory | null;
  semanticSummary: string | null;
  whyItMatters: string | null;
  recommendedResponse: string | null;
  missionTemplateId: string | null;
  status: CompetitorChangeStatus;
}

// ---------------------------------------------------------------------------
// Licensed review paths
// ---------------------------------------------------------------------------

/** Hosts the fleet is allowed to call for review data. Everything else —
 *  review-aggregator page scraping included — is blocked by
 *  assertLicensedReviewHost() and by the blocklist test. */
export const LICENSED_REVIEW_HOSTS = [
  "api.yelp.com", // Yelp Fusion (free tier) — licensed retail path
  "api.dataforseo.com", // DataForSEO Business Data ($0.012–$0.05/task)
  "mybusiness.googleapis.com", // GBP API (owned listings only)
  "businessprofileperformance.googleapis.com", // GBP performance (owned)
] as const;

/** Unlicensed review surfaces — NEVER fetched by the fleet. Spec §2 hard
 *  line; Reddit v. Anthropic (Sept 2026) gives platform ToS contract teeth. */
export const BLOCKED_REVIEW_DOMAINS = [
  "g2.com",
  "www.g2.com",
  "capterra.com",
  "www.capterra.com",
  "trustpilot.com",
  "www.trustpilot.com",
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "google.com", // maps/search scraping — never
  "www.google.com",
  "yelp.com", // page scraping — only api.yelp.com (Fusion) is allowed
  "www.yelp.com",
] as const;

/** Throws when a review-data URL is not on the licensed allowlist. Every
 *  review adapter must pass its request URL through this before fetching. */
export function assertLicensedReviewHost(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`fleet: refusing malformed review URL`);
  }
  const allowed = (LICENSED_REVIEW_HOSTS as readonly string[]).includes(host);
  if (!allowed) {
    throw new Error(
      `fleet: review fetch blocked — ${host} is not a licensed review host ` +
        `(spec §2: no unlicensed review scraping)`,
    );
  }
}

export interface LicensedReview {
  source: "yelp" | "dataforseo" | "gbp";
  author: string;
  rating: number; // 1–5
  text: string;
  publishedAt: string;
}

export interface ReviewAdapterResult {
  /** "ok" | "unconfigured" (no credentials — graceful) | "error". */
  status: "ok" | "unconfigured" | "error";
  source: "yelp" | "dataforseo" | "gbp";
  reviews: LicensedReview[];
  /** Set when status !== "ok": why (unconfigured reason, error message). */
  detail?: string;
}

export interface ComplaintTheme {
  theme: string;
  mentions: number;
  example: string;
}

// ---------------------------------------------------------------------------
// Weekly digest
// ---------------------------------------------------------------------------

export interface DigestCompetitor {
  domain: string;
  pagesAdded: number;
  pagesRemoved: number;
  pagesUpdated: number;
  pricingOfferChanges: number;
  topChanges: Array<{
    url: string;
    changeType: CompetitorChangeType;
    summary: string | null;
  }>;
}

export interface DigestSerpEntry {
  keyword: string;
  competitorDomain: string;
  position: number;
  /** True when the competitor also shipped page changes this week (joined fleet signal). */
  backedByPageChange: boolean;
}

export interface CompetitorDigest {
  workspaceId: string;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  competitors: DigestCompetitor[];
  totals: {
    pagesAdded: number;
    pagesRemoved: number;
    pagesUpdated: number;
    pricingOfferChanges: number;
    changes: number;
  };
  /** Competitor top-10 presence for tracked keywords this week (labeled as
   *  presence, not gains — v1 has no SERP baseline to diff against). */
  serpPresence: DigestSerpEntry[];
  /** False when the M6 fetchSerp contract is unavailable (built in parallel). */
  serpAvailable: boolean;
  reviewVelocity: Array<{
    source: string;
    status: string;
    reviewsThisWeek: number;
    avgRating: number | null;
    detail?: string;
  }>;
}
