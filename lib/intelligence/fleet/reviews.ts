// Marketr — Phase 10 M4: review velocity via LICENSED paths only.
//
// Adapters:
//   - Yelp Fusion (free tier) — direct, via YELP_API_KEY.
//   - DataForSEO Business Data — REUSES the existing provider
//     (getSeoProvider().businessReviews, lib/providers/dataforseo.ts —
//     /v3/business_data/google/reviews/task_post + task_get poll).
//     Spend routed through M6's circuit breaker (recordFleetSpend).
//   - GBP API (owned listings) — reuses lib/local/gbp.ts. The GBP API
//     application is backlogged (no ETA) and the connector is mock-only
//     behind FEATURE_GBP_MANAGEMENT with no review surface, so this adapter
//     degrades gracefully until a live provider exists.
//
// Every adapter passes its request URL through assertLicensedReviewHost()
// BEFORE fetching — the spec §2 hard line (no G2/Capterra/Trustpilot/Reddit
// scraping) is enforced at runtime and in the blocklist test.
//
// Sentiment/complaint-theme mining runs ONLY on the user's own licensed
// data returned by these adapters — never on scraped corpora.

import { getSeoProvider } from "@/lib/providers";
import { gbpManagementEnabled, MockGbpProvider } from "@/lib/local/gbp";
import type {
  ComplaintTheme,
  LicensedReview,
  ReviewAdapterResult,
} from "./types";
import { assertLicensedReviewHost } from "./types";
import { recordFleetSpend } from "./metering";

// ---------------------------------------------------------------------------
// Yelp Fusion (free tier)
// ---------------------------------------------------------------------------

const YELP_REVIEWS_URL = (businessId: string) =>
  `https://api.yelp.com/v3/businesses/${encodeURIComponent(businessId)}/reviews`;

export async function fetchYelpReviews(
  businessId: string,
  opts: { limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<ReviewAdapterResult> {
  const apiKey = (process.env.YELP_API_KEY ?? "").trim();
  if (!apiKey) {
    return {
      status: "unconfigured",
      source: "yelp",
      reviews: [],
      detail: "YELP_API_KEY not set — Yelp Fusion adapter idle (free tier available).",
    };
  }
  const url = YELP_REVIEWS_URL(businessId);
  assertLicensedReviewHost(url);
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return { status: "error", source: "yelp", reviews: [], detail: `Yelp Fusion HTTP ${res.status}` };
    }
    const json = (await res.json()) as {
      reviews?: Array<{ user?: { name?: string }; rating?: number; text?: string; time_created?: string }>;
    };
    const reviews: LicensedReview[] = (json.reviews ?? [])
      .slice(0, opts.limit ?? 20)
      .map((r) => ({
        source: "yelp" as const,
        author: r.user?.name ?? "anonymous",
        rating: typeof r.rating === "number" ? r.rating : 0,
        text: r.text ?? "",
        publishedAt: r.time_created ?? new Date().toISOString(),
      }));
    return { status: "ok", source: "yelp", reviews };
  } catch (err) {
    return {
      status: "error",
      source: "yelp",
      reviews: [],
      detail: err instanceof Error ? err.message.slice(0, 200) : "Yelp fetch failed",
    };
  }
}

// ---------------------------------------------------------------------------
// DataForSEO Business Data (licensed retail path, $0.012/task per spec)
// ---------------------------------------------------------------------------

export interface DataForSeoReviewsInput {
  /** Business name as shown on Google. */
  keyword: string;
  lat: number;
  lng: number;
  depth?: number;
}

export async function fetchDataForSeoReviews(
  input: DataForSeoReviewsInput,
  workspaceId: string,
): Promise<ReviewAdapterResult> {
  const provider = getSeoProvider();
  try {
    const result = await provider.businessReviews({
      keyword: input.keyword,
      lat: input.lat,
      lng: input.lng,
      depth: input.depth ?? 20,
    });
    if (result.mock) {
      return {
        status: "unconfigured",
        source: "dataforseo",
        reviews: [],
        detail: "DataForSEO credentials not configured (DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD) — mock provider active, no live call made.",
      };
    }
    // Licensed spend — route through M6's circuit breaker.
    await recordFleetSpend({
      workspaceId,
      vendor: "dataforseo",
      meter: "review_pull",
      quantity: 1,
      costUsd: 0.012,
    });
    const reviews: LicensedReview[] = result.items.map((r) => ({
      source: "dataforseo" as const,
      author: r.author ?? "anonymous",
      rating: r.rating ?? 0,
      text: r.text ?? "",
      publishedAt: r.publishedAt ?? new Date().toISOString(),
    }));
    return { status: "ok", source: "dataforseo", reviews };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "DataForSEO reviews failed";
    const unconfigured = /not configured/i.test(msg);
    return {
      status: unconfigured ? "unconfigured" : "error",
      source: "dataforseo",
      reviews: [],
      detail: msg.slice(0, 200),
    };
  }
}

