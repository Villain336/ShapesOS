// Marketr — site auditor (milestone 10).
//
// Scans a site's working copy (always the local working copy via
// getSiteIdeProvider — the same files the IDE edits) and produces structured
// findings. Pure HTML parsing with regexes: no headless browser, no network.
// Findings reference file + line so the inbox can deep-link into the IDE.

import type { SiteFileProvider } from "@/lib/sitefiles/types";
import { CATEGORY_MAP } from "./categories";

export interface ScanFinding {
  category: string;
  filePath: string;
  line: number | null;
  detail: string;
  fixHint: string;
  autoFixable: boolean;
}

export interface ScanOptions {
  /** Cap on HTML files scanned (safety for huge sites). */
  maxHtmlFiles?: number;
  /** Skip text files larger than this (bytes). */
  maxFileBytes?: number;
}

const DEFAULTS: Required<ScanOptions> = {
  maxHtmlFiles: 200,
  maxFileBytes: 200 * 1024,
};

const HTML_EXT = /\.(html?|php|aspx?|jsp)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function firstMatchLine(content: string, re: RegExp): number | null {
  const m = re.exec(content);
  return m ? lineOf(content, m.index) : null;
}

async function collectFiles(
  provider: SiteFileProvider,
  dir = "/",
  out: { path: string; size?: number }[] = [],
): Promise<{ path: string; size?: number }[]> {
  const entries = await provider.listDir(dir);
  for (const e of entries) {
    if (e.type === "dir") await collectFiles(provider, e.path, out);
    else out.push({ path: e.path, size: e.size });
  }
  return out;
}

function stripFragmentAndQuery(href: string): string {
  return href.split("#")[0].split("?")[0];
}

