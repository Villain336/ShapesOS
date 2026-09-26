// Marketr — Phase 10 M6: TalorData adapter.
// TalorData: $1.00 → $0.25/1K at scale; strongest AI-Overview detection
// (64.5% in one 2026 benchmark [UNVERIFIED beyond that benchmark], §M6).
// Default vendor when needAiOverview is set.

import {
  SerpOrganicResult,
  SerpProvider,
  SerpResponse,
  SerpSearchOpts,
  SerpVendorId,
  VendorNotConfigured,
} from "./types";

// TalorData's SERP endpoint path is NOT yet confirmed against their docs.
// TODO(coordinator): verify the exact request/response contract with TalorData
// (endpoint path, auth header, AIO detection fields) before going live.
// The adapter is fully wired to the SerpProvider interface so the kill-switch
// test (swap default vendor → consumers keep working) holds regardless.
const API_URL = "https://api.talordata.com/v1/serp";

/** Tier price per 1K calls. Env override (e.g. TALORDATA_PRICE_PER_1K=0.25). */
export function talordataPricePer1k(): number {
  const raw = Number(process.env.TALORDATA_PRICE_PER_1K ?? "1.00");
  return Number.isFinite(raw) && raw >= 0 ? raw : 1.0;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export class TalorDataAdapter implements SerpProvider {
  readonly vendor: SerpVendorId = "talordata";
  constructor(private readonly apiKey: string | null) {}

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  costPerSerpCallUsd(): number {
    return talordataPricePer1k() / 1000;
  }

  async search(keyword: string, locale: string, opts: SerpSearchOpts = {}): Promise<SerpResponse> {
    if (!this.apiKey) throw new VendorNotConfigured("talordata");
    const num = Math.min(Math.max(opts.numResults ?? 10, 1), 100);
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ keyword, locale, num, detect_ai_overview: opts.needAiOverview ?? true }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`TalorData search failed for "${keyword}" (${locale}): HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      results?: Array<{ position: number; url: string; title: string; domain?: string }>;
      ai_overview?: { present?: boolean };
      serp_features?: string[];
    };
    const results: SerpOrganicResult[] = (data.results ?? []).map((r, i) => ({
      position: r.position ?? i + 1,
      url: r.url,
      domain: r.domain ?? domainOf(r.url),
      title: r.title ?? "",
    }));
    const aiOverviewPresent = data.ai_overview?.present === true;
    const serpFeatures = [...(data.serp_features ?? [])];
    if (aiOverviewPresent && !serpFeatures.includes("ai_overview")) serpFeatures.push("ai_overview");
    return {
      keyword,
      locale,
      results: results.slice(0, num),
      aiOverviewPresent,
      serpFeatures,
      fetchedAt: new Date(),
      vendor: "talordata",
      costUsd: this.costPerSerpCallUsd(),
    };
  }
}
