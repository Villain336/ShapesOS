// ShapesOS Phase 11 (seotools): Context.dev scrape / crawl as agent tools
// (group "web"), on top of the existing client (./client.ts), vault key
// (./keys.ts) and daily credit budget (./budget-store.ts checkAndReserve —
// the same gate research_question uses: over budget routes to approval,
// never a silent charge).
//
//   web_scrape  spend  fetch_web_pages  one URL → clean markdown (1 credit;
//                                       Context.dev renders JavaScript)
//   web_crawl   spend  fetch_web_pages  a site's sitemap → up to 25 pages of
//                                       markdown (1 + 1 per page)
//
// Overlap with Phase 7: Claude's server-side web_fetch (lib/agents/
// loop-tools.ts, on with the "web" group for Anthropic models) already reads
// ONE page for free, so web_scrape tells the model to prefer it and exists
// for non-Anthropic models, JavaScript-rendered pages and metered clean
// markdown. Nothing in Phase 7 crawls a site: web_crawl is new.
//
// Every URL passes the SSRF guard (lib/safe-url assertSafeUrl) before the
// vendor is asked to fetch it — internal / private addresses are refused.
// No key connected → "not connected", never a fake result.
// Self-registers (imported for its side effect by lib/chat/agent.ts).

import { registerExtraTool, type ToolDef, type ToolResult } from "@/lib/chat/tools";
import { roleAtLeast } from "@/lib/authz";
import { assertSafeUrl, UnsafeUrlError, type ResolveFn } from "@/lib/safe-url";
import { isOnWatchedDomain } from "@/lib/intelligence/fleet/polite-fetch";
import { createContextDevClient, ContextDevError, type FetchImpl } from "./client";
import { contextDevCreditsFor } from "./costs";
import { checkAndReserve } from "./budget-store";
import { resolveContextDevKey, ContextDevKeyError } from "./keys";

export const SCRAPE_MODEL_CHARS = 40_000;
export const CRAWL_PAGE_CHARS = 8_000;
export const CRAWL_TOTAL_CHARS = 60_000;
export const CRAWL_DEFAULT_PAGES = 5;
export const CRAWL_MAX_PAGES = 25;

/** Test seams (fetch for the vendor, DNS for the SSRF guard). */
let deps: { fetchImpl?: FetchImpl; resolve?: ResolveFn } = {};
export function setWebToolDepsForTests(d: { fetchImpl?: FetchImpl; resolve?: ResolveFn } | null): void {
  deps = d ?? {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function cut(s: string, n: number): { text: string; truncated: boolean } {
  return s.length <= n ? { text: s, truncated: false } : { text: `${s.slice(0, n)}\n…[${s.length - n} more characters cut]`, truncated: true };
}

/** Normalise a URL or bare domain to an absolute https URL, SSRF-checked. */
async function safeTarget(raw: string): Promise<URL> {
  // A bare domain gets https://; any other explicit scheme is refused by the guard.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^:/]+:\d+(\/|$)/.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`;
  await assertSafeUrl(withScheme, { resolve: deps.resolve });
  return new URL(withScheme);
}

type Fail = ToolResult;

async function clientFor(workspaceId: string): Promise<{ client: ReturnType<typeof createContextDevClient> } | Fail> {
  try {
    const { apiKey } = await resolveContextDevKey(workspaceId);
    return { client: createContextDevClient({ apiKey }, deps.fetchImpl ?? fetch) };
  } catch (err) {
    if (err instanceof ContextDevKeyError) {
      return {
        summary: err.code === "NOT_CONNECTED" ? "Context.dev isn't connected for this workspace — add the API key under Settings → Connections to scrape pages." : `Context.dev: ${err.message}`,
        details: { error: "not_connected", code: err.code },
      };
    }
    throw err;
  }
}

async function reserve(workspaceId: string, credits: number): Promise<Fail | null> {
  const gate = await checkAndReserve(workspaceId, credits);
  if (gate.decision === "allow") return null;
  return { summary: `Not fetched: ${gate.reason}.`, details: { error: "budget", needsApproval: true, credits } };
}

function vendorFailure(err: unknown, url: string): Fail {
  if (err instanceof ContextDevError) return { summary: `Context.dev couldn't fetch ${url} (${err.code}).`, details: { error: "vendor", code: err.code } };
  throw err;
}

export const web_scrape: ToolDef = {
  name: "web_scrape",
  description:
    "Read one web page as clean markdown via Context.dev (renders JavaScript). Costs 1 credit from the workspace's daily Context.dev budget. When the built-in web_fetch tool is available, prefer it for a quick read of a simple page.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The page URL (https://…)." },
      includeLinks: { type: "boolean", description: "Keep hyperlinks in the markdown (optional)." },
    },
    required: ["url"],
  },
  async execute(ctx, args) {
    if (!roleAtLeast(ctx.role, "editor")) throw new Error("editor role required");
    const raw = str(args.url);
    if (!raw) return { summary: "web_scrape needs a url.", details: { error: "url" } };
    let target: URL;
    try {
      target = await safeTarget(raw);
    } catch (err) {
      if (err instanceof UnsafeUrlError) return { summary: `Can't fetch that URL: ${err.message}`, details: { error: "unsafe_url" } };
      throw err;
    }
    const c = await clientFor(ctx.workspaceId);
    if (!("client" in c)) return c;
    const denied = await reserve(ctx.workspaceId, contextDevCreditsFor("scrape_markdown"));
    if (denied) return denied;
    try {
      const page = await c.client.scrapeMarkdown(target.toString(), { includeLinks: args.includeLinks === true || args.includeLinks === "true", shortenBase64Images: true });
      if (!page.markdown.trim()) return { summary: `${target} returned no readable content.`, details: { url: target.toString(), chars: 0, credits: 1 } };
      const { text, truncated } = cut(page.markdown, SCRAPE_MODEL_CHARS);
      return {
        summary: `${page.title ? `${page.title} — ` : ""}${target}\n\n${text}`,
        details: { url: target.toString(), title: page.title ?? null, chars: page.markdown.length, truncated, credits: 1 },
      };
    } catch (err) {
      return vendorFailure(err, target.toString());
    }
  },
};

