// ShapesOS Phase 11 (seotools): structured-data audit check.
//
// Finds <script type="application/ld+json"> blocks in a page and reports
// pages with none (info) and blocks that are not valid JSON or miss the
// properties their schema.org @type requires (warning) — the validator is
// lib/seo/jsonld.ts. Recommended-but-optional properties are not findings.
// Shared by the files scan and the live crawl.

import type { ScanFinding } from "./scanner";
import { validateJsonLdText } from "@/lib/seo/jsonld";

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
    const errors = validateJsonLdText(b.raw).filter((i) => i.severity === "error");
    if (!errors.length) continue;
    const notJson = errors[0].path === "$" && /^Not valid JSON/.test(errors[0].message);
    findings.push({
      category: "invalid-structured-data",
      filePath: path,
      line: b.line,
      detail: notJson
        ? `JSON-LD block is not valid JSON (${errors[0].message.replace(/^Not valid JSON \(|\)\.$/g, "")}).`
        : `JSON-LD has ${errors.length} problem${errors.length === 1 ? "" : "s"}: ${errors.slice(0, 3).map((e) => `${e.path} — ${e.message}`).join("; ")}${errors.length > 3 ? " …" : ""}`,
      fixHint: notJson ? "Fix the JSON syntax so search engines can read the structured data." : "Add the required properties for the @type (or regenerate the block with the SEO tools).",
      autoFixable: false,
    });
  }
  return findings;
}
