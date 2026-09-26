// Marketr — Phase 10 M4: change classification tests.
// Run: npx tsx --test lib/intelligence/fleet/__tests__/classify.test.ts
//
// Pure classifier — no network, no DB. The AI summary (summarize.ts) refines
// these signals into prose; the classifier gives deterministic structure
// even when the LLM is unavailable.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyChange, classifySitemapUrl } from "../classify";

describe("classifyChange", () => {
  it("title/meta-only edit → metadata_updated (text unchanged)", () => {
    const c = classifyChange(
      { text: "same body copy", title: "Old title", metaDescription: "old" },
      { text: "same body copy", title: "New title — now with keywords", metaDescription: "new" },
    );
    assert.equal(c.changeType, "metadata_updated");
    assert.ok(c.signals.includes("meta:title-or-description"));
  });

  it("copy tweak → content_updated", () => {
    const c = classifyChange(
      { text: "plans start at $10 per month", title: "Pricing" },
      { text: "plans start at $12 per month — billed annually", title: "Pricing" },
    );
    assert.equal(c.changeType, "content_updated");
    assert.equal(c.category, "pricing");
  });

  it("large heading-structure shift → structure_changed", () => {
    const before = { text: "a b c d e f", title: "T" };
    const after = { text: "a b c d e f g h i j", title: "T" };
    const rawHtml = {
      before: "<h1>A</h1><h2>B</h2><p>a b c d e f</p>",
      after:
        "<h1>A</h1><h2>B1</h2><h2>B2</h2><h3>C1</h3><h3>C2</h3><h3>C3</h3><h3>C4</h3><p>a b c d e f g h i j</p>",
    };
    const c = classifyChange(before, after, rawHtml);
    assert.equal(c.changeType, "structure_changed");
  });

  it("small heading change stays content_updated", () => {
    const before = { text: "body text here", title: "T" };
    const after = { text: "body text here plus more", title: "T" };
    const rawHtml = {
      before: "<h1>A</h1><h2>B</h2><p>body text here</p>",
      after: "<h1>A</h1><h2>B</h2><h2>C</h2><p>body text here plus more</p>",
    };
    // 2→3 headings = 33% shift < 40% threshold
    const c = classifyChange(before, after, rawHtml);
    assert.equal(c.changeType, "content_updated");
  });

  it("no raw html → conservative content_updated on text change", () => {
    const c = classifyChange({ text: "before" }, { text: "after — totally rewritten" });
    assert.equal(c.changeType, "content_updated");
  });
});

describe("classifySitemapUrl (URL-only category signals)", () => {
  const cases: Array<[string, string]> = [
    ["https://comp.example/pricing", "pricing"],
    ["https://comp.example/plans/startup", "pricing"],
    ["https://comp.example/blog/seo-guide", "content"],
    ["https://comp.example/customers/acme-case-study", "content"],
    ["https://comp.example/free-trial", "offer"],
    ["https://comp.example/deals/black-friday", "offer"],
    ["https://comp.example/about-us", "positioning"],
    ["https://comp.example/reviews", "reviews"],
    ["https://comp.example/random-uuid-page-123", "other"],
  ];
  for (const [url, expected] of cases) {
    it(`${url} → ${expected}`, () => {
      assert.equal(classifySitemapUrl(url), expected);
    });
  }
});
