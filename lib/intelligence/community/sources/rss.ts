// Marketr — Phase 10 M8: niche-forum RSS adapter.
//
// The user configures RSS feeds (Discourse/NodeBB/Flarum RSS, Substack,
// niche community feeds). Fetch + parse only — no scraping of forum HTML,
// no credentialed sessions. Dependency-free parser for RSS 2.0 and Atom.

import type { RawThread, RssFeedConfig } from "../types";

export interface RssFetchOptions {
  fetchImpl?: typeof fetch;
  /** Max items per feed (default 15). */
  maxItems?: number;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : "";
}

function firstAttr(block: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["'][^>]*\\/?>`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

function parseItems(xml: string, feedName: string): RawThread[] {
  const out: RawThread[] = [];
  // RSS 2.0 <item> … </item>
  const itemBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const b of itemBlocks) {
    const title = firstTag(b, "title");
    const link = firstTag(b, "link") || firstAttr(b, "link", "href");
    const pub = firstTag(b, "pubDate") || firstTag(b, "dc:date");
    const text = firstTag(b, "description") || firstTag(b, "content:encoded");
    if (!title || !link) continue;
    const createdAt = pub ? new Date(pub) : new Date();
    out.push({
      source: "rss",
      externalId: link,
      title: title.slice(0, 300),
      url: link,
      text: text.slice(0, 4000),
      createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
      feedName,
    });
  }
  // Atom <entry> … </entry>
  const entryBlocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const b of entryBlocks) {
    const title = firstTag(b, "title");
    const link = firstAttr(b, "link", "href") || firstTag(b, "link");
    const pub = firstTag(b, "published") || firstTag(b, "updated");
    const text = firstTag(b, "summary") || firstTag(b, "content");
    if (!title || !link) continue;
    const createdAt = pub ? new Date(pub) : new Date();
    out.push({
      source: "rss",
      externalId: link,
      title: title.slice(0, 300),
      url: link,
      text: text.slice(0, 4000),
      createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
      feedName,
    });
  }
  return out;
}

/** Fetch + parse one configured feed. Never throws for transport problems. */
export async function fetchRssFeed(
  feed: RssFeedConfig,
  opts: RssFetchOptions = {},
): Promise<RawThread[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxItems = Math.min(Math.max(opts.maxItems ?? 15, 1), 50);
  let res: Response;
  try {
    res = await fetchImpl(feed.url, {
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml", "User-Agent": "Marketr-M8/1.0" },
    });
  } catch (e) {
    console.warn(`[m8/rss] fetch failed for "${feed.name}": ${(e as Error).message}`);
    return [];
  }
  if (!res.ok) {
    console.warn(`[m8/rss] HTTP ${res.status} for "${feed.name}"`);
    return [];
  }
  const xml = await res.text();
  return parseItems(xml, feed.name).slice(0, maxItems);
}

/** Fetch all configured feeds (parallel). Empty config = empty list. */
export async function fetchRssFeeds(
  feeds: RssFeedConfig[],
  opts: RssFetchOptions = {},
): Promise<RawThread[]> {
  if (!feeds || feeds.length === 0) return [];
  const settled = await Promise.allSettled(feeds.map((f) => fetchRssFeed(f, opts)));
  const out: RawThread[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") out.push(...s.value);
  }
  return out;
}
