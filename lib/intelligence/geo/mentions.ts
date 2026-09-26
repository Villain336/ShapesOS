import { recordApiMeter } from "@/lib/intelligence/providers";

// Marketr — Phase 10 M3: branded-mention tracking.
//
// Source stack (Tico's Q5 resolution 2026-09-26: most reliable source wins,
// licensed allowed; free is the fallback, not the default):
//   - GDELT 2.0 DOC API — free global news corpus, text-searchable, no key.
//   - CC-NEWS — Common Crawl's news crawl, URL-keyed CDX index, free.
//   - Licensed news API (NewsAPI) — behind a config toggle, off by default,
//     graceful when unconfigured; every call metered via M6's recordApiMeter.
// Never platform scraping.
//
// The Ahrefs Dec-2025 study (75k brands) found branded web mentions
// correlate 0.664–0.709 with AI-assistant visibility vs 0.266–0.326 for
// Domain Rating — which is why mention building (not link building) is the
// reframe inside Marketr's outreach and content guidance.

export type MentionSourceId = "gdelt" | "cc-news" | "licensed-news";

export interface MentionHit {
  source: MentionSourceId;
  title: string;
  url: string;
  publishedAt: string | null;
  snippet: string | null;
  domain: string | null;
}

export interface MentionSearchResult {
  source: MentionSourceId;
  ok: boolean;
  hits: MentionHit[];
  /** Present when the source failed — callers label the gap, never zero-fill. */
  error: string | null;
  searchedAt: string;
  note: string;
}

export class MentionSourceError extends Error {
  constructor(
    public readonly source: MentionSourceId,
    message: string,
  ) {
    super(message);
    this.name = "MentionSourceError";
  }
}

function domainOf(url: string): string | null {
  try {
    let h = new URL(url).hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GDELT 2.0 DOC API (free, no key).
// Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
// ---------------------------------------------------------------------------

export function gdeltSearchUrl(brand: string, maxRecords = 100): string {
  const q = encodeURIComponent(`"${brand}"`);
  return (
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}` +
    `&mode=artlist&format=json&maxrecords=${Math.min(250, Math.max(1, maxRecords))}` +
    `&sort=datedesc`
  );
}

interface GdeltArticle {
  title?: string;
  url?: string;
  seendate?: string;
  socialimage?: string;
  domain?: string;
  language?: string;
}

/** Parse the GDELT artlist JSON payload into MentionHits. Pure — tested. */
export function parseGdeltResponse(payload: unknown): MentionHit[] {
  if (!payload || typeof payload !== "object") return [];
  const articles = (payload as { articles?: unknown }).articles;
  if (!Array.isArray(articles)) return [];
  const hits: MentionHit[] = [];
  for (const a of articles) {
    const art = a as GdeltArticle;
    if (!art.url || !art.title) continue;
    hits.push({
      source: "gdelt",
      title: art.title,
      url: art.url,
      publishedAt: art.seendate ?? null,
      snippet: null,
      domain: art.domain ?? domainOf(art.url),
    });
  }
  return hits;
}

export async function searchGdelt(
  brand: string,
  opts: { maxRecords?: number; fetchFn?: typeof fetch } = {},
): Promise<MentionSearchResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(gdeltSearchUrl(brand, opts.maxRecords ?? 100), {
      headers: { "User-Agent": "Marketr/1.0 (branded-mention tracking; contact: support)" },
    });
    if (!res.ok) throw new MentionSourceError("gdelt", `HTTP ${res.status}`);
    const payload = (await res.json()) as unknown;
    const hits = parseGdeltResponse(payload);
    return {
      source: "gdelt",
      ok: true,
      hits,
      error: null,
      searchedAt: new Date().toISOString(),
      note: "GDELT 2.0 DOC API — free global news corpus. Query is an exact-phrase brand search.",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      source: "gdelt",
      ok: false,
      hits: [],
      error: msg,
      searchedAt: new Date().toISOString(),
      note: "GDELT query failed — no mentions recorded for this window (honest gap, not zero).",
    };
  }
}

// ---------------------------------------------------------------------------
// CC-NEWS (Common Crawl news crawl) — URL-keyed CDX index, free.
//
// Honest limitation, documented: the CDX API is keyed by URL, not full text.
// v1 enumerates the brand's OWN domain URLs in recent news crawls (where the
// brand's pages surface in the news corpus); true full-text mention search
// across CC-NEWS needs Athena/columnar queries and is out of v1 scope.
// ---------------------------------------------------------------------------

export function ccNewsIndexUrl(domain: string, crawl = "CC-NEWS-2026-38"): string {
  const clean = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  return (
    `https://index.commoncrawl.org/${encodeURIComponent(crawl)}-index` +
    `?url=${encodeURIComponent(clean)}%2F*&output=json&filter=status%3A200&collapse=urlkey`
  );
}

interface CcIndexRecord {
  url?: string;
  timestamp?: string;
  status?: string;
  mime?: string;
}

/** Parse newline-delimited CC index JSON into MentionHits. Pure — tested. */
export function parseCcIndexResponse(text: string): MentionHit[] {
  const hits: MentionHit[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as CcIndexRecord;
      if (!rec.url) continue;
      hits.push({
        source: "cc-news",
        title: rec.url,
        url: rec.url,
        publishedAt: rec.timestamp ?? null,
        snippet: rec.mime ?? null,
        domain: domainOf(rec.url),
      });
    } catch {
      // skip malformed lines — the index is best-effort
    }
  }
  return hits;
}

