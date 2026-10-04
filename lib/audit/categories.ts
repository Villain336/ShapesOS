// Marketr — fix-agent issue category registry (milestone 10).
//
// Every scanner finding belongs to a category. The category declares how the
// agent may fix it:
//   - fixStrategy "deterministic": a pure function rewrites the file safely.
//   - fixStrategy "llm": the fix needs generated copy (titles, alt text) — the
//     swappable LLM abstraction writes a minimal patch, never full rewrites.
//   - fixStrategy "manual": the agent cannot fix it (human intent required);
//     the inbox shows it with guidance only.
// Destructive categories always require explicit per-issue approval, even when
// the category is allow-listed in FixAgentSettings.

import type { IssueSeverity } from "@prisma/client";

export type FixStrategy = "deterministic" | "llm" | "manual";

export interface IssueCategory {
  key: string;
  label: string;
  description: string;
  defaultSeverity: IssueSeverity;
  fixStrategy: FixStrategy;
  destructive: boolean;
  /** Suggested guidance shown when the agent can't fix it. */
  guidance: string;
}

export const ISSUE_CATEGORIES: IssueCategory[] = [
  {
    key: "missing-title",
    label: "Missing <title>",
    description: "An HTML page has no <title> tag. Search engines and tabs show the URL instead.",
    defaultSeverity: "error",
    fixStrategy: "llm",
    destructive: false,
    guidance: "Add a concise, keyword-aware <title> (under ~60 chars) inside <head>.",
  },
  {
    key: "missing-meta-description",
    label: "Missing meta description",
    description: "No meta description tag — search snippets fall back to arbitrary page text.",
    defaultSeverity: "warning",
    fixStrategy: "llm",
    destructive: false,
    guidance: "Add a <meta name=\"description\"> (~150 chars) summarizing the page.",
  },
  {
    key: "missing-og-tags",
    label: "Missing Open Graph tags",
    description: "No og:title / og:description — link previews on social look broken.",
    defaultSeverity: "warning",
    fixStrategy: "deterministic",
    destructive: false,
    guidance: "Add og:title, og:description, and og:type tags derived from the page title and description.",
  },
  {
    key: "missing-alt",
    label: "Image missing alt text",
    description: "An <img> has no alt attribute — bad for accessibility and image SEO.",
    defaultSeverity: "warning",
    fixStrategy: "llm",
    destructive: false,
    guidance: "Add a short descriptive alt attribute to every <img>.",
  },
  {
    key: "oversized-image",
    label: "Oversized image",
    description: "An image file is larger than 500KB — slows the page down.",
    defaultSeverity: "info",
    fixStrategy: "manual",
    destructive: false,
    guidance: "Compress the image (WebP/AVIF, resize to display size) and re-upload.",
  },
  {
    key: "broken-internal-link",
    label: "Broken internal link",
    description: "An <a href> points to a page or file that doesn't exist in the site.",
    defaultSeverity: "error",
    fixStrategy: "manual",
    destructive: false,
    guidance: "Fix the href to point at the correct page, or remove the link.",
  },
  {
    key: "mixed-content",
    label: "Mixed content (http://)",
    description: "The page loads a resource over http:// — browsers may block it on HTTPS pages.",
    defaultSeverity: "error",
    fixStrategy: "deterministic",
    destructive: false,
    guidance: "Rewrite http:// resource URLs to https://.",
  },
  {
    key: "missing-robots-sitemap",
    label: "Missing robots.txt / sitemap.xml",
    description: "No robots.txt or sitemap.xml at the site root — crawlers get no guidance.",
    defaultSeverity: "info",
    fixStrategy: "deterministic",
    destructive: false,
    guidance: "Add a robots.txt and a basic sitemap.xml listing the site's HTML pages.",
  },
  {
    key: "inline-style-bloat",
    label: "Inline style bloat",
    description: "Large inline <style> blocks or many style attributes — harder to maintain and cache.",
    defaultSeverity: "info",
    fixStrategy: "manual",
    destructive: false,
    guidance: "Move repeated inline styles into a shared stylesheet.",
  },
  // Phase 11 (seotools): structured data (files scan + live crawl) and the
  // live-URL crawl's own checks (lib/audit/live.ts). All manual: live
  // findings point at URLs, not working-copy files.
  {
    key: "missing-structured-data",
    label: "No structured data",
    description: "The page has no schema.org JSON-LD — it can't earn rich results.",
    defaultSeverity: "info",
    fixStrategy: "manual",
    destructive: false,
    guidance: "Add JSON-LD for the page type (the SEO tools can generate it and inject it as a site draft).",
  },
  {
    key: "invalid-structured-data",
    label: "Invalid structured data",
    description: "A JSON-LD block is not valid JSON, or a schema.org type is missing required properties.",
    defaultSeverity: "warning",
    fixStrategy: "manual",
    destructive: false,
    guidance: "Fix the JSON-LD so it parses and carries the required properties for its @type.",
  },
  {
    key: "broken-page",
    label: "Page returns an error",
    description: "A live page (start URL or sitemap entry) returns 4xx/5xx or can't be fetched.",
    defaultSeverity: "error",
    fixStrategy: "manual",
    destructive: false,
    guidance: "Restore the page or 301-redirect it, and drop dead URLs from the sitemap.",
  },
  {
    key: "redirect-chain",
    label: "Redirect chain",
    description: "A URL redirects more than once before reaching its final page.",
    defaultSeverity: "warning",
    fixStrategy: "manual",
    destructive: false,
    guidance: "Redirect in a single hop and link straight to the final URL.",
  },
  {
    key: "canonical-issue",
    label: "Canonical problem",
    description: "Missing, conflicting, cross-domain or dead canonical link.",
    defaultSeverity: "warning",
    fixStrategy: "manual",
    destructive: false,
    guidance: "Give every indexable page exactly one canonical pointing at a live URL on this site.",
  },
  {
    key: "hreflang-issue",
    label: "hreflang problem",
    description: "Invalid language codes, relative URLs, missing self-reference or conflicting alternates.",
    defaultSeverity: "warning",
    fixStrategy: "manual",
    destructive: false,
    guidance: "Use valid codes (en, en-GB, x-default) with absolute URLs, including the page itself.",
  },
  {
    key: "noindex-page",
    label: "Page is noindex",
    description: "The page tells search engines not to index it (meta robots or X-Robots-Tag).",
    defaultSeverity: "warning",
    fixStrategy: "manual",
    destructive: false,
    guidance: "Remove noindex if the page should rank; keep it for deliberately private pages.",
  },
  {
    key: "broken-external-link",
    label: "Broken outbound link",
    description: "A sampled link to another site returns 404/410/5xx or can't be reached.",
    defaultSeverity: "warning",
    fixStrategy: "manual",
    destructive: false,
    guidance: "Update or remove the link.",
  },
  {
    key: "poor-core-web-vitals",
    label: "Poor Core Web Vitals",
    description: "PageSpeed Insights rates LCP, INP or CLS as poor for real users (or in the lab when there is no field data).",
    defaultSeverity: "warning",
    fixStrategy: "manual",
    destructive: false,
    guidance: "Work through the PageSpeed opportunities: image sizes, render-blocking scripts, layout shifts.",
  },
];

export const CATEGORY_MAP: Record<string, IssueCategory> = Object.fromEntries(
  ISSUE_CATEGORIES.map((c) => [c.key, c]),
);

/** Categories the agent may auto-fix without per-issue approval (safe, non-destructive). */
export const DEFAULT_ALLOWED_CATEGORIES = ISSUE_CATEGORIES.filter(
  (c) => c.fixStrategy !== "manual" && !c.destructive,
).map((c) => c.key);
