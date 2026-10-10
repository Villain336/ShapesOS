// ShapesOS — Phase 21A (WS=agentweb): the MOCK search provider.
//
// Canned pages about a fictional business so the answer engine works end to end
// without a search key. Everything it returns is labelled mock in the UI. It
// matches by words in common with the query, costs nothing, and returns nothing
// for a query it has no page for (it never invents a result).

import type { SearchOptions, SearchProvider, SearchResponse, SearchResult } from "../types";

const BASE = "https://riverside-dental.example.test";

export const MOCK_PAGES: ReadonlyArray<Omit<SearchResult, "provider">> = [
  { url: `${BASE}/hours`, title: "Opening hours - Riverside Dental", snippet: "Riverside Dental is open Monday to Friday, 9:00 to 17:00, and closed on weekends. Emergency appointments are taken until 12:00 on Saturdays. Phone 020 7946 0000.", publishedAt: "2026-09-20T09:00:00.000Z" },
  { url: `${BASE}/prices`, title: "Prices and NHS bands - Riverside Dental", snippet: "A check-up costs £26.80 under NHS band 1. A filling costs £73.50 under band 2. A crown costs £319.10 under band 3. Private whitening starts at £250.", publishedAt: "2026-08-02T09:00:00.000Z" },
  { url: `${BASE}/new-patients`, title: "New patients - Riverside Dental", snippet: "New patients can register online. Bring photo identification and a list of any medicines you take. The first visit includes a full examination and X-rays if needed.", publishedAt: "2026-06-11T09:00:00.000Z" },
  { url: "https://www.nhs.example.test/dental/charges", title: "NHS dental charges", snippet: "NHS dental charges have three bands. Band 1 covers examinations and advice. Band 2 covers fillings and extractions. Band 3 covers crowns, dentures and bridges. Children under 18 are exempt from charges.", publishedAt: "2026-04-01T09:00:00.000Z" },
  { url: "https://plumbing-guide.example.test/boiler-service", title: "How often should a boiler be serviced?", snippet: "A gas boiler should be serviced once a year by a Gas Safe registered engineer. A service takes about 45 minutes and usually costs between £70 and £100.", publishedAt: "2026-02-14T09:00:00.000Z" },
  { url: "https://seo-basics.example.test/title-tags", title: "Title tags: length and best practice", snippet: "Keep title tags under about 60 characters so they are not cut off in results. Put the main keyword near the start and make each page's title unique.", publishedAt: "2025-11-03T09:00:00.000Z" },
];

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9£]+/).filter((w) => w.length > 2));

export class MockSearchProvider implements SearchProvider {
  readonly id = "mock" as const;
  readonly label = "Mock results";
  readonly mock = true;
  readonly estimatedCostMicroUsd = 0;

  isConfigured(): boolean {
    return true;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
    const q = words(query);
    const scored = MOCK_PAGES.map((p) => ({ p, n: [...words(`${p.title} ${p.snippet}`)].filter((w) => q.has(w)).length })).filter((x) => x.n >= 1).sort((a, b) => b.n - a.n);
    const results: SearchResult[] = scored.slice(0, Math.min(Math.max(opts.limit ?? 6, 1), 10)).map(({ p }) => ({ ...p, provider: "mock" }));
    return { results, costMicroUsd: 0 };
  }
}