export const web_crawl: ToolDef = {
  name: "web_crawl",
  description:
    "Read several pages of one website as markdown via Context.dev: discovers pages from the site's sitemap (optionally only under a path), then scrapes up to maxPages of them. Costs 1 credit plus 1 per page from the workspace's daily Context.dev budget.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The site (https://example.com or example.com)." },
      maxPages: { type: "number", description: `Pages to read (default ${CRAWL_DEFAULT_PAGES}, max ${CRAWL_MAX_PAGES}).` },
      pathPrefix: { type: "string", description: 'Only pages under this path, e.g. "/blog/" (optional).' },
    },
    required: ["url"],
  },
  async execute(ctx, args) {
    if (!roleAtLeast(ctx.role, "editor")) throw new Error("editor role required");
    const raw = str(args.url);
    if (!raw) return { summary: "web_crawl needs a url.", details: { error: "url" } };
    let target: URL;
    try {
      target = await safeTarget(raw);
    } catch (err) {
      if (err instanceof UnsafeUrlError) return { summary: `Can't crawl that URL: ${err.message}`, details: { error: "unsafe_url" } };
      throw err;
    }
    const n = typeof args.maxPages === "number" ? args.maxPages : Number(args.maxPages);
    const maxPages = Math.min(Math.max(1, Number.isFinite(n) && n > 0 ? Math.floor(n) : CRAWL_DEFAULT_PAGES), CRAWL_MAX_PAGES);
    const prefix = str(args.pathPrefix);
    const domain = target.hostname.toLowerCase();

    const c = await clientFor(ctx.workspaceId);
    if (!("client" in c)) return c;
    const sitemapCost = contextDevCreditsFor("crawl_sitemap");
    const denied = await reserve(ctx.workspaceId, sitemapCost);
    if (denied) return denied;

    let urls: string[];
    try {
      urls = (await c.client.crawlSitemap(domain, { maxLinks: 500 })).urls;
    } catch (err) {
      return vendorFailure(err, domain);
    }
    // Stay on the site, under the prefix; drop duplicates; private targets refused.
    const seen = new Set<string>();
    const picked: string[] = [];
    for (const u of [target.toString(), ...urls]) {
      if (picked.length >= maxPages) break;
      if (!isOnWatchedDomain(u, domain)) continue;
      let p: URL;
      try {
        p = new URL(u);
      } catch {
        continue;
      }
      p.hash = "";
      const key = p.toString().replace(/\/$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      if (prefix && !p.pathname.startsWith(prefix)) continue;
      try {
        await assertSafeUrl(p.toString(), { resolve: deps.resolve });
      } catch {
        continue;
      }
      picked.push(p.toString());
    }
    if (!picked.length) {
      return { summary: `No pages${prefix ? ` under ${prefix}` : ""} found for ${domain} (sitemap had ${urls.length} URLs).`, details: { domain, discovered: urls.length, pages: [], credits: sitemapCost } };
    }

    const scrapeCost = picked.length * contextDevCreditsFor("scrape_markdown");
    const deniedPages = await reserve(ctx.workspaceId, scrapeCost);
    if (deniedPages) return { ...deniedPages, details: { ...(deniedPages.details as object), discovered: urls.length, credits: sitemapCost } };

    const pages: { url: string; title: string | null; chars: number; truncated: boolean; error?: string }[] = [];
    const parts: string[] = [];
    let total = 0;
    for (const u of picked) {
      try {
        const page = await c.client.scrapeMarkdown(u, { shortenBase64Images: true });
        const room = Math.max(0, Math.min(CRAWL_PAGE_CHARS, CRAWL_TOTAL_CHARS - total));
        const { text, truncated } = cut(page.markdown, room);
        total += text.length;
        pages.push({ url: u, title: page.title ?? null, chars: page.markdown.length, truncated });
        if (room > 0 && page.markdown.trim()) parts.push(`## ${page.title ?? u}\n${u}\n\n${text}`);
      } catch (err) {
        if (!(err instanceof ContextDevError)) throw err;
        pages.push({ url: u, title: null, chars: 0, truncated: false, error: err.code });
      }
    }
    const ok = pages.filter((p) => !p.error).length;
    return {
      summary: `Read ${ok} of ${picked.length} page${picked.length === 1 ? "" : "s"} from ${domain} (${sitemapCost + scrapeCost} credits).\n\n${parts.join("\n\n---\n\n")}`,
      details: { domain, discovered: urls.length, pages, credits: sitemapCost + scrapeCost },
    };
  },
};

export const WEB_TOOLS: readonly ToolDef[] = [web_scrape, web_crawl];

let registered = false;
export function registerWebTools(): void {
  if (registered) return;
  registered = true;
  for (const t of WEB_TOOLS) registerExtraTool(t);
}

registerWebTools();