/** Resolve an internal href against the page's path → absolute-style path, or null if external. */
function resolveInternal(pagePath: string, href: string): string | null {
  const clean = stripFragmentAndQuery(href.trim());
  if (!clean || clean.startsWith("#")) return null;
  if (/^(https?:)?\/\//i.test(clean) || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null; // external or scheme
  if (clean.startsWith("/")) return clean;
  const dir = pagePath.includes("/") ? pagePath.slice(0, pagePath.lastIndexOf("/")) : "";
  const parts: string[] = dir.split("/").filter(Boolean);
  for (const seg of clean.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

function headContent(html: string): string {
  const m = html.match(/<head[\s>][\s\S]*?<\/head\s*>/i);
  return m ? m[0] : html.slice(0, 8000);
}

function bodyText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function scanSite(
  provider: SiteFileProvider,
  opts: ScanOptions = {},
): Promise<ScanFinding[]> {
  const { maxHtmlFiles, maxFileBytes } = { ...DEFAULTS, ...opts };
  const findings: ScanFinding[] = [];

  let all: { path: string; size?: number }[];
  try {
    all = await collectFiles(provider);
  } catch {
    return findings;
  }

  const htmlFiles = all.filter((f) => HTML_EXT.test(f.path)).slice(0, maxHtmlFiles);
  const knownPaths = new Set(all.map((f) => f.path.toLowerCase()));
  // Also treat "directory → index.html" as resolvable.
  const dirIndex = new Set<string>();
  for (const f of all) {
    if (/\/index\.html?$/i.test(f.path)) {
      dirIndex.add(f.path.replace(/\/index\.html?$/i, "").toLowerCase() || "/");
    }
  }

  for (const f of htmlFiles) {
    if ((f.size ?? 0) > maxFileBytes) continue;
    let content: string;
    try {
      content = (await provider.readFile(f.path)).content;
    } catch {
      continue; // binary / unreadable — skip
    }
    const head = headContent(content);

    // 1. Missing <title>
    if (!/<title[\s>][\s\S]*?<\/title\s*>/i.test(head)) {
      findings.push({
        category: "missing-title",
        filePath: f.path,
        line: firstMatchLine(content, /<head[\s>]/i),
        detail: `${f.path} has no <title> tag.`,
        fixHint: "Generate a concise title from the page's h1/content and insert it into <head>.",
        autoFixable: true,
      });
    }

    // 2. Missing meta description
    if (!/<meta[^>]+name=["']description["']/i.test(head)) {
      findings.push({
        category: "missing-meta-description",
        filePath: f.path,
        line: firstMatchLine(content, /<head[\s>]/i),
        detail: `${f.path} has no meta description.`,
        fixHint: "Generate a ~150 character description from the page content.",
        autoFixable: true,
      });
    }

    // 3. Missing Open Graph tags
    if (!/<meta[^>]+property=["']og:title["']/i.test(head)) {
      findings.push({
        category: "missing-og-tags",
        filePath: f.path,
        line: firstMatchLine(content, /<head[\s>]/i),
        detail: `${f.path} has no Open Graph tags — social link previews will look broken.`,
        fixHint: "Insert og:title / og:description / og:type derived from the page title and description.",
        autoFixable: true,
      });
    }

    // 4. Images missing alt
    const imgRe = /<img\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = imgRe.exec(content))) {
      if (!/\balt\s*=/i.test(m[0])) {
        const src = /src=["']([^"']+)["']/i.exec(m[0])?.[1] ?? "(no src)";
        findings.push({
          category: "missing-alt",
          filePath: f.path,
          line: lineOf(content, m.index),
          detail: `<img src="${src}"> has no alt text.`,
          fixHint: `Generate a short descriptive alt for the image "${src}".`,
          autoFixable: true,
        });
      }
    }

    // 5. Mixed content (http:// resource URLs)
    const mixedRe = /(src|href)\s*=\s*["']http:\/\/[^"']+["']/gi;
    while ((m = mixedRe.exec(content))) {
      findings.push({
        category: "mixed-content",
        filePath: f.path,
        line: lineOf(content, m.index),
        detail: `Loads a resource over http://: ${m[0].slice(0, 80)}…`,
        fixHint: "Rewrite the http:// URL to https://.",
        autoFixable: true,
      });
    }

    // 6. Broken internal links
    const linkRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
    while ((m = linkRe.exec(content))) {
      const resolved = resolveInternal(f.path, m[1]);
      if (!resolved) continue; // external link — out of scope
      const lower = resolved.toLowerCase();
      const exists =
        knownPaths.has(lower) ||
        knownPaths.has(lower + "/index.html") ||
        knownPaths.has(lower + "/index.htm") ||
        dirIndex.has(lower);
      if (!exists) {
        findings.push({
          category: "broken-internal-link",
          filePath: f.path,
          line: lineOf(content, m.index),
          detail: `Link points to ${resolved}, which doesn't exist in the site.`,
          fixHint: "Point the href at the correct page, or remove the link. Needs a human decision.",
          autoFixable: false,
        });
      }
    }

    // 7. Inline style bloat
    const styleBlocks = content.match(/<style[\s>][\s\S]*?<\/style\s*>/gi) ?? [];
    const inlineBytes = styleBlocks.join("").length + (content.match(/\sstyle\s*=\s*["'][^"']*["']/gi) ?? []).join("").length;
    if (inlineBytes > 4000) {
      findings.push({
        category: "inline-style-bloat",
        filePath: f.path,
        line: firstMatchLine(content, /<style[\s>]/i),
        detail: `${f.path} carries ~${Math.round(inlineBytes / 1024)}KB of inline styles.`,
        fixHint: "Move repeated inline styles into a shared stylesheet.",
        autoFixable: false,
      });
    }
  }

  // 8. Oversized images (anywhere in the tree)
  for (const f of all) {
    if (IMG_EXT.test(f.path) && (f.size ?? 0) > 500 * 1024) {
      findings.push({
        category: "oversized-image",
        filePath: f.path,
        line: null,
        detail: `${f.path} is ${Math.round((f.size ?? 0) / 1024)}KB (over the 500KB budget).`,
        fixHint: "Compress to WebP/AVIF and resize to display size, then re-upload.",
        autoFixable: false,
      });
    }
  }

  // 9. Missing robots.txt / sitemap.xml
  const hasRobots = knownPaths.has("/robots.txt");
  const hasSitemap = knownPaths.has("/sitemap.xml");
  if (!hasRobots || !hasSitemap) {
    const missing = [!hasRobots && "robots.txt", !hasSitemap && "sitemap.xml"].filter(Boolean).join(" and ");
    findings.push({
      category: "missing-robots-sitemap",
      filePath: "/",
      line: null,
      detail: `Site root is missing ${missing}.`,
      fixHint: "Create robots.txt (allow all, point at sitemap) and a sitemap.xml listing the site's HTML pages.",
      autoFixable: true,
    });
  }

  void bodyText; // (used by the fixer for LLM context)
  return findings;
}

/** Lightweight page context for LLM-generated fixes: title, h1, first 600 chars of text. */
export function pageContext(html: string): { title: string; h1: string; text: string } {
  const title = /<title[\s>][\s\S]*?([\s\S]*?)<\/title\s*>/i.exec(html)?.[1]?.trim() ?? "";
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, " ").trim() ?? "";
  const text = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  return { title, h1, text };
}
