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
}
