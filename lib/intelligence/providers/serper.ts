// Marketr — Phase 10 M6: Serper adapter.
// Serper: Google-only retail SERP, $1.00 → $0.30/1K at volume (§M6).
// Route to Serper at volume for price.

import {
  SerpOrganicResult,
  SerpProvider,
  SerpResponse,
  SerpSearchOpts,
  SerpVendorId,
  VendorNotConfigured,
} from "./types";

const API_URL = "https://google.serper.dev/search";

/** Tier price per 1K calls. Env override for volume tiers (e.g. SERPER_PRICE_PER_1K=0.30). */
export function serperPricePer1k(): number {
  const raw = Number(process.env.SERPER_PRICE_PER_1K ?? "1.00");
  return Number.isFinite(raw) && raw >= 0 ? raw : 1.0;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export class SerperAdapter implements SerpProvider {
  readonly vendor: SerpVendorId = "serper";
  constructor(private readonly apiKey: string | null) {}

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  costPerSerpCallUsd(): number {
    return serperPricePer1k() / 1000;
  }

  async search(keyword: string, locale: string, opts: SerpSearchOpts = {}): Promise<SerpResponse> {
    if (!this.apiKey) throw new VendorNotConfigured("serper");
    const num = Math.min(Math.max(opts.numResults ?? 10, 1), 100);
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "X-API-KEY": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: keyword, gl: locale.split("-")[1] ?? "us", hl: locale.split("-")[0] ?? "en", num }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`Serper search failed for "${keyword}" (${locale}): HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      organic?: Array<{ position: number; link: string; title: string }>;
      answerBox?: unknown;
      peopleAlsoAsk?: unknown[];
      knowledgeGraph?: unknown;
    };
    const results: SerpOrganicResult[] = (data.organic ?? []).map((r) => ({
      position: r.position,
      url: r.link,
      domain: domainOf(r.link),
      title: r.title ?? "",
    }));
    const aiOverviewPresent = data.answerBox != null;
    const serpFeatures: string[] = [];
    if (aiOverviewPresent) serpFeatures.push("ai_overview");
    if (data.knowledgeGraph != null) serpFeatures.push("knowledge_graph");
    if (Array.isArray(data.peopleAlsoAsk) && data.peopleAlsoAsk.length > 0) serpFeatures.push("people_also_ask");
    return {
      keyword,
      locale,
      results,
      aiOverviewPresent,
      serpFeatures,
      fetchedAt: new Date(),
      vendor: "serper",
      costUsd: this.costPerSerpCallUsd(),
    };
  }
}