// ---------------------------------------------------------------------------
// GBP (owned listings) — graceful until the live provider exists
// ---------------------------------------------------------------------------

export async function fetchGbpReviewSignals(): Promise<ReviewAdapterResult> {
  const provider = new MockGbpProvider();
  if (!gbpManagementEnabled() || !provider.isConfigured() || !provider.isLive) {
    return {
      status: "unconfigured",
      source: "gbp",
      reviews: [],
      detail:
        "GBP API application backlogged (no ETA); connector is mock-only behind FEATURE_GBP_MANAGEMENT and exposes no review surface. No live Google call made.",
    };
  }
  // When a live provider lands, review-listing goes here behind
  // assertLicensedReviewHost("https://mybusiness.googleapis.com/…").
  return { status: "ok", source: "gbp", reviews: [] };
}

// ---------------------------------------------------------------------------
// Velocity + complaint-theme mining (own licensed data only)
// ---------------------------------------------------------------------------

export interface ReviewVelocity {
  source: string;
  status: string;
  reviewsThisWeek: number;
  avgRating: number | null;
  detail?: string;
}

export function reviewVelocity(result: ReviewAdapterResult, weekStart: Date): ReviewVelocity {
  const weekMs = 7 * 24 * 3600 * 1000;
  const inWeek = result.reviews.filter((r) => {
    const t = Date.parse(r.publishedAt);
    return Number.isFinite(t) && t >= weekStart.getTime() && t <= weekStart.getTime() + weekMs;
  });
  const ratings = inWeek.map((r) => r.rating).filter((n) => n > 0);
  return {
    source: result.source,
    status: result.status,
    reviewsThisWeek: inWeek.length,
    avgRating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
    detail: result.detail,
  };
}

const COMPLAINT_THEMES: Array<{ theme: string; patterns: RegExp[] }> = [
  { theme: "pricing", patterns: [/\bexpensive\b/i, /\boverpriced\b/i, /\bpricey\b/i, /\brip[- ]?off\b/i, /\bhidden fee/i] },
  { theme: "support", patterns: [/\bsupport\b/i, /\brude\b/i, /\bunhelpful\b/i, /\bno response\b/i, /\bignored\b/i] },
  { theme: "quality", patterns: [/\bpoor quality\b/i, /\bbroken\b/i, /\bdefective\b/i, /\bcheaply made\b/i] },
  { theme: "delivery", patterns: [/\blate\b/i, /\bnever arrived\b/i, /\bshipping\b/i, /\bdelivery\b/i] },
  { theme: "billing", patterns: [/\bcharged\b/i, /\bbilling\b/i, /\brefund\b/i, /\bcancel/i] },
  { theme: "wait_time", patterns: [/\bwait\b/i, /\bslow\b/i, /\bhours?\b.*\blate/i] },
];

/** Heuristic complaint-theme mining over the user's OWN licensed review
 *  data. Keyword-signal based — labeled as heuristic in the UI. */
export function mineComplaintThemes(reviews: LicensedReview[]): ComplaintTheme[] {
  const negative = reviews.filter((r) => r.rating > 0 && r.rating <= 2);
  const out: ComplaintTheme[] = [];
  for (const { theme, patterns } of COMPLAINT_THEMES) {
    let mentions = 0;
    let example = "";
    for (const r of negative) {
      if (patterns.some((p) => p.test(r.text))) {
        mentions++;
        if (!example) example = r.text.slice(0, 140);
      }
    }
    if (mentions > 0) out.push({ theme, mentions, example });
  }
  return out.sort((a, b) => b.mentions - a.mentions);
}
