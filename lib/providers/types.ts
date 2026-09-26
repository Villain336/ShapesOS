// Marketr — swappable SEO data-provider interface (spec §11, §15).
// DataForSEO is the default supplier; the interface exists so a second
// provider (Serper, Bright Data, …) can be added without touching callers.
// Callers must ONLY depend on these types + getSeoProvider().

export type KeywordIntentLabel =
  | "informational"
  | "navigational"
  | "commercial"
  | "transactional"
  | "unknown";

export interface KeywordIdea {
  phrase: string;
  /** Monthly search volume, null when the provider doesn't report it. */
  volume: number | null;
  /** 0–100, null when the provider doesn't report it. */
  difficulty: number | null;
  /**
   * M5-GATE: which pipeline produced `difficulty` — "vendor" until the
   * difficulty-model eval bar passes, "model" after the gate opens.
   * Unset means "vendor" (pre-M5 rows and gate-closed paths).
   */
  difficultySource?: "vendor" | "model";
  /** Cost per click in USD, null when the provider doesn't report it. */
  cpc: number | null;
  intent: KeywordIntentLabel;
  /** True when the idea came from the built-in mock (no credentials configured). */
  mock?: boolean;
}

export interface KeywordIdeasParams {
  seed: string;
  /** DataForSEO location code, default 2840 (United States). */
  locationCode?: number;
  /** Default "en". */
  languageCode?: string;
  /** Max ideas to return, default 100. */
  limit?: number;
}

export interface CompetitorKeyword {
  phrase: string;
  /** Monthly search volume, null when the provider doesn't report it. */
  volume: number | null;
  /** 0–100, null when the provider doesn't report it. */
  difficulty: number | null;
  /** Cost per click in USD, null when the provider doesn't report it. */
  cpc: number | null;
  intent: KeywordIntentLabel;
  /** Competitor's organic position for this keyword, null when unknown. */
  position: number | null;
  /** URL of the competitor page ranking for this keyword, null when unknown. */
  url: string | null;
  /** True when the row came from the built-in mock (no credentials configured). */
  mock?: boolean;
}

export interface CompetitorKeywordsParams {
  /** Competitor domain, e.g. "example.com". */
  domain: string;
  /** DataForSEO location code, default 2840 (United States). */
  locationCode?: number;
  /** Default "en". */
  languageCode?: string;
  /** Max keywords to return, default 100. */
  limit?: number;
}

export interface SerpResult {
  /** Ranking domain, e.g. "example.com". */
  domain: string;
  /** Full URL of the ranking page. */
  url: string;
  /** Page title as shown in the SERP. */
  title: string;
  /** Meta description / snippet, null when unavailable. */
  description: string | null;
  /** 1-based organic position. */
  position: number;
  /** True when the row came from the built-in mock (no credentials configured). */
  mock?: boolean;
}

export interface SerpResultsParams {
  /** Keyword to fetch the SERP for. */
  keyword: string;
  /** DataForSEO location code, default 2840 (United States). */
  locationCode?: number;
  /** Default "en". */
  languageCode?: string;
  /** Number of organic results to return, default 10. */
  depth?: number;
}

export interface SerpSnapshot {
  /** Top organic results, ordered by position. */
  results: SerpResult[];
  /** "People also ask" questions from the SERP. */
  peopleAlsoAsk: string[];
  /**
   * True when an AI Overview / AI-generated answer was present on the SERP
   * (milestone 5, rank tracking). Live provider detects the provider's
   * ai_overview SERP item; the mock sets it deterministically and flags
   * the snapshot mock: true. Null/absent = unknown.
   */
  aiOverviewPresent?: boolean | null;
  /**
   * Sources cited inside the AI Overview / AI answer, when the provider
   * exposes them (milestone 14). The live DataForSEO parser fills this from
   * the ai_overview item's `references`; the mock leaves it empty.
   * Each entry: { domain, url }.
   */
  aiOverviewCitations?: Array<{ domain: string; url: string | null }>;
  /** True when the snapshot came from the built-in mock (no credentials configured). */
  mock?: boolean;
}

export interface SeoDataProvider {
  /** Stable provider key, e.g. "dataforseo" | "mock". */
  readonly name: string;
  /** True only when backed by a real paid API. */
  readonly isLive: boolean;
  /** Whether the provider has everything it needs to serve real data. */
  isConfigured(): boolean;
  /** Clustered keyword ideas for a seed keyword. */
  keywordIdeas(params: KeywordIdeasParams): Promise<KeywordIdea[]>;
  /** Keywords a competitor domain ranks for (DataForSEO Labs ranked_keywords). */
  competitorKeywords(
    params: CompetitorKeywordsParams,
  ): Promise<CompetitorKeyword[]>;
  /** Top organic SERP snapshot for a keyword (DataForSEO SERP organic live). */
  serpResults(params: SerpResultsParams): Promise<SerpSnapshot>;
  /** Backlinks pointing at the target (DataForSEO Backlinks live). */
  backlinks(params: BacklinksParams): Promise<BacklinksResult>;
  /** Backlink profile summary for the target (DataForSEO Backlinks summary live). */
  backlinksSummary(params: BacklinkSummaryParams): Promise<BacklinkSummaryData>;
  /** Google Maps / local-pack SERP for one grid cell (DataForSEO Maps SERP live). */
  mapsSerp(params: MapsSerpParams): Promise<MapsSerpResult>;
  /** Business profiles for a name/place query (DataForSEO business-data live). */
  businessListings(params: BusinessListingsParams): Promise<BusinessListing[]>;
  /** Reviews for a business (DataForSEO business-data reviews, async task). */
  businessReviews(params: BusinessReviewsParams): Promise<BusinessReviewsResult>;
}

