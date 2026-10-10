// ShapesOS — Phase 21A (WS=agentweb): Exa search adapter.
//
// POST https://api.exa.ai/search with x-api-key; body {query, type:"auto",
// numResults, startPublishedDate?, contents:{highlights:{maxCharacters}}};
// response results[{title,url,publishedDate,text,highlights}] and
// costDollars.total (exa.ai/docs/reference/search, read 2026-10-10). The price
// per 1,000 searches is not on that page; "about $7" is the plan's vendor claim
// and is used only when the response reports no cost.
//
// UNVERIFIED-LIVE: no Exa key exists for ShapesOS yet; documented-shape fixture only.

import type { SearchOptions, SearchProvider, SearchResponse, SearchResult } from "../types";
import { classifyStatus, isoOrUndefined, SearchProviderError, stripMarkup } from "./errors";

export const EXA_ENDPOINT = "https://api.exa.ai/search";
export const EXA_FALLBACK_COST_MICRO_USD = 7000;
const DAYS = { day: 1, week: 7, month: 31, year: 365 } as const;

export class ExaProvider implements SearchProvider {
  readonly id = "exa" as const;
  readonly label = "Exa";
  readonly mock = false;
  readonly estimatedCostMicroUsd = EXA_FALLBACK_COST_MICRO_USD;
  constructor(private readonly deps: { apiKey: string; fetchFn?: typeof fetch; now?: () => Date }) {}

  isConfigured(): boolean {
    return this.deps.apiKey.trim().length > 0;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 25);
    const body: Record<string, unknown> = { query, type: "auto", numResults: limit, contents: { highlights: { maxCharacters: 600 } } };
    if (opts.freshness) body.startPublishedDate = new Date((this.deps.now?.() ?? new Date()).getTime() - DAYS[opts.freshness] * 86_400_000).toISOString();
    let res: Response;
    try {
      res = await (this.deps.fetchFn ?? fetch)(EXA_ENDPOINT, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-api-key": this.deps.apiKey }, body: JSON.stringify(body), signal: opts.signal });
    } catch (err) {
      throw new SearchProviderError("exa", "network", err instanceof Error ? err.message : "network error");
    }
    if (!res.ok) throw classifyStatus("exa", res.status);
    let json: { results?: Array<Record<string, unknown>>; costDollars?: { total?: unknown } };
    try {
      json = await res.json();
    } catch {
      throw new SearchProviderError("exa", "bad_response", "Exa returned something that is not JSON.");
    }
    const results: SearchResult[] = [];
    for (const r of json.results ?? []) {
      if (typeof r.url !== "string" || !/^https?:\/\//.test(r.url) || typeof r.title !== "string") continue;
      const highlights = Array.isArray(r.highlights) ? (r.highlights as unknown[]).filter((x): x is string => typeof x === "string").join(" … ") : "";
      const snippet = stripMarkup(highlights || (typeof r.text === "string" ? r.text.slice(0, 900) : ""));
      results.push({ url: r.url, title: stripMarkup(r.title), snippet, publishedAt: isoOrUndefined(r.publishedDate), provider: "exa" });
      if (results.length >= limit) break;
    }
    const total = json.costDollars?.total;
    return { results, costMicroUsd: typeof total === "number" && total >= 0 ? Math.round(total * 1e6) : EXA_FALLBACK_COST_MICRO_USD };
  }
}
