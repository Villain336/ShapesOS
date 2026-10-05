// ShapesOS Phase 11 (seotools): programmatic SEO pure logic — templates,
// substitution, slugs, CSV, Tiptap rendering, hashing and quality gates.
// Run: npx tsx --test lib/seo/__tests__/programmatic.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPageUrl,
  duplicateRate,
  evaluateGates,
  extractVariables,
  generatePage,
  hashPageContent,
  normalizeUrlPattern,
  parseCsv,
  QUALITY_FLAGS,
  requiredVariables,
  resolveRowValues,
  safeLinkHref,
  simpleBlocksToTiptap,
  slugify,
  substitute,
  tiptapText,
  tiptapToHtml,
  tiptapToSimpleBlocks,
  tiptapWordCount,
} from "../programmatic";

describe("template variables", () => {
  it("normalizes single-brace URL patterns and keeps double braces", () => {
    assert.equal(normalizeUrlPattern("/services/{city}/{service}"), "/services/{{city}}/{{service}}");
    assert.equal(normalizeUrlPattern("/x/{{city}}"), "/x/{{city}}");
  });

  it("extracts variables with fallbacks, deduped across texts", () => {
    const vars = extractVariables("{{city}} plumbers", "Call {{phone|our office}}", "{{city}} {{phone}}");
    assert.deepEqual(vars, [{ name: "city" }, { name: "phone", fallback: "our office" }]);
    assert.deepEqual(requiredVariables(vars), ["city"]);
  });

  it("substitutes values, uses fallbacks and reports missing", () => {
    const r = substitute("{{a}} / {{b|bee}} / {{c}}", { a: " A ", b: "", c: null });
    assert.equal(r.text, "A / bee / ");
    assert.deepEqual(r.missing, ["c"]);
  });

  it("maps columns to variables by name, spaces and explicit mapping", () => {
    const v = resolveRowValues(
      ["city", "service_type", "zip"],
      ["City", "Service Type", "Postcode"],
      { City: "Austin", "Service Type": "Plumbing", Postcode: "78701" },
      { zip: "Postcode" },
    );
    assert.deepEqual(v, { city: "Austin", service_type: "Plumbing", zip: "78701" });
  });
});

describe("slugs and URLs", () => {
  it("slugifies with diacritics stripped and a non-empty fallback", () => {
    assert.equal(slugify("São Paulo — Café!"), "sao-paulo-cafe");
    assert.equal(slugify("***"), "page");
    assert.ok(slugify("a".repeat(200)).length <= 96);
  });

  it("builds slugified page URLs and never drops a missing segment", () => {
    const ok = buildPageUrl("/services/{city}/{service}", { city: "New York", service: "Drain Cleaning" });
    assert.equal(ok.url, "/services/new-york/drain-cleaning");
    assert.equal(ok.slug, "services/new-york/drain-cleaning");
    assert.deepEqual(ok.missing, []);
    const missing = buildPageUrl("/services/{city}/{service}", { city: "Austin" });
    assert.equal(missing.url, "/services/austin/page");
    assert.deepEqual(missing.missing, ["service"]);
  });
});

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded commas/newlines, CRLF and BOM", () => {
    const csv = '﻿name,notes\r\n"Acme, Inc.","said ""hi""\nthen left"\r\nBeta,plain\r\n\r\n';
    const parsed = parseCsv(csv);
    assert.deepEqual(parsed.columns, ["name", "notes"]);
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0].name, "Acme, Inc.");
    assert.equal(parsed.rows[0].notes, 'said "hi"\nthen left');
    assert.deepEqual(parsed.rows[1], { name: "Beta", notes: "plain" });
  });

  it("returns empty for blank input and pads short rows", () => {
    assert.deepEqual(parseCsv(""), { columns: [], rows: [] });
    assert.deepEqual(parseCsv("a,b\n1").rows, [{ a: "1", b: "" }]);
  });
});

