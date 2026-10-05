// ShapesOS Phase 11 (seotools): live-URL site audit.
//
// The files audit (./scanner.ts) reads a site's working copy. This crawls
// the site as a search engine sees it: real status codes, redirects,
// canonical / hreflang / noindex, structured data, robots.txt + sitemap,
// and a sample of outbound links. It runs the SAME per-page checks as the
// files scan (checkHtmlPage), so a live audit and a files audit speak the
// same finding categories.
//
// Reused, not rebuilt:
//   - lib/intelligence/fleet/polite-fetch  PoliteFetcher: per-domain delay
//     (robots crawl-delay wins), timeout, identifiable UA, and every request
//     (and every redirect hop) through safeFetch → lib/safe-url SSRF guards
//   - lib/intelligence/fleet/robots        the robots.txt parser
//   - lib/intelligence/fleet/sitemap       fetchSitemapEntries (urlset + index; seeds the crawl)
//   - lib/seo/internal-links               extractInternalHrefs
//
// Rendering: static fetch by default. A PageRenderer (./render-sandbox.ts:
// headless Chromium inside the Phase 8 sandbox) can supply the rendered DOM
// for pages that need JavaScript; the crawl summary always says which was
// used. Status codes and headers always come from the real HTTP response.
//
// Every live finding is autoFixable=false: its "file" is a URL, and the fix
// agent only edits working-copy files (a files audit can auto-fix the same
// categories).

import { PoliteFetcher, type FetchedPage } from "@/lib/intelligence/fleet/polite-fetch";
import { parseRobots, isAllowed, crawlDelayFor, FLEET_BOT_TOKEN, type RobotsRules } from "@/lib/intelligence/fleet/robots";
import { fetchSitemapEntries } from "@/lib/intelligence/fleet/sitemap";
import { extractInternalHrefs } from "@/lib/seo/internal-links";
import { assertSafeUrl, UnsafeUrlError, type ResolveFn } from "@/lib/safe-url";
import { checkHtmlPage, type ScanFinding } from "./scanner";
import { checkStructuredData } from "./structured-data";

/** What the crawler needs from a fetcher (PoliteFetcher in production). */
export interface LiveFetcher {
  get(url: string, opts?: { maxChars?: number }): Promise<FetchedPage>;
  setCrawlDelay?(domain: string, seconds: number): void;
}

/** Supplies the rendered DOM for a URL (JS rendering), or null to fall back to static. */
export interface PageRenderer {
  readonly label: string;
  render(url: string): Promise<{ html: string } | null>;
}

export interface LiveCrawlOptions {
  startUrl: string;
  /** Pages to fetch (default 25, max 200). */
  maxPages?: number;
  /** Outbound links to check (default 10, max 50). */
  maxExternalChecks?: number;
  fetcher?: LiveFetcher;
  renderer?: PageRenderer | null;
  /** DNS seam for the up-front SSRF check (tests). */
  resolve?: ResolveFn;
  /** Polite delay between hits to the same host (default 1000 ms). */
  minDelayMs?: number;
}

export interface LivePageRecord {
  url: string;
  status: number | null;
  finalUrl?: string;
  redirects: number;
  title?: string;
  error?: string;
  rendered?: boolean;
}

export interface LiveCrawlSummary {
  startUrl: string;
  origin: string;
  rendering: "static" | "js";
  renderingNote: string;
  maxPages: number;
  pagesCrawled: number;
  pagesBlockedByRobots: number;
  /** True when the page budget ran out before the queue did. */
  truncated: boolean;
  statusCounts: Record<string, number>;
  robots: { found: boolean; status: number | null; sitemaps: string[] };
  sitemap: { url: string | null; found: boolean; urlCount: number };
  externalChecked: number;
  pages: LivePageRecord[];
}

export interface LiveCrawlResult {
  findings: ScanFinding[];
  crawl: LiveCrawlSummary;
}

export const LIVE_DEFAULT_MAX_PAGES = 25;
export const LIVE_MAX_PAGES_CAP = 200;
const HTML_MAX_CHARS = 1_000_000;
const PAGE_RECORDS_CAP = 200;

export class LiveAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveAuditError";
  }
}

