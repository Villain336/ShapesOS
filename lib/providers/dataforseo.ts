// Marketr — live DataForSEO Labs provider (spec §11: default supplier,
// swappable via the SeoDataProvider interface in ./types).

import type {
  KeywordIdea,
  KeywordIdeasParams,
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

  async keywordIdeas(params: KeywordIdeasParams): Promise<KeywordIdea[]> {
    if (!this.isConfigured()) {
      throw new Error(
        "DataForSEO credentials are not configured. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.",
      );
    }
    const {
      seed,
      locationCode = 2840,
      languageCode = "en",
      limit = 100,
    } = params;

    const auth = Buffer.from(`${this.login}:${this.password}`).toString(
      "base64",
    );
    const res = await fetch(
      `${API_BASE}/dataforseo_labs/google/keyword_ideas/live`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([
          {
            keyword: seed,
            location_code: locationCode,
            language_code: languageCode,
            include_serp_info: false,
            limit,
            offset: 0,
          },
        ]),
      },
    );

    if (!res.ok) {
      throw new Error(`DataForSEO request failed: HTTP ${res.status}`);
    }

    const json: unknown = await res.json();
    const task = (
      json as { tasks?: Array<{ status_code?: number; status_message?: string; result?: Array<{ items?: LabsItem[] }> }> }
    )?.tasks?.[0];

    if (!task || task.status_code !== 20000) {
      throw new Error(
        `DataForSEO error: ${task?.status_message ?? "unknown error"}`,
      );
    }

    const items = task.result?.[0]?.items ?? [];
    return items.map((item) => {
      const info = item.keyword_info ?? {};
      const props = item.keyword_properties ?? {};
      const difficulty =
        props.keyword_difficulty ??
        (info.competition != null
          ? Math.round(info.competition * 100)
          : null);
      const phrase = item.keyword ?? "";
      return {
        phrase,
        volume: info.search_volume ?? null,
        difficulty,
        cpc: info.cpc ?? null,
        intent: inferIntent(phrase),
      } satisfies KeywordIdea;
    });
  }
}
