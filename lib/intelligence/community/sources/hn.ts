// Marketr — Phase 10 M8: Hacker News opportunity adapter.
//
// Uses the Algolia HN Search API (https://hn.algolia.com/api/v1) — free,
// no key, official search surface. Real HTTP via an injectable fetch so
// tests run on recorded fixtures with zero live network.
//
// Legal: reading HN's public search API is clean. We never scrape
// news.ycombinator.com HTML.

import type { RawThread } from "../types";

export interface HnSearchOptions {
  fetchImpl?: typeof fetch;
  /** Hits per query (default 20). */
  hitsPerPage?: number;
}

interface HnHit {
  objectID: string;
  title?: string | null;
  url?: string | null;
  author?: string | null;
  points?: number | null;
  num_comments?: number | null;
  created_at?: string | null;
  comment_text?: string | null;
  story_text?: string | null;
  _tags?: string[];
}

const API = "https://hn.algolia.com/api/v1/search";

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function hitToThread(hit: HnHit): RawThread {
  const isComment = (hit._tags ?? []).includes("comment");
  const title = hit.title ?? "(comment)";
  const url = isComment
    ? `https://news.ycombinator.com/item?id=${hit.objectID}`
    : (hit.url && hit.url.length > 0
        ? hit.url
        : `https://news.ycombinator.com/item?id=${hit.objectID}`);
  const text = stripHtml(hit.comment_text ?? hit.story_text ?? "");
  const createdAt = hit.created_at ? new Date(hit.created_at) : new Date();
  return {
    source: "hacker_news",
    externalId: hit.objectID,
    title: stripHtml(title).slice(0, 300),
    url,
    author: hit.author ?? undefined,
    text: text.slice(0, 4000),
    points: typeof hit.points === "number" ? hit.points : undefined,
    commentCount: typeof hit.num_comments === "number" ? hit.num_comments : undefined,
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
  };
}

/**
 * Search HN stories + comments for a query. Never throws for transport
 * problems — returns an empty list so one dead source can't kill a scan.
 */
export async function searchHackerNews(
  query: string,
  opts: HnSearchOptions = {},
): Promise<RawThread[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hitsPerPage = Math.min(Math.max(opts.hitsPerPage ?? 20, 1), 50);
  const url =
    `${API}?query=${encodeURIComponent(query)}` +
    `&tags=(story,comment)&hitsPerPage=${hitsPerPage}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "Marketr-M8/1.0" },
    });
  } catch (e) {
    console.warn(`[m8/hn] fetch failed for query "${query}": ${(e as Error).message}`);
    return [];
  }
  if (!res.ok) {
    console.warn(`[m8/hn] HTTP ${res.status} for query "${query}"`);
    return [];
  }
  let body: { hits?: HnHit[] };
  try {
    body = (await res.json()) as { hits?: HnHit[] };
  } catch {
    console.warn(`[m8/hn] invalid JSON for query "${query}"`);
    return [];
  }
  const hits = Array.isArray(body.hits) ? body.hits : [];
  return hits
    .filter((h) => h && typeof h.objectID === "string")
    .map(hitToThread);
}
