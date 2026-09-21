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
];

export const CATEGORY_MAP: Record<string, IssueCategory> = Object.fromEntries(
  ISSUE_CATEGORIES.map((c) => [c.key, c]),
);

/** Categories the agent may auto-fix without per-issue approval (safe, non-destructive). */
export const DEFAULT_ALLOWED_CATEGORIES = ISSUE_CATEGORIES.filter(
  (c) => c.fixStrategy !== "manual" && !c.destructive,
).map((c) => c.key);