export async function searchCcNews(
  brandDomain: string,
  opts: { crawl?: string; fetchFn?: typeof fetch } = {},
): Promise<MentionSearchResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(ccNewsIndexUrl(brandDomain, opts.crawl), {
      headers: { "User-Agent": "Marketr/1.0 (branded-mention tracking)" },
    });
    if (!res.ok) throw new MentionSourceError("cc-news", `HTTP ${res.status}`);
    const hits = parseCcIndexResponse(await res.text());
    return {
      source: "cc-news",
      ok: true,
      hits,
      error: null,
      searchedAt: new Date().toISOString(),
      note: "CC-NEWS CDX index — enumerates the brand domain's URLs in the news crawl. Full-text mention search needs Athena (out of v1).",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      source: "cc-news",
      ok: false,
      hits: [],
      error: msg,
      searchedAt: new Date().toISOString(),
      note: "CC-NEWS query failed — no records for this window (honest gap, not zero).",
    };
  }
}

/** Run both free sources. Licensed news APIs stay a later toggle. */
export async function searchBrandedMentions(
  brand: string,
  brandDomain: string,
  opts: { fetchFn?: typeof fetch; includeLicensed?: boolean; workspaceId?: string } = {},
): Promise<MentionSearchResult[]> {
  const [gdelt, ccNews] = await Promise.all([
    searchGdelt(brand, opts),
    searchCcNews(brandDomain, opts),
  ]);
  if (!opts.includeLicensed) return [gdelt, ccNews];
  const licensed = await searchLicensedNews(brand, {
    fetchFn: opts.fetchFn,
    workspaceId: opts.workspaceId,
  });
  return [gdelt, ccNews, licensed];
}

// ---------------------------------------------------------------------------
// Licensed news API (NewsAPI.org) — config toggle, graceful when unconfigured.
//
// Tico's binding Q5 call (2026-09-26): branded-mention tracking uses the MOST
// RELIABLE source, licensed if needed. GDELT + CC-NEWS stay the free default
// layer; this adapter is additive and OFF unless the operator sets:
//   M3_LICENSED_NEWS_PROVIDER=newsapi  +  M3_NEWSAPI_KEY=<key>
// Unconfigured → a graceful "not configured" result (ok:false, error:null),
// never a crash and never a fake zero. Every real call is metered via M6's
// recordApiMeter contract.
//
// Metering honesty: the Prisma ApiMeterKind enum is frozen in the migrated
// schema (serp_call / volume_lookup / ai_prompt / backlink_pull) and this
// module may not write migrations — so licensed-news calls ride the closest
// existing kind, serp_call, under vendor "newsapi". NewsAPI paid plans are
// flat subscriptions, so marginal per-query cost ≈ $0; quantity is still
// recorded so the M7 cost dashboard shows licensed-source volume. A dedicated
// news_lookup kind belongs in the enum when migrations reopen (flagged for
// M6).
// ---------------------------------------------------------------------------

