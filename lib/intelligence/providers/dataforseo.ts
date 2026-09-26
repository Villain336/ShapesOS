// Marketr — Phase 10 M6: DataForSEO Standard adapter.
// DataForSEO: $0.60/1K SERP Standard, credits never expire (§M6).
// Breadth pick + clickstream volume bulk path ($132/1M bulk [§M6]).

import {
  SerpOrganicResult,
  SerpProvider,
  SerpResponse,
  SerpSearchOpts,
  SerpVendorId,
  VendorNotConfigured,
  pointToBand,
  type VolumeBand,
} from "./types";

const API_BASE = "https://api.dataforseo.com/v3";

/** Tier price per 1K Standard SERP calls. Env override (e.g. DATAFORSEO_PRICE_PER_1K=0.60). */
export function dataforseoPricePer1k(): number {
  const raw = Number(process.env.DATAFORSEO_PRICE_PER_1K ?? "0.60");
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.6;
}

/**
 * Estimated cost of one clickstream bulk volume lookup. §M6: $132/1M bulk.
 * TODO(coordinator): wire the real bulk ingest endpoint + confirm pricing
 * against the signed DataForSEO contract before depending on this at scale.
 */
export const CLICKSTREAM_BULK_COST_USD = 132 / 1_000_000;

function basicAuth(login: string, password: string): string {
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export class DataForSeoAdapter implements SerpProvider {
  readonly vendor: SerpVendorId = "dataforseo";
  constructor(
    private readonly login: string | null,
    private readonly password: string | null,
  ) {}

  isConfigured(): boolean {
    return !!(this.login && this.password);
  }

  costPerSerpCallUsd(): number {
    return dataforseoPricePer1k() / 1000;
  }

  private headers(): HeadersInit {
    if (!this.login || !this.password) throw new VendorNotConfigured("dataforseo");
    return { Authorization: basicAuth(this.login, this.password), "Content-Type": "application/json" };
  }

  async search(keyword: string, locale: string, opts: SerpSearchOpts = {}): Promise<SerpResponse> {
    const headers = this.headers();
    const num = Math.min(Math.max(opts.numResults ?? 10, 1), 100);
    const [languageCode, locationCode] = locale.split("-");
    const res = await fetch(`${API_BASE}/serp/google/organic/live/advanced`, {
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          keyword,
          language_code: languageCode ?? "en",
          location_code: locationCode ? Number(locationCode) : 2840,
          depth: num,
        },
      ]),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`DataForSEO search failed for "${keyword}" (${locale}): HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      tasks?: Array<{
        result?: Array<{
          items?: Array<{
            type: string;
            rank_group?: number;
            title?: string;
            url?: string;
            domain?: string;
          }>;
        }>;
      }>;
    };
    const items = data.tasks?.[0]?.result?.[0]?.items ?? [];
    const results: SerpOrganicResult[] = [];
    const serpFeatures: string[] = [];
    let aiOverviewPresent = false;
    for (const item of items) {
      if (item.type === "organic") {
        results.push({
          position: item.rank_group ?? results.length + 1,
          url: item.url ?? "",
          domain: item.domain ?? domainOf(item.url ?? ""),
          title: item.title ?? "",
        });
      } else if (item.type === "ai_overview") {
        aiOverviewPresent = true;
        serpFeatures.push("ai_overview");
      } else if (item.type === "featured_snippet") {
        serpFeatures.push("featured_snippet");
      } else if (item.type === "people_also_ask") {
        serpFeatures.push("people_also_ask");
      } else if (item.type === "local_pack") {
        serpFeatures.push("local_pack");
      }
    }
    return {
      keyword,
      locale,
      results: results.slice(0, num),
      aiOverviewPresent,
      serpFeatures: [...new Set(serpFeatures)],
      fetchedAt: new Date(),
      vendor: "dataforseo",
      costUsd: this.costPerSerpCallUsd(),
    };
  }

  /**
   * Volume via DataForSEO Labs clickstream-backed endpoint.
   * Endpoint shape is parsed defensively: response schemas change, so an
   * unrecognized shape raises a typed error instead of a NaN band.
   * TODO(coordinator): confirm the exact clickstream bulk endpoint + pricing
   * against the signed contract; live single-call pricing may differ from
   * the $132/1M bulk figure (§M6).
   */
  async getVolumeBand(keyword: string, locale: string): Promise<{ band: VolumeBand; costUsd: number }> {
    const headers = this.headers();
    const [languageCode, locationCode] = locale.split("-");
    const res = await fetch(`${API_BASE}/dataforseo_labs/google/keyword_overview/live`, {
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          keyword,
          language_code: languageCode ?? "en",
          location_code: locationCode ? Number(locationCode) : 2840,
        },
      ]),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`DataForSEO volume lookup failed for "${keyword}" (${locale}): HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      tasks?: Array<{ result?: Array<{ keyword_info?: { search_volume?: number } }> }>;
    };
    const volume = data.tasks?.[0]?.result?.[0]?.keyword_info?.search_volume;
    if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0) {
      throw new Error(
        `DataForSEO volume lookup for "${keyword}" returned an unrecognized shape — refusing to guess a band.`,
      );
    }
    return { band: pointToBand(volume), costUsd: CLICKSTREAM_BULK_COST_USD };
  }
}
