// Marketr — live DataForSEO Labs provider (spec §11: default supplier,
// swappable via the SeoDataProvider interface in ./types).

import type {
  CompetitorKeyword,
  CompetitorKeywordsParams,
  KeywordIdea,
  KeywordIdeasParams,
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
      }
      if (results.length >= depth) break;
    }

    return { results, peopleAlsoAsk };
  }
}