describe("Tiptap rendering", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title <x>" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Bold", marks: [{ type: "bold" }] },
          { type: "text", text: " link", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
        ],
      },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
    ],
  };

  it("renders escaped HTML and neutralizes unsafe links", () => {
    const html = tiptapToHtml(doc);
    assert.match(html, /<h2>Title &lt;x&gt;<\/h2>/);
    assert.match(html, /<strong>Bold<\/strong>/);
    assert.match(html, /<a href="#"> link<\/a>/);
    assert.match(html, /<ul><li><p>one<\/p><\/li><\/ul>/);
  });

  it("extracts text and counts words", () => {
    assert.equal(tiptapWordCount(doc), 5);
    assert.match(tiptapText(doc), /Title <x>/);
    assert.equal(tiptapToHtml(null), "");
  });

  it("round-trips simple blocks", () => {
    const blocks = [
      { type: "h1" as const, text: "Hello" },
      { type: "paragraph" as const, text: "Body" },
      { type: "bullet" as const, text: "Point" },
    ];
    assert.deepEqual(tiptapToSimpleBlocks(simpleBlocksToTiptap(blocks)), blocks);
  });

  it("safeLinkHref allows http(s)/mailto/tel/relative and blocks the rest", () => {
    assert.equal(safeLinkHref("https://a.example/x"), "https://a.example/x");
    assert.equal(safeLinkHref("/pricing"), "/pricing");
    assert.equal(safeLinkHref("mailto:a@b.c"), "mailto:a@b.c");
    assert.equal(safeLinkHref("java\tscript:alert(1)"), "#");
    assert.equal(safeLinkHref("data:text/html,x"), "#");
    assert.equal(safeLinkHref(42), "#");
  });
});

describe("hashing, duplicates and gates", () => {
  it("hashes whitespace-insensitively", () => {
    const a = hashPageContent({ title: "A  title", description: "d", blocks: simpleBlocksToTiptap([{ type: "paragraph", text: "x  y" }]) });
    const b = hashPageContent({ title: "A title", description: " d ", blocks: simpleBlocksToTiptap([{ type: "paragraph", text: "x y" }]) });
    assert.equal(a, b);
  });

  it("computes duplicate rate over non-empty hashes", () => {
    assert.equal(duplicateRate(["a", "a", "b", "c"]), 0.5);
    assert.equal(duplicateRate(["a", null, undefined]), 0);
  });

  it("generates a page with canonical, flags and substituted blocks", () => {
    const page = generatePage(
      {
        urlPattern: "/plumbers/{city}",
        titleTemplate: "Plumbers in {{city}}",
        descriptionTemplate: "Find plumbers in {{city}}. {{tagline}}",
        contentBlocks: simpleBlocksToTiptap([{ type: "paragraph", text: "We serve {{city}}." }]),
        minWordCount: 50,
        duplicateRateCap: 0.2,
      },
      { city: "Austin" },
      "https://acme.example/",
    );
    assert.equal(page.url, "/plumbers/austin");
    assert.equal(page.canonical, "https://acme.example/plumbers/austin");
    assert.equal(page.title, "Plumbers in Austin");
    assert.deepEqual(page.missingVariables, ["tagline"]);
    assert.ok(page.flags.includes(QUALITY_FLAGS.missingVariable));
    assert.ok(page.flags.includes(QUALITY_FLAGS.thinContent));
    assert.match(tiptapText(page.contentBlocks), /We serve Austin\./);
  });

  it("evaluates gates with reasons, checking the duplicate cap only on publish", () => {
    const base = {
      flags: [QUALITY_FLAGS.thinContent],
      missingVariables: [],
      wordCount: 10,
      minWordCount: 100,
      templateDuplicateRate: 0.5,
      duplicateRateCap: 0.1,
    };
    const approve = evaluateGates({ ...base, checkDuplicateRate: false });
    assert.equal(approve.pass, false);
    assert.equal(approve.reasons.length, 1);
    const publish = evaluateGates({ ...base, checkDuplicateRate: true });
    assert.equal(publish.reasons.length, 2);
    assert.ok(evaluateGates({ ...base, flags: [], checkDuplicateRate: false }).pass);
  });
});
