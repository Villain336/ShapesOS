// Marketr — Phase 10 M4: sitemap parsing for new-page discovery.
//
// Handles both <urlset> documents and <sitemapindex> documents (recursed,
// depth-capped). Plain regex parsing — no new npm dependencies. Decodes the
// standard XML entities; skips entries with unparseable <loc>.

import type { SitemapEntry } from "./types";

/** Decode the XML entities that appear inside <loc>/<lastmod>. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractTag(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block);
  return m ? decodeXmlEntities(m[1].trim()) : undefined;
}

function extractBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

export interface SitemapParseOpts {
  /** Cap on total URLs returned (safety). Default 10000. */
  maxUrls?: number;
  /** Max sitemap-index recursion depth. Default 3. */
  maxDepth?: number;
}

/**
 * Fetch + parse a sitemap URL, following sitemap indexes recursively.
 * fetchPage performs the polite GET (the caller owns robots/politeness).
 */
export async function fetchSitemapEntries(
  sitemapUrl: string,
  fetchPage: (url: string) => Promise<{ status: number; text: string }>,
  opts: SitemapParseOpts = {},
): Promise<SitemapEntry[]> {
  const maxUrls = opts.maxUrls ?? 10000;
  const maxDepth = opts.maxDepth ?? 3;
  const entries: SitemapEntry[] = [];
  const seenLocs = new Set<string>();

  async function walk(url: string, depth: number): Promise<void> {
    if (entries.length >= maxUrls || depth > maxDepth) return;
    let page: { status: number; text: string };
    try {
      page = await fetchPage(url);
    } catch {
      return; // unreachable sitemap: treat as empty, never throw the job
    }
    if (page.status < 200 || page.status >= 300) return;
    const xml = page.text;

    // Sitemap index → recurse into each child <loc>.
    if (/<sitemapindex[\s>]/i.test(xml)) {
      for (const block of extractBlocks(xml, "sitemap")) {
        const loc = extractTag(block, "loc");
        if (loc && !seenLocs.has(loc)) {
          seenLocs.add(loc);
          await walk(loc, depth + 1);
          if (entries.length >= maxUrls) return;
        }
      }
      return;
    }

    for (const block of extractBlocks(xml, "url")) {
      const loc = extractTag(block, "loc");
      if (!loc || seenLocs.has(loc)) continue;
      seenLocs.add(loc);
      const lastmod = extractTag(block, "lastmod");
      entries.push(lastmod ? { url: loc, lastmod } : { url: loc });
      if (entries.length >= maxUrls) return;
    }
  }

  await walk(sitemapUrl, 0);
  return entries;
}

/** Pure helper: parse entries from raw XML (used by tests + callers that
 *  already fetched). Handles urlset only; indexes need fetch — use
 *  fetchSitemapEntries for those. */
export function parseSitemapXml(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  for (const block of extractBlocks(xml, "url")) {
    const loc = extractTag(block, "loc");
    if (!loc) continue;
    const lastmod = extractTag(block, "lastmod");
    entries.push(lastmod ? { url: loc, lastmod } : { url: loc });
  }
  return entries;
}
