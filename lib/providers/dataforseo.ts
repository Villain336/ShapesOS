// Marketr — live DataForSEO Labs provider (spec §11: default supplier,
// swappable via the SeoDataProvider interface in ./types).

import type {
  BacklinkItem,
  BacklinkSummaryData,
  BacklinkSummaryParams,
  BacklinksParams,
  BacklinksResult,
  BusinessListing,
  BusinessListingsParams,
  BusinessReviewItem,
  BusinessReviewsParams,
  BusinessReviewsResult,
  CompetitorKeyword,
  CompetitorKeywordsParams,
  KeywordIdea,
  KeywordIdeasParams,
  MapsSerpItem,
  MapsSerpParams,
  MapsSerpResult,
  SerpResult,
  SerpResultsParams,
  SerpSnapshot,
  SeoDataProvider,
} from "./types";
import { inferIntent } from "../keywords/intent";

const API_BASE = "https://api.dataforseo.com/v3";

interface LabsItem {
  keyword?: string;
  keyword_info?: {
    search_volume?: number | null;
    competition?: number | null; // 0–1
    cpc?: number | null;
  };
  keyword_properties?: {
    keyword_difficulty?: number | null; // 0–100
  };
}

interface RankedLabsItem extends LabsItem {
  ranked_serp_element?: {
    serp_item?: {
      rank_absolute?: number | null;
      url?: string | null;
    } | null;
  } | null;
}

interface SerpApiItem {
  type?: string | null;
  rank_absolute?: number | null;
  domain?: string | null;
  url?: string | null;
  title?: string | null;
  description?: string | null;
  /** Nested items for types like people_also_ask. */
  items?: Array<{ title?: string | null }> | null;
  /**
   * Cited sources inside an ai_overview item (DataForSEO exposes these as
   * `references`; absent on most other item types). Milestone 14 uses these
   * for AI Overview citation detection.
   */
  references?: Array<{ domain?: string | null; url?: string | null }> | null;
}

function competitionToDifficulty(item: LabsItem): number | null {
  const props = item.keyword_properties ?? {};
  if (props.keyword_difficulty != null) return props.keyword_difficulty;
  const competition = item.keyword_info?.competition;
  return competition != null ? Math.round(competition * 100) : null;
}

export class DataForSeoProvider implements SeoDataProvider {
  readonly name = "dataforseo";
  readonly isLive = true;

