// ShapesOS — Phase 21A (WS=agentweb): Brave Search API adapter.
//
// GET https://api.search.brave.com/res/v1/web/search?q=…&count=…&freshness=pd|pw|pm|py
// Header X-Subscription-Token. Response web.results[{title,url,description,
// extra_snippets,page_age}] (api-dashboard.search.brave.com/app/documentation/
// web-search/get-started, read 2026-10-10; page_age is not on that page and is
// read only if present).
//
// UNVERIFIED-LIVE: no Brave key exists for ShapesOS yet. This adapter is tested
// against a documented-shape fixture, not a recorded live call. Brave's own
// index is its selling point; the price (about $5 per 1,000 requests) is a
// vendor claim to verify before it is relied on.

import type { SearchOptions, SearchProvider, SearchResponse, SearchResult } from "../types";
import { classifyStatus, isoOrUndefined, SearchProviderError, stripMarkup } from "./errors";

export const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
/** About $5 per 1,000 requests (vendor claim). */
export const BRAVE_COST_MICRO_USD = 5000;
const FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" } as const;

export class BraveProvider implements SearchProvider {
  readonly id = "brave" as const;
  readonly label = "Brave Search";
  readonly mock = false;
  readonly estimatedCostMicroUsd = BRAVE_COST_MICRO_USD;
  constructor(private readonly deps: { apiKey: string; fetchFn?: typeof fetch }) {}

  isConfigured(): boolean {
    return this.deps.apiKey.trim().length > 0;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
    const u = new URL(BRAVE_ENDPOINT);
    u.searchParams.set("q", query);
    u.searchParams.set("count", String(Math.min(Math.max(opts.limit ?? 8, 1), 20)));
    u.searchParams.set("extra_snippets", "true");
    if (opts.freshness) u.searchParams.set("freshness", FRESHNESS[opts.freshness]);
    let res: Response;
    try {
      res = await (this.deps.fetchFn ?? fetch)(u.toString(), { headers: { accept: "application/json", "x-subscription-token": this.deps.apiKey }, signal: opts.signal });
    } catch (err) {
      throw new SearchProviderError("brave", "network", err instanceof Error ? err.message : "network error");
    }
    if (!res.ok) throw classifyStatus("brave", res.status);
    let body: { web?: { results?: Array<Record<string, unknown>> } };
    try {
      body = await res.json();
    } catch {
      throw new SearchProviderError("brave", "bad_response", "Brave returned something that is not JSON.");
    }
    const results: SearchResult[] = [];
    for (const r of body.web?.results ?? []) {
      if (typeof r.url !== "string" || !/^https?:\/\//.test(r.url) || typeof r.title !== "string") continue;
      const extra = Array.isArray(r.extra_snippets) ? (r.extra_snippets as unknown[]).filter((x): x is string => typeof x === "string") : [];
      results.push({
        url: r.url,
        title: stripMarkup(r.title),
        snippet: stripMarkup([typeof r.description === "string" ? r.description : "", ...extra].join(" ")),
        publishedAt: isoOrUndefined(r.page_age),
        provider: "brave",
      });
      if (results.length >= (opts.limit ?? 8)) break;
    }
    return { results, costMicroUsd: BRAVE_COST_MICRO_USD };
  }
}