// ---------------------------------------------------------------------------
// HTML helpers (pure)
// ---------------------------------------------------------------------------

/** Attributes of every `<tag …>` in the HTML (names lower-cased, values entity-decoded). */
export function tagAttributes(html: string, tag: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[1]))) {
      attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
    }
    out.push(attrs);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function relTokens(attrs: Record<string, string>): string[] {
  return (attrs.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

function hostKey(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Normalize a crawl URL: drop the fragment, keep the query. */
export function crawlKey(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.toString();
  } catch {
    return u;
  }
}

function pageTitle(html: string): string | undefined {
  const t = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  return t ? decodeEntities(t.replace(/\s+/g, " ").trim()).slice(0, 200) : undefined;
}

const HREFLANG_RE = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;

/**
 * Canonical, hreflang and noindex checks for one live page. Pure: takes the
 * page URL, its (rendered or static) HTML and the response headers.
 */
export function checkIndexingSignals(
  url: string,
  html: string,
  headers: Record<string, string> = {},
): { findings: ScanFinding[]; canonical: string | null } {
  const findings: ScanFinding[] = [];
  const links = tagAttributes(html, "link");
  const metas = tagAttributes(html, "meta");
  const push = (category: string, detail: string, fixHint: string) =>
    findings.push({ category, filePath: url, line: null, detail, fixHint, autoFixable: false });

  // Canonical
  const canonicals = links.filter((l) => relTokens(l).includes("canonical") && l.href);
  let canonical: string | null = null;
  if (canonicals.length === 0) {
    push("canonical-issue", `${url} has no rel="canonical" link.`, "Add <link rel=\"canonical\" href=\"…\"> pointing at the preferred URL of this page.");
  } else {
    const distinct = [...new Set(canonicals.map((c) => c.href.trim()))];
    if (distinct.length > 1) {
      push("canonical-issue", `${url} declares ${distinct.length} different canonical URLs (${distinct.slice(0, 3).join(", ")}).`, "Keep exactly one canonical link per page.");
    }
    try {
      canonical = new URL(distinct[0], url).toString();
      if (hostKey(canonical) !== hostKey(url)) {
        push("canonical-issue", `${url} is canonicalised to another domain: ${canonical}.`, "Point the canonical at this site unless the page is a deliberate syndicated copy.");
      }
    } catch {
      push("canonical-issue", `${url} has an unparseable canonical href "${distinct[0].slice(0, 120)}".`, "Use an absolute https:// URL in the canonical link.");
    }
  }

  // hreflang
  const alternates = links.filter((l) => relTokens(l).includes("alternate") && l.hreflang !== undefined);
  if (alternates.length > 0) {
    const bad = alternates.filter((a) => !HREFLANG_RE.test(a.hreflang.trim()));
    if (bad.length) {
      push("hreflang-issue", `${url} has invalid hreflang value${bad.length === 1 ? "" : "s"}: ${bad.map((b) => `"${b.hreflang}"`).slice(0, 5).join(", ")}.`, "Use ISO 639-1 language codes with an optional ISO 3166-1 region (e.g. en, en-GB) or x-default.");
    }
    const relative = alternates.filter((a) => !/^https?:\/\//i.test((a.href ?? "").trim()));
    if (relative.length) {
      push("hreflang-issue", `${url} has ${relative.length} hreflang link${relative.length === 1 ? "" : "s"} without an absolute URL.`, "hreflang hrefs must be fully-qualified URLs.");
    }
    const self = crawlKey(url).replace(/\/$/, "");
    const hasSelf = alternates.some((a) => {
      try {
        return crawlKey(new URL(a.href ?? "", url).toString()).replace(/\/$/, "") === self;
      } catch {
        return false;
      }
    });
    if (!hasSelf) {
      push("hreflang-issue", `${url} lists hreflang alternates but none points back at this page.`, "Include a self-referencing hreflang link for the page's own language.");
    }
    const byLang = new Map<string, Set<string>>();
    for (const a of alternates) {
      const k = a.hreflang.trim().toLowerCase();
      if (!byLang.has(k)) byLang.set(k, new Set());
      byLang.get(k)!.add((a.href ?? "").trim());
    }
    const conflicting = [...byLang.entries()].filter(([, v]) => v.size > 1).map(([k]) => k);
    if (conflicting.length) {
      push("hreflang-issue", `${url} maps hreflang ${conflicting.join(", ")} to more than one URL.`, "Each hreflang value must point at exactly one URL.");
    }
  }

  // noindex (meta robots / googlebot, or the X-Robots-Tag header)
  const robotsMeta = metas
    .filter((m) => ["robots", "googlebot"].includes((m.name ?? "").toLowerCase()))
    .map((m) => (m.content ?? "").toLowerCase());
  const header = (headers["x-robots-tag"] ?? "").toLowerCase();
  if (robotsMeta.some((c) => /\b(noindex|none)\b/.test(c)) || /\b(noindex|none)\b/.test(header)) {
    push("noindex-page", `${url} tells search engines not to index it (${header && /noindex|none/.test(header) ? "X-Robots-Tag header" : "meta robots"}).`, "Remove noindex if this page should appear in search results; leave it if it is deliberately private.");
  }
  return { findings, canonical };
}

/** Sitemap URLs declared in robots.txt (`Sitemap:` lines). */
export function robotsSitemaps(txt: string): string[] {
  const out: string[] = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function isHtml(page: FetchedPage): boolean {
  const ct = (page.contentType ?? "").toLowerCase();
  if (ct) return ct.includes("text/html") || ct.includes("application/xhtml");
  return /^\s*<(!doctype|html)/i.test(page.text);
}

function externalHrefs(html: string, baseUrl: string): string[] {
  const host = hostKey(baseUrl);
  const out = new Set<string>();
  for (const a of tagAttributes(html, "a")) {
    const raw = (a.href ?? "").trim();
    if (!/^https?:\/\//i.test(raw)) continue;
    try {
      const u = new URL(raw);
      if (hostKey(u.toString()) === host) continue;
      u.hash = "";
      out.add(u.toString());
    } catch {
      // unparseable — skip
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// The crawl
// ---------------------------------------------------------------------------

export async function crawlSite(opts: LiveCrawlOptions): Promise<LiveCrawlResult> {
  let start: URL;
  try {
    await assertSafeUrl(opts.startUrl, { resolve: opts.resolve });
    start = new URL(opts.startUrl.trim());
  } catch (err) {
    throw new LiveAuditError(
      err instanceof UnsafeUrlError ? `Can't audit that URL: ${err.message}` : "Can't audit that URL: it is not a valid http(s) address.",
    );
  }
  const maxPages = Math.min(Math.max(1, Math.floor(opts.maxPages ?? LIVE_DEFAULT_MAX_PAGES)), LIVE_MAX_PAGES_CAP);
  const maxExternal = Math.min(Math.max(0, Math.floor(opts.maxExternalChecks ?? 10)), 50);
  const fetcher: LiveFetcher =
    opts.fetcher ?? new PoliteFetcher({ minDelayMs: opts.minDelayMs ?? 1000, timeoutMs: 15_000, resolve: opts.resolve });
  const origin = start.origin;
  const siteHost = hostKey(origin);
  const findings: ScanFinding[] = [];
  const statusCounts: Record<string, number> = {};
  const pages: LivePageRecord[] = [];
  const add = (f: Omit<ScanFinding, "autoFixable">) => findings.push({ ...f, autoFixable: false });

  // robots.txt
  let rules: RobotsRules | null = null;
  const robots = { found: false, status: null as number | null, sitemaps: [] as string[] };
  try {
    const r = await fetcher.get(`${origin}/robots.txt`, { maxChars: 200_000 });
    robots.status = r.status;
    if (r.status === 200 && !isHtml(r)) {
      robots.found = true;
      rules = parseRobots(r.text);
      robots.sitemaps = robotsSitemaps(r.text).filter((u) => hostKey(u) === siteHost);
      const delay = crawlDelayFor(rules, FLEET_BOT_TOKEN);
      if (delay !== undefined) fetcher.setCrawlDelay?.(start.hostname, Math.min(delay, 30));
    }
  } catch {
    // unreachable robots.txt counts as missing
  }

  // sitemap.xml (declared in robots.txt, else /sitemap.xml) — seeds the crawl
  const sitemapUrl = robots.sitemaps[0] ?? `${origin}/sitemap.xml`;
  const sitemap = { url: sitemapUrl as string | null, found: false, urlCount: 0 };
  const seeds: string[] = [crawlKey(start.toString())];
  try {
    let rootOk = false;
    const entries = await fetchSitemapEntries(
      sitemapUrl,
      async (u) => {
        const r = await fetcher.get(u, { maxChars: 5_000_000 });
        if (u === sitemapUrl) rootOk = r.status === 200 && /<(urlset|sitemapindex)\b/i.test(r.text);
        return { status: r.status, text: r.text };
      },
      { allowUrl: (u) => hostKey(u) === siteHost, maxUrls: 5000, maxDepth: 2 },
    );
    if (rootOk) {
      sitemap.found = true;
      sitemap.urlCount = entries.length;
      for (const e of entries) seeds.push(crawlKey(e.url));
    }
  } catch {
    // unreachable sitemap counts as missing
  }
  if (!robots.found || !sitemap.found) {
    const missing = [!robots.found && "robots.txt", !sitemap.found && "sitemap.xml"].filter(Boolean).join(" and ");
    add({
      category: "missing-robots-sitemap",
      filePath: `${origin}/`,
      line: null,
      detail: `The live site is missing ${missing}${robots.status && !robots.found ? ` (robots.txt answered ${robots.status})` : ""}.`,
      fixHint: "Publish a robots.txt that names the sitemap, and a sitemap.xml with absolute URLs of every indexable page.",
    });
  }

  // Renderer availability is decided once, on the first page.
  let renderer = opts.renderer ?? null;
  let renderingNote = renderer ? renderer.label : "Static HTML fetch (no JavaScript rendering).";
  let renderedAny = false;

  const queue: string[] = [];
  const queued = new Set<string>();
  const referrer = new Map<string, string>();
  const enqueue = (u: string, from?: string) => {
    const k = crawlKey(u);
    if (queued.has(k)) return;
    queued.add(k);
    queue.push(k);
    if (from) referrer.set(k, from);
  };
  for (const s of seeds) enqueue(s);

  const fetched = new Map<string, LivePageRecord>();
  const canonicalOf = new Map<string, string>();
  const externals: Array<{ url: string; from: string }> = [];
  const externalSeen = new Set<string>();
  let blocked = 0;
  let crawled = 0;

  while (queue.length && crawled < maxPages) {
    const url = queue.shift()!;
    if (rules && !isAllowed(rules, FLEET_BOT_TOKEN, url)) {
      blocked++;
      continue;
    }
    crawled++;
    const from = referrer.get(url);
    let page: FetchedPage;
    try {
      page = await fetcher.get(url, { maxChars: HTML_MAX_CHARS });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "fetch failed";
      const rec: LivePageRecord = { url, status: null, redirects: 0, error: msg.slice(0, 200) };
      fetched.set(url, rec);
      pages.push(rec);
      statusCounts.error = (statusCounts.error ?? 0) + 1;
      add({
        category: from ? "broken-internal-link" : "broken-page",
        filePath: from ?? url,
        line: null,
        detail: from ? `Link to ${url} could not be fetched (${msg.slice(0, 120)}).` : `${url} could not be fetched (${msg.slice(0, 120)}).`,
        fixHint: "Check the page is online and reachable over HTTPS.",
      });
      continue;
    }
    const redirects = page.redirects ?? [];
    const finalUrl = page.finalUrl ?? url;
    const bucket = `${Math.floor(page.status / 100)}xx`;
    statusCounts[bucket] = (statusCounts[bucket] ?? 0) + 1;
    const rec: LivePageRecord = { url, status: page.status, redirects: redirects.length };
    if (finalUrl !== url) rec.finalUrl = finalUrl;
    fetched.set(url, rec);
    if (pages.length < PAGE_RECORDS_CAP) pages.push(rec);

    if (page.status >= 400) {
      add({
        category: from ? "broken-internal-link" : "broken-page",
        filePath: from ?? url,
        line: null,
        detail: from ? `Link points to ${url}, which returns HTTP ${page.status}.` : `${url} returns HTTP ${page.status}.`,
        fixHint: from ? "Point the link at a live page, or redirect the old URL (301) to its replacement." : "Restore the page or 301-redirect it, and drop it from the sitemap.",
      });
      continue;
    }
    if (redirects.length >= 2) {
      add({
        category: "redirect-chain",
        filePath: from ?? url,
        line: null,
        detail: `${url} redirects ${redirects.length} times before landing on ${finalUrl} (${redirects.map((h) => h.status).join(" → ")}).`,
        fixHint: "Redirect straight to the final URL in one hop, and update internal links to point at it directly.",
      });
    }
    if (hostKey(finalUrl) !== siteHost) {
      continue; // left the site — don't audit someone else's page
    }
    if (page.status !== 200 || !isHtml(page)) continue;

    let html = page.text;
    if (renderer) {
      const active = renderer;
      try {
        const r = await active.render(finalUrl);
        if (r && r.html.trim()) {
          html = r.html;
          rec.rendered = true;
          renderedAny = true;
        } else if (!renderedAny) {
          renderingNote = `${active.label} was unavailable; static HTML was audited instead.`;
          renderer = null;
        }
      } catch (err) {
        renderingNote = `${active.label} failed (${err instanceof Error ? err.message.slice(0, 120) : "error"}); static HTML was audited instead.`;
        renderer = null;
      }
    }
    rec.title = pageTitle(html);

    for (const f of checkHtmlPage(url, html)) findings.push({ ...f, autoFixable: false, fixHint: `${f.fixHint} (Live finding: fix it in the site's files — a files audit can auto-fix this category.)` });
    const signals = checkIndexingSignals(url, html, page.headers ?? {});
    findings.push(...signals.findings);
    if (signals.canonical) canonicalOf.set(url, signals.canonical);
    findings.push(...checkStructuredData(url, html));

    for (const link of extractInternalHrefs(html, finalUrl)) {
      if (hostKey(link) === siteHost && /^https?:/i.test(link)) enqueue(link, url);
    }
    for (const ext of externalHrefs(html, finalUrl)) {
      if (externalSeen.has(ext)) continue;
      externalSeen.add(ext);
      externals.push({ url: ext, from: url });
    }
  }

  // Canonicals that point at a page we saw failing or redirecting.
  for (const [page, canonical] of canonicalOf) {
    const target = fetched.get(crawlKey(canonical));
    if (target && (target.status === null || target.status >= 300)) {
      add({
        category: "canonical-issue",
        filePath: page,
        line: null,
        detail: `${page} is canonicalised to ${canonical}, which ${target.status === null ? "could not be fetched" : `returns HTTP ${target.status}`}.`,
        fixHint: "A canonical must point at a live (200) page.",
      });
    }
  }

  // A sample of outbound links. 401/403/429 are "can't tell" (bot walls), not broken.
  let externalChecked = 0;
  for (const ext of externals.slice(0, maxExternal)) {
    externalChecked++;
    try {
      await assertSafeUrl(ext.url, { resolve: opts.resolve });
      const r = await fetcher.get(ext.url, { maxChars: 1024 });
      if (r.status === 404 || r.status === 410 || r.status >= 500) {
        add({
          category: "broken-external-link",
          filePath: ext.from,
          line: null,
          detail: `Outbound link to ${ext.url} returns HTTP ${r.status}.`,
          fixHint: "Update the link to a working page or remove it.",
        });
      }
    } catch (err) {
      if (err instanceof UnsafeUrlError) continue; // internal/private target: not ours to probe
      add({
        category: "broken-external-link",
        filePath: ext.from,
        line: null,
        detail: `Outbound link to ${ext.url} could not be reached.`,
        fixHint: "Update the link to a working page or remove it.",
      });
    }
  }

  return {
    findings,
    crawl: {
      startUrl: start.toString(),
      origin,
      rendering: renderedAny ? "js" : "static",
      renderingNote,
      maxPages,
      pagesCrawled: crawled,
      pagesBlockedByRobots: blocked,
      truncated: queue.length > 0,
      statusCounts,
      robots,
      sitemap,
      externalChecked,
      pages,
    },
  };
}