  constructor(
    private readonly login: string,
    private readonly password: string,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.login && this.password);
  }

  /** Shared POST helper: auth + error handling, returns the task's items. */
  private async postItems<T>(endpoint: string, payload: object): Promise<T[]> {
    if (!this.isConfigured()) {
      throw new Error(
        "DataForSEO credentials are not configured. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.",
      );
    }
    const auth = Buffer.from(`${this.login}:${this.password}`).toString(
      "base64",
    );
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([payload]),
    });

    if (!res.ok) {
      throw new Error(`DataForSEO request failed: HTTP ${res.status}`);
    }

    const json: unknown = await res.json();
    const task = (
      json as {
        tasks?: Array<{
          status_code?: number;
          status_message?: string;
          result?: Array<{ items?: T[] }>;
        }>;
      }
    )?.tasks?.[0];

    if (!task || task.status_code !== 20000) {
      throw new Error(
        `DataForSEO error: ${task?.status_message ?? "unknown error"}`,
      );
    }

    return task.result?.[0]?.items ?? [];
  }

  /**
   * POST helper for endpoints that return a single result OBJECT at
   * result[0] (e.g. /backlinks/summary/live) rather than an items array.
   */
  private async postResult<T>(endpoint: string, payload: object): Promise<T | null> {
    if (!this.isConfigured()) {
      throw new Error(
        "DataForSEO credentials are not configured. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.",
      );
    }
    const auth = Buffer.from(`${this.login}:${this.password}`).toString(
      "base64",
    );
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([payload]),
    });

    if (!res.ok) {
      throw new Error(`DataForSEO request failed: HTTP ${res.status}`);
    }

    const json: unknown = await res.json();
    return parseSingleResult<T>(json);
  }

  /** Labs POST helper kept for backwards compatibility (delegates to postItems). */
  private async labsRequest<T>(endpoint: string, payload: object): Promise<T[]> {
    return this.postItems<T>(endpoint, payload);
  }

  async keywordIdeas(params: KeywordIdeasParams): Promise<KeywordIdea[]> {
    const {
      seed,
      locationCode = 2840,
      languageCode = "en",
      limit = 100,
    } = params;

    const items = await this.labsRequest<LabsItem>(
      "/dataforseo_labs/google/keyword_ideas/live",
      {
        keyword: seed,
        location_code: locationCode,
        language_code: languageCode,
        include_serp_info: false,
        limit,
        offset: 0,
      },
    );

    return items.map((item) => {
      const info = item.keyword_info ?? {};
      const phrase = item.keyword ?? "";
      return {
        phrase,
        volume: info.search_volume ?? null,
        difficulty: competitionToDifficulty(item),
        cpc: info.cpc ?? null,
        intent: inferIntent(phrase),
      } satisfies KeywordIdea;
    });
  }

  async competitorKeywords(
    params: CompetitorKeywordsParams,
  ): Promise<CompetitorKeyword[]> {
    const {
      domain,
      locationCode = 2840,
      languageCode = "en",
      limit = 100,
    } = params;

    const items = await this.labsRequest<RankedLabsItem>(
      "/dataforseo_labs/google/ranked_keywords/live",
      {
        target: domain,
        location_code: locationCode,
        language_code: languageCode,
        limit,
        offset: 0,
      },
    );

    return items.map((item) => {
      const info = item.keyword_info ?? {};
      const serp = item.ranked_serp_element?.serp_item ?? {};
      const phrase = item.keyword ?? "";
      return {
        phrase,
        volume: info.search_volume ?? null,
        difficulty: competitionToDifficulty(item),
        cpc: info.cpc ?? null,
        intent: inferIntent(phrase),
        position: serp.rank_absolute ?? null,
        url: serp.url ?? null,
      } satisfies CompetitorKeyword;
    });
  }

  async serpResults(params: SerpResultsParams): Promise<SerpSnapshot> {
    const {
      keyword,
      locationCode = 2840,
      languageCode = "en",
      depth = 10,
    } = params;

    const items = await this.postItems<SerpApiItem>(
      "/serp/google/organic/live",
      {
        keyword,
        location_code: locationCode,
        language_code: languageCode,
        depth,
        device: "desktop",
        os: "windows",
      },
    );

    const results: SerpResult[] = [];
    const peopleAlsoAsk: string[] = [];
    let aiOverviewPresent: boolean | null = null;
    const aiOverviewCitations: Array<{ domain: string; url: string | null }> = [];

    for (const item of items) {
      const type = (item.type ?? "").toLowerCase();
      if (type === "organic" && item.url) {
        results.push({
          domain: item.domain ?? "",
          url: item.url,
          title: item.title ?? "",
          description: item.description ?? null,
          position: results.length + 1,
        } satisfies SerpResult);
      } else if (type === "people_also_ask" && item.items) {
        for (const q of item.items) {
          if (q.title && !peopleAlsoAsk.includes(q.title)) {
            peopleAlsoAsk.push(q.title);
          }
        }
      } else if (type === "ai_overview") {
        // DataForSEO SERP live surfaces Google's AI Overview as an ai_overview
        // item when present on the page (milestone 5: AI visibility tracking).
        aiOverviewPresent = true;
        // Milestone 14: pull cited sources so we can detect whether the
        // project's own domain is cited inside the AI answer. Defensive —
        // DataForSEO only populates `references` on some ai_overview items.
        for (const ref of item.references ?? []) {
          if (ref?.domain) {
            aiOverviewCitations.push({
              domain: ref.domain,
              url: ref.url ?? null,
            });
          }
        }
      }
      if (results.length >= depth) break;
    }

    return { results, peopleAlsoAsk, aiOverviewPresent, aiOverviewCitations };
  }

  // Milestone 15: DataForSEO Backlinks API (backlinks list + summary).
  //
  // Pricing (observed 2026-09-21, lib/seo/backlinks-cost.ts is the single
  // source of truth): $0.024 per request + $0.000036 per returned row.
  // The summary endpoint is request-priced only. All parsing is defensive —
  // DataForSEO omits nulls and renames fields between API revisions.

  async backlinks(params: BacklinksParams): Promise<BacklinksResult> {
    const { target, limit = 100, mode = "as_is", onlyDofollow = false } = params;

    const items = await this.postItems<BacklinksApiItem>(
      "/backlinks/backlinks/live",
      {
        target: target.trim(),
        limit,
        offset: 0,
        mode,
        ...(onlyDofollow
          ? { filters: [["dofollow", "=", true]] }
          : {}),
        order_by: ["rank,desc"],
      },
    );

    return {
      items: items.map((item) => ({
        sourceDomain: item.domain_from ?? "",
        sourceUrl: item.url_from ?? "",
        targetUrl: item.url_to ?? "",
        anchorText: item.anchor ?? null,
        dofollow: item.dofollow ?? false,
        firstSeen: item.first_seen ?? null,
        lastSeen: item.last_visited ?? null,
        sourceRank:
          typeof item.domain_from_rank === "number" ? item.domain_from_rank : null,
        spamScore:
          typeof item.spam_score === "number" ? item.spam_score : null,
      })),
      // backlinks/live returns a flat item list; the provider-wide total is
      // only available via backlinksSummary(). Callers use rowsReturned for
      // cost accounting.
      totalCount: null,
      rowsReturned: items.length,
    };
  }

  async backlinksSummary(
    params: BacklinkSummaryParams,
  ): Promise<BacklinkSummaryData> {
    // /backlinks/summary/live returns the summary object directly at
    // result[0] (not under result[0].items), hence postResult().
    const item = (await this.postResult<BacklinksSummaryApiItem>(
      "/backlinks/summary/live",
      { target: params.target.trim() },
    )) ?? {};
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    return {
      total: num(item.backlinks),
      referringDomains: num(item.referring_domains),
      dofollowCount: num(item.dofollow),
    };
  }

  // Milestone 16: local SEO (geo-grids, competitor/review intelligence).
  //
  // Endpoints (defensive parsing — DataForSEO omits nulls and renames fields
  // between API revisions):
  //   - /serp/google/maps/live        (synchronous, per grid cell)
  //   - /business_data/business_listings/search/live (synchronous)
  //   - /business_data/google/reviews/task_post + task_get (async task, polled)
  // Pricing is request/task-priced; lib/seo/local-cost.ts holds the
  // (conservative) per-request estimates used by the cost gate.

  async mapsSerp(params: MapsSerpParams): Promise<MapsSerpResult> {
    const { keyword, lat, lng, zoom = 14, languageCode = "en" } = params;
    const items = await this.postItems<MapsSerpApiItem>(
      "/serp/google/maps/live",
      {
        keyword: keyword.trim(),
        location_coordinate: `${lat},${lng},${zoom}z`,
        language_code: languageCode,
      },
    );
    return { items: parseMapsSerpItems(items) };
  }

  async businessListings(
    params: BusinessListingsParams,
  ): Promise<BusinessListing[]> {
    const { keyword, lat, lng, limit = 10 } = params;
    const items = await this.postItems<BusinessListingsApiItem>(
      "/business_data/business_listings/search/live",
      {
        keyword: keyword.trim(),
        location_coordinate: `${lat},${lng},14z`,
        limit,
      },
    );
    return parseBusinessListings(items);
  }

  async businessReviews(
    params: BusinessReviewsParams,
  ): Promise<BusinessReviewsResult> {
    const { keyword, lat, lng, depth = 20 } = params;
    // Reviews are an async task API: post the task, poll task_get until
    // complete. Bounded (max ~60s) so a stuck task can't hang a cron.
    const taskId = await this.postReviewsTask({
      keyword: keyword.trim(),
      location_coordinate: `${lat},${lng},14z`,
      sort_by: "most_relevant",
    });
    const items = await this.pollReviewsTask(taskId, depth);
    return { items: parseBusinessReviews(items) };
  }

  /** Post a google/reviews task; returns the task id. */
  private async postReviewsTask(payload: object): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(
        "DataForSEO credentials are not configured. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.",
      );
    }
    const auth = Buffer.from(`${this.login}:${this.password}`).toString("base64");
    const res = await fetch(`${API_BASE}/business_data/google/reviews/task_post`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([payload]),
    });
    if (!res.ok) {
      throw new Error(`DataForSEO reviews task_post failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      tasks?: Array<{ status_code?: number; status_message?: string; id?: string }>;
    };
    const task = json?.tasks?.[0];
    if (!task || task.status_code !== 20100 || !task.id) {
      throw new Error(
        `DataForSEO reviews task_post error: ${task?.status_message ?? "unknown error"}`,
      );
    }
    return task.id;
  }

  /** Poll task_get until the reviews task completes (bounded). */
  private async pollReviewsTask(taskId: string, depth: number): Promise<ReviewsApiItem[]> {
    if (!this.isConfigured()) {
      throw new Error("DataForSEO credentials are not configured.");
    }
    const auth = Buffer.from(`${this.login}:${this.password}`).toString("base64");
    const deadline = Date.now() + 60_000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await fetch(
        `${API_BASE}/business_data/google/reviews/task_get/${taskId}`,
        { headers: { Authorization: `Basic ${auth}` } },
      );
      if (!res.ok) {
        throw new Error(`DataForSEO reviews task_get failed: HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        tasks?: Array<{
          status_code?: number;
          status_message?: string;
          result?: Array<{ items?: ReviewsApiItem[] }>;
        }>;
      };
      const task = json?.tasks?.[0];
      if (!task) throw new Error("DataForSEO reviews task_get: empty response");
      if (task.status_code === 20000) {
        return (task.result?.[0]?.items ?? []).slice(0, depth);
      }
      // 20100 = in queue / in progress — keep polling.
      if (task.status_code !== 20100) {
        throw new Error(
          `DataForSEO reviews task error: ${task.status_message ?? `status ${task.status_code}`}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error("DataForSEO reviews task timed out after 60s");
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/**
 * Extract the single result object from a DataForSEO task envelope
 * (tasks[0].result[0]). Pure — unit-tested against fixture payloads.
 * Returns null when the envelope is missing or the task errored.
 */
export function parseSingleResult<T>(json: unknown): T | null {
  const task = (
    json as {
      tasks?: Array<{
        status_code?: number;
        result?: Array<T>;
      }>;
    }
  )?.tasks?.[0];
  if (!task || task.status_code !== 20000) return null;
  return task.result?.[0] ?? null;
}

/** Raw DataForSEO backlinks/live item (subset we use; defensive parsing). */
interface BacklinksApiItem {
  domain_from?: string | null;
  url_from?: string | null;
  url_to?: string | null;
  anchor?: string | null;
  dofollow?: boolean | null;
  first_seen?: string | null;
  last_visited?: string | null;
  domain_from_rank?: number | null;
  spam_score?: number | null;
}

/** Raw DataForSEO backlinks/summary/live item (subset we use). */
interface BacklinksSummaryApiItem {
  backlinks?: number | null;
  referring_domains?: number | null;
  dofollow?: number | null;
}

/** Raw DataForSEO /serp/google/maps/live item (subset we use; defensive). */
interface MapsSerpApiItem {
  type?: string | null;
  rank_absolute?: number | null;
  title?: string | null;
  address?: string | null;
  place_id?: string | null;
  url?: string | null;
  domain?: string | null;
  /** Counts/ratings may serialize as strings in some payloads — parsers coerce. */
  reviews_count?: number | string | null;
  /** Rating may be a plain number, a numeric string, or { value, votes_count }. */
  rating?: number | string | { value?: number | string | null; votes_count?: number | null } | null;
  rating_value?: number | string | null;
}

/** Raw DataForSEO /business_data/business_listings/search/live item. */
interface BusinessListingsApiItem {
  title?: string | null;
  place_id?: string | null;
  address?: string | null;
  domain?: string | null;
  reviews_count?: number | string | null;
  /** Category may be a string or an array of strings. */
  category?: string | string[] | null;
  categories?: string[] | null;
  rating?: number | string | { value?: number | string | null } | null;
  rating_value?: number | string | null;
}

/** Raw DataForSEO /business_data/google/reviews task_get item. */
interface ReviewsApiItem {
  review_id?: string | null;
  profile_name?: string | null;
  rating_value?: number | string | null;
  rating?: number | string | { value?: number | string | null } | null;
  review_text?: string | null;
  text?: string | null;
  timestamp?: string | null;
  time?: string | null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // Defensive: some API payloads serialize numbers as strings.
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function ratingOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  if (n != null) return n;
  if (v && typeof v === "object") {
    const val = numOrNull((v as { value?: unknown }).value);
    if (val != null) return val;
  }
  return null;
}

/**
 * Parse raw maps SERP items into MapsSerpItem rows. Pure — fixture-tested.
 * Only items of type `maps_search` with a business title are kept.
 */
export function parseMapsSerpItems(raw: MapsSerpApiItem[]): MapsSerpItem[] {
  const out: MapsSerpItem[] = [];
  for (const item of raw ?? []) {
    const type = (item.type ?? "").toLowerCase();
    if (type && type !== "maps_search") continue;
    const businessName = strOrNull(item.title);
    if (!businessName) continue;
    out.push({
      businessName,
      rating: ratingOrNull(item.rating) ?? numOrNull(item.rating_value),
      reviewCount: numOrNull(item.reviews_count),
      address: strOrNull(item.address),
      placeId: strOrNull(item.place_id),
      url: strOrNull(item.url),
      domain: strOrNull(item.domain),
      position: out.length + 1,
    });
  }
  return out;
}

/**
 * Parse raw business_listings/search items into BusinessListing rows.
 * Pure — fixture-tested.
 */
export function parseBusinessListings(
  raw: BusinessListingsApiItem[],
): BusinessListing[] {
  const out: BusinessListing[] = [];
  for (const item of raw ?? []) {
    const businessName = strOrNull(item.title);
    if (!businessName) continue;
    const cat = item.categories ?? item.category;
    const categories = Array.isArray(cat)
      ? cat.filter((c): c is string => typeof c === "string" && c.trim() !== "")
      : typeof cat === "string" && cat.trim()
        ? [cat.trim()]
        : [];
    out.push({
      businessName,
      placeId: strOrNull(item.place_id),
      rating: ratingOrNull(item.rating) ?? numOrNull(item.rating_value),
      reviewCount: numOrNull(item.reviews_count),
      categories,
      address: strOrNull(item.address),
      domain: strOrNull(item.domain),
    });
  }
  return out;
}

/**
 * Parse raw google/reviews task items into BusinessReviewItem rows.
 * Pure — fixture-tested.
 */
export function parseBusinessReviews(
  raw: ReviewsApiItem[],
): BusinessReviewItem[] {
  const out: BusinessReviewItem[] = [];
  for (const item of raw ?? []) {
    const rating = ratingOrNull(item.rating) ?? numOrNull(item.rating_value);
    const text = strOrNull(item.review_text) ?? strOrNull(item.text);
    // A review with neither rating nor text carries no signal — skip it.
    if (rating == null && text == null) continue;
    out.push({
      externalId: strOrNull(item.review_id),
      author: strOrNull(item.profile_name),
      rating: rating == null ? null : Math.max(1, Math.min(5, Math.round(rating))),
      text,
      publishedAt: strOrNull(item.timestamp) ?? strOrNull(item.time),
    });
  }
  return out;
}
