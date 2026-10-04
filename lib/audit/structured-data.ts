// ShapesOS Phase 11 (seotools): structured-data audit check.
//
// Finds <script type="application/ld+json"> blocks in a page and reports
// pages with none (info) and blocks that are not valid JSON (warning).
// Shared by the files scan and the live crawl.

import type { ScanFinding } from "./scanner";

export interface JsonLdBlock {
  raw: string;
  line: number;
}

/** Every JSON-LD script block in the HTML, with its 1-based line. */
export function extractJsonLdBlocks(html: string): JsonLdBlock[] {
  const out: JsonLdBlock[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({ raw: m[1].trim(), line: html.slice(0, m.index).split("\n").length });
  }
  return out;
}

export function checkStructuredData(path: string, html: string): ScanFinding[] {
  const blocks = extractJsonLdBlocks(html);
  if (blocks.length === 0) {
    return [
      {
        category: "missing-structured-data",
        filePath: path,
        line: null,
        detail: `${path} has no JSON-LD structured data.`,
        fixHint: "Add schema.org JSON-LD (Organization / WebSite on the home page, Article, Product, FAQPage or BreadcrumbList where they fit).",
        autoFixable: false,
      },
    ];
  }
  const findings: ScanFinding[] = [];
  for (const b of blocks) {
    try {
      JSON.parse(b.raw);
    } catch (err) {
      findings.push({
        category: "invalid-structured-data",
        filePath: path,
        line: b.line,
        detail: `JSON-LD block is not valid JSON (${err instanceof Error ? err.message.slice(0, 100) : "parse error"}).`,
        fixHint: "Fix the JSON syntax so search engines can read the structured data.",
        autoFixable: false,
      });
    }
  }
  return findings;
}