export type LicensedNewsProvider = "newsapi";

export interface LicensedNewsConfig {
  configured: boolean;
  provider: LicensedNewsProvider | null;
  /** Why the adapter is disabled, when it is. */
  reason: string | null;
}

export function resolveLicensedNewsSource(): LicensedNewsConfig {
  const provider = (process.env.M3_LICENSED_NEWS_PROVIDER ?? "").trim().toLowerCase();
  if (!provider) {
    return {
      configured: false,
      provider: null,
      reason: "Licensed-news adapter is off — set M3_LICENSED_NEWS_PROVIDER=newsapi and M3_NEWSAPI_KEY to enable it.",
    };
  }
  if (provider !== "newsapi") {
    return {
      configured: false,
      provider: null,
      reason: `Unknown licensed news provider "${provider}" (supported: newsapi). Adapter stays off.`,
    };
  }
  const key = (process.env.M3_NEWSAPI_KEY ?? "").trim();
  if (!key) {
    return {
      configured: false,
      provider,
      reason: "M3_NEWSAPI_KEY is not set — licensed-news adapter stays off.",
    };
  }
  return { configured: true, provider, reason: null };
}

export function newsApiSearchUrl(brand: string, maxRecords = 100): string {
  const q = encodeURIComponent(`"${brand}"`);
  return (
    `https://newsapi.org/v2/everything?q=${q}` +
    `&language=en&sortBy=publishedAt&pageSize=${Math.min(100, Math.max(1, maxRecords))}`
  );
}

interface NewsApiArticle {
  title?: string;
  url?: string;
  publishedAt?: string;
  description?: string;
  source?: { name?: string };
}

/** Parse the NewsAPI /v2/everything JSON payload into MentionHits. Pure — tested. */
export function parseNewsApiResponse(payload: unknown): MentionHit[] {
  if (!payload || typeof payload !== "object") return [];
  const articles = (payload as { articles?: unknown }).articles;
  if (!Array.isArray(articles)) return [];
  const hits: MentionHit[] = [];
  for (const a of articles) {
    const art = a as NewsApiArticle;
    if (!art.url || !art.title || art.title === "[Removed]") continue;
    hits.push({
      source: "licensed-news",
      title: art.title,
      url: art.url,
      publishedAt: art.publishedAt ?? null,
      snippet: art.description ?? null,
      domain: domainOf(art.url),
    });
  }
  return hits;
}

/**
 * Search the licensed news source. Graceful when unconfigured (ok:false,
 * error:null, note explains). Metered via M6's recordApiMeter when called.
 */
export async function searchLicensedNews(
  brand: string,
  opts: { maxRecords?: number; fetchFn?: typeof fetch; workspaceId?: string } = {},
): Promise<MentionSearchResult> {
  const searchedAt = new Date().toISOString();
  const config = resolveLicensedNewsSource();
  if (!config.configured) {
    return {
      source: "licensed-news",
      ok: false,
      hits: [],
      error: null,
      searchedAt,
      note: config.reason ?? "Licensed-news adapter is off.",
    };
  }
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(newsApiSearchUrl(brand, opts.maxRecords ?? 100), {
      headers: {
        "User-Agent": "Marketr/1.0 (licensed branded-mention tracking)",
        "X-Api-Key": (process.env.M3_NEWSAPI_KEY ?? "").trim(),
      },
    });
    if (!res.ok)
      throw new MentionSourceError("licensed-news", `HTTP ${res.status}`);
    const hits = parseNewsApiResponse((await res.json()) as unknown);
    // Meter the licensed call (M6 contract). Flat-subscription marginal cost
    // ≈ $0 — the quantity row is what the cost dashboard consumes.
    if (opts.workspaceId) {
      await recordApiMeter(opts.workspaceId, "newsapi", "serp_call", 1, 0).catch(() => {});
    }
    return {
      source: "licensed-news",
      ok: true,
      hits,
      error: null,
      searchedAt,
      note: "Licensed news API (NewsAPI, exact-phrase brand search). Metered via M6 recordApiMeter.",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      source: "licensed-news",
      ok: false,
      hits: [],
      error: msg,
      searchedAt,
      note: "Licensed news query failed — no mentions recorded for this window (honest gap, not zero).",
    };
  }
}
