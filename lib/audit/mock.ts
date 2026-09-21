// Marketr — deterministic mock audit findings (milestone 10).
//
// Labeled demo data so the audit → approve → scheduled-fix flow runs
// end-to-end without real site files. Every row is mock:true and the UI
// banners it, so it can never be mistaken for a real audit.

import type { ScanFinding } from "./scanner";

/** Deterministic demo findings for a demo/mock site. */
export function mockScanFindings(siteName: string): ScanFinding[] {
  return [
    {
      category: "missing-title",
      filePath: "/about.html",
      line: 4,
      detail: `/about.html has no <title> tag.`,
      fixHint: `Generate a concise title for the ${siteName} about page and insert it into <head>.`,
      autoFixable: true,
    },
    {
      category: "missing-meta-description",
      filePath: "/index.html",
      line: 5,
      detail: `/index.html has no meta description.`,
      fixHint: "Generate a ~150 character description from the page content.",
      autoFixable: true,
    },
    {
      category: "missing-og-tags",
      filePath: "/index.html",
      line: 5,
      detail: `/index.html has no Open Graph tags — social link previews will look broken.`,
      fixHint: "Insert og:title / og:description / og:type derived from the page title and description.",
      autoFixable: true,
    },
    {
      category: "missing-alt",
      filePath: "/index.html",
      line: 42,
      detail: `<img src="/images/hero.jpg"> has no alt text.`,
      fixHint: `Generate a short descriptive alt for the image "/images/hero.jpg".`,
      autoFixable: true,
    },
    {
      category: "mixed-content",
      filePath: "/index.html",
      line: 87,
      detail: `Loads a resource over http://: src="http://cdn.example.com/lib.js"…`,
      fixHint: "Rewrite the http:// URL to https://.",
      autoFixable: true,
    },
    {
      category: "broken-internal-link",
      filePath: "/services.html",
      line: 31,
      detail: `Link points to /pricing-old, which doesn't exist in the site.`,
      fixHint: "Point the href at the correct page, or remove the link. Needs a human decision.",
      autoFixable: false,
    },
    {
      category: "oversized-image",
      filePath: "/images/hero.jpg",
      line: null,
      detail: `/images/hero.jpg is 1840KB (over the 500KB budget).`,
      fixHint: "Compress to WebP/AVIF and resize to display size, then re-upload.",
      autoFixable: false,
    },
    {
      category: "missing-robots-sitemap",
      filePath: "/",
      line: null,
      detail: `Site root is missing robots.txt and sitemap.xml.`,
      fixHint: "Create robots.txt (allow all, point at sitemap) and a sitemap.xml listing the site's HTML pages.",
      autoFixable: true,
    },
  ];
}
