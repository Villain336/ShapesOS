// Marketr — fix generator for audit findings (milestone 10).
//
// For each auto-fixable finding, produce the NEW full file content (the
// caller diffs/writes it). Deterministic strategies are pure string rewrites;
// LLM strategies ask the provider for a minimal patch and fall back to a
// safe deterministic template when the provider is a mock or fails.

import type { LlmProvider } from "@/lib/llm/types";
import { pageContext } from "./scanner";
import { CATEGORY_MAP } from "./categories";

export interface FixPlan {
  /** New full content for the finding's file (null for multi-file fixes). */
  newContent: string | null;
  /** Extra files to create: path → content. */
  extraFiles: Record<string, string>;
  /** One-line human summary of the change. */
  summary: string;
  /** Short unified-diff-style preview for dry-run review. */
  preview: string;
}

function diffPreview(before: string, after: string, maxLines = 24): string {
  const b = before.split("\n");
  const a = after.split("\n");
  // Naive line diff: show first divergence window.
  let start = 0;
  while (start < b.length && start < a.length && b[start] === a[start]) start++;
  let endB = b.length - 1;
  let endA = a.length - 1;
  while (endB > start && endA > start && b[endB] === a[endA]) {
    endB--;
    endA--;
  }
  const out: string[] = [];
  const ctx = 2;
  for (let i = Math.max(0, start - ctx); i < start; i++) out.push("  " + b[i]);
  for (let i = start; i <= endB && out.length < maxLines; i++) out.push("- " + b[i]);
  for (let i = start; i <= endA && out.length < maxLines; i++) out.push("+ " + a[i]);
  for (let i = endA + 1; i < Math.min(a.length, endA + 1 + ctx) && out.length < maxLines; i++)
    out.push("  " + a[i]);
  if (out.length >= maxLines) out.push("… (truncated)");
  return out.join("\n");
}