export interface BacklinkItem {
  /** Referring domain, e.g. "example.com". */
  sourceDomain: string;
  /** Full URL of the linking page. */
  sourceUrl: string;
  /** Full URL of the linked page on the target domain. */
  targetUrl: string;
  /** Anchor text, null when the provider doesn't report it. */
  anchorText: string | null;
  /** True for follow links. */
  dofollow: boolean;
  /** First-seen timestamp (ISO), null when unknown. */
  firstSeen: string | null;
  /** Last-seen/visited timestamp (ISO), null when unknown. */
  lastSeen: string | null;
  /** Provider's domain authority rank for the source domain (0–1000, DataForSEO domain_from_rank), null when unknown. */
  sourceRank: number | null;
  /** Spam score 0–100, null when unknown. */
  spamScore: number | null;
  /** True when the row came from the built-in mock (no credentials configured). */
  mock?: boolean;
}

export interface BacklinksParams {
  /** Target domain (or URL), e.g. "example.com". */
  target: string;
  /** Max rows to return, default 100. Capped by MAX_BACKLINK_ROWS_PER_PULL. */
  limit?: number;
  /** "as_is" (default) | "one_per_domain" | "one_per_anchor". */
  mode?: "as_is" | "one_per_domain" | "one_per_anchor";
  /** When true, only follow links. */
  onlyDofollow?: boolean;
}

export interface BacklinksResult {
  /** Parsed backlink rows (up to the requested limit). */
  items: BacklinkItem[];
  /** Provider-reported total backlink count for the target, null when unknown. */
  totalCount: number | null;
  /** Rows actually returned in this response. */
  rowsReturned: number;
  /** True when the rows came from the built-in mock (no credentials configured). */
  mock?: boolean;
}

export interface BacklinkSummaryParams {
  /** Target domain, e.g. "example.com". */
  target: string;
}

export interface BacklinkSummaryData {
  /** Total backlinks in the provider index, null when unknown. */
  total: number | null;
  /** Referring domains count, null when unknown. */
  referringDomains: number | null;
  /** Dofollow backlink count, null when unknown. */
  dofollowCount: number | null;
  /** True when the data came from the built-in mock (no credentials configured). */
  mock?: boolean;
}

/**
 * One business listing from a Google Maps / local-pack SERP
 * (milestone 16: local SEO geo-grids).
 */
export interface MapsSerpItem {
  /** Business name as shown on Google Maps. */
  businessName: string;
  /** Star rating 0–5, null when the provider doesn't report it. */
  rating: number | null;
  /** Review count, null when unknown. */
  reviewCount: number | null;
  /** Street address / locality, null when unknown. */
  address: string | null;
  /** Google place id, null when unknown. */
  placeId: string | null;
  /** Business website URL, null when unknown. */
  url: string | null;
  /** Website domain, null when unknown. */
  domain: string | null;
  /** 1-based position inside the maps result set. */
  position: number;
  /** True when the row came from the built-in mock (no credentials configured). */
  mock?: boolean;
}

export interface MapsSerpParams {
  /** Keyword, e.g. "plumber greensboro nc". */
  keyword: string;
  /** Grid-cell center latitude. */
  lat: number;
  /** Grid-cell center longitude. */
  lng: number;
  /** Map zoom for the coordinate, default 14 (neighborhood scale). */
  zoom?: number;
  /** Default "en". */
  languageCode?: string;
}

export interface MapsSerpResult {
  /** Ranked business listings, ordered by position. */
  items: MapsSerpItem[];
  /** True when the rows came from the built-in mock (no credentials configured). */
  mock?: boolean;
}

/**
 * Business profile from the business-data API
 * (milestone 16: competitor GBP/review intelligence — no Google approval needed).
 */
export interface BusinessListing {
  /** Business name. */
  businessName: string;
  /** Google place id, null when unknown. */
  placeId: string | null;
  /** Star rating 0–5, null when unknown. */
  rating: number | null;
  /** Review count, null when unknown. */
  reviewCount: number | null;
  /** Categories, e.g. ["Plumber", "Drainage service"]. */
  categories: string[];
  /** Address, null when unknown. */
  address: string | null;
  /** Website domain, null when unknown. */
  domain: string | null;
  /** True when the row came from the built-in mock (no credentials configured). */
  mock?: boolean;
}

export interface BusinessListingsParams {
  /** Business name or "keyword near place" query. */
  keyword: string;
  /** Search center latitude. */
  lat: number;
  /** Search center longitude. */
  lng: number;
  /** Max listings to return, default 10. */
  limit?: number;
}

export interface BusinessReviewItem {
  /** Provider-side review id (stable for dedup), null when unknown. */
  externalId: string | null;
  /** Reviewer display name, null when unknown. */
  author: string | null;
  /** Star rating 1–5, null when unknown. */
  rating: number | null;
  /** Review body text, null when empty. */
  text: string | null;
  /** Published timestamp (ISO), null when unknown. */
  publishedAt: string | null;
  /** True when the row came from the built-in mock (no credentials configured). */
  mock?: boolean;
}

export interface BusinessReviewsParams {
  /** Business name (as shown on Google). */
  keyword: string;
  /** Business latitude. */
  lat: number;
  /** Business longitude. */
  lng: number;
  /** Max reviews to return, default 20. */
  depth?: number;
}

export interface BusinessReviewsResult {
  /** Reviews, newest first when the provider orders them. */
  items: BusinessReviewItem[];
  /** True when the rows came from the built-in mock (no credentials configured). */
  mock?: boolean;
}