function insertIntoHead(html: string, snippet: string): string {
  if (/<\/head\s*>/i.test(html)) {
    return html.replace(/<\/head\s*>/i, snippet + "\n</head>");
  }
  // No head at all — prepend one.
  return `<head>\n${snippet}\n</head>\n` + html;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

async function llmOr<T>(llm: LlmProvider, prompt: string, fallback: () => T): Promise<T> {
  if (!llm.isLive) return fallback();
  try {
    const raw = (await llm.generate(prompt)).trim();
    if (!raw) return fallback();
    return raw as unknown as T;
  } catch {
    return fallback();
  }
}

export async function planFix(
  category: string,
  filePath: string,
  fileContent: string | null,
  llm: LlmProvider,
  sitePages: string[] = [],
): Promise<FixPlan> {
  const cat = CATEGORY_MAP[category];
  if (!cat) throw new Error(`Unknown issue category: ${category}`);
  if (cat.fixStrategy === "manual") {
    throw new Error(`Category "${category}" needs a human decision and cannot be auto-fixed.`);
  }

  switch (category) {
    case "missing-title": {
      const html = fileContent ?? "";
      const ctx = pageContext(html);
      const base = ctx.h1 || ctx.text.slice(0, 60) || filePath.split("/").pop()!.replace(/\.[^.]+$/, "");
      const title = await llmOr(
        llm,
        `Write a concise SEO page title (under 60 characters) for a web page. Page heading: "${ctx.h1}". Page text: "${ctx.text}". Reply with ONLY the title, no quotes, no explanation.`,
        () => base.slice(0, 60),
      );
      const clean = String(title).split("\n")[0].trim().slice(0, 70) || base.slice(0, 60);
      const next = insertIntoHead(html, `  <title>${escapeAttr(clean)}</title>`);
      return {
        newContent: next,
        extraFiles: {},
        summary: `Added <title>: "${clean}"`,
        preview: diffPreview(html, next),
      };
    }

    case "missing-meta-description": {
      const html = fileContent ?? "";
      const ctx = pageContext(html);
      const desc = await llmOr(
        llm,
        `Write a meta description (140-160 characters) for a web page. Page title: "${ctx.title}". Page text: "${ctx.text}". Reply with ONLY the description, no quotes, no explanation.`,
        () => ctx.text.slice(0, 155) || `Learn more on this page.`,
      );
      const clean = String(desc).split("\n")[0].trim().slice(0, 165);
      const next = insertIntoHead(
        html,
        `  <meta name="description" content="${escapeAttr(clean)}">`,
      );
      return {
        newContent: next,
        extraFiles: {},
        summary: `Added meta description (${clean.length} chars)`,
        preview: diffPreview(html, next),
      };
    }

    case "missing-og-tags": {
      const html = fileContent ?? "";
      const ctx = pageContext(html);
      const title = ctx.title || "Untitled page";
      const descMatch = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html);
      const desc = descMatch?.[1] ?? ctx.text.slice(0, 155);
      const snippet = [
        `  <meta property="og:type" content="website">`,
        `  <meta property="og:title" content="${escapeAttr(title)}">`,
        `  <meta property="og:description" content="${escapeAttr(desc)}">`,
      ].join("\n");
      const next = insertIntoHead(html, snippet);
      return {
        newContent: next,
        extraFiles: {},
        summary: "Added og:type, og:title, og:description tags",
        preview: diffPreview(html, next),
      };
    }

    case "missing-alt": {
      const html = fileContent ?? "";
      // Find the first <img> without alt and fix all of them in one pass.
      const imgRe = /<img\b[^>]*>/gi;
      const alts = new Map<string, string>();
      let m: RegExpExecArray | null;
      const pending: { tag: string; src: string }[] = [];
      while ((m = imgRe.exec(html))) {
        if (!/\balt\s*=/i.test(m[0])) {
          const src = /src=["']([^"']+)["']/i.exec(m[0])?.[1] ?? "image";
          pending.push({ tag: m[0], src });
        }
      }
      for (const p of pending) {
        if (alts.has(p.tag)) continue;
        const name = p.src.split("/").pop()!.split(".")[0].replace(/[-_]+/g, " ");
        const alt = await llmOr(
          llm,
          `Write a short image alt text (under 100 characters) for an image file named "${p.src}" on a website. Reply with ONLY the alt text, no quotes, no explanation.`,
          () => name || "Website image",
        );
        alts.set(p.tag, String(alt).split("\n")[0].trim().slice(0, 120) || name || "Website image");
      }
      let next = html;
      for (const [tag, alt] of alts) {
        const fixed = tag.replace(/<img\b/i, `<img alt="${escapeAttr(alt)}"`);
        next = next.split(tag).join(fixed);
      }
      return {
        newContent: next,
        extraFiles: {},
        summary: `Added alt text to ${alts.size} image${alts.size === 1 ? "" : "s"}`,
        preview: diffPreview(html, next),
      };
    }

    case "mixed-content": {
      const html = fileContent ?? "";
      const next = html.replace(/(src|href)(\s*=\s*["'])http:\/\//gi, "$1$2https://");
      return {
        newContent: next,
        extraFiles: {},
        summary: "Rewrote http:// resource URLs to https://",
        preview: diffPreview(html, next),
      };
    }

    case "missing-robots-sitemap": {
      const sitemapEntries = sitePages
        .filter((p) => /\.(html?)$/i.test(p))
        .slice(0, 500)
        .map((p) => `  <url><loc>${escapeAttr(p)}</loc></url>`)
        .join("\n");
      const extraFiles: Record<string, string> = {
        "/robots.txt": "User-agent: *\nAllow: /\n\nSitemap: /sitemap.xml\n",
        "/sitemap.xml":
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries}\n</urlset>\n`,
      };
      return {
        newContent: null,
        extraFiles,
        summary: "Created robots.txt and sitemap.xml",
        preview: `+ /robots.txt (new)\n+ /sitemap.xml (new, ${sitePages.length} pages listed)`,
      };
    }

    default:
      throw new Error(`No fix strategy implemented for category: ${category}`);
  }
}
