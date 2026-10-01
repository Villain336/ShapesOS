// Marketr — Wave 2 context.dev slice 2 tests: chunking + hashing (pure).
// Run: npx tsx --test lib/knowledge/contextdev/__tests__/crawl.test.ts
//
// Pure: no database, no network. Covers the markdown chunker (paragraph
// boundaries, overlap, determinism), the content hash, and cost estimation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { chunkMarkdown, contentHash, estimateCrawlCost, CHUNK_CHARS } from "../crawl";

describe("chunkMarkdown", () => {
  it("returns short text as a single chunk", () => {
    assert.deepEqual(chunkMarkdown("# hi"), ["# hi"]);
    assert.deepEqual(chunkMarkdown("   "), []);
  });

  it("splits on paragraph boundaries under the limit", () => {
    const paras = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} with some words.`);
    const text = paras.join("\n\n");
    const chunks = chunkMarkdown(text, 200);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
    // Every paragraph survives somewhere.
    for (const p of paras) {
      assert.ok(chunks.some((c) => c.includes(p)), `lost paragraph: ${p}`);
    }
  });

  it("hard-cuts a single over-long paragraph", () => {
    const text = "x".repeat(CHUNK_CHARS + 500);
    const chunks = chunkMarkdown(text);
    assert.ok(chunks.length >= 2);
    assert.ok(chunks.every((c) => c.length <= CHUNK_CHARS));
    assert.equal(chunks.join("").replace(/x/g, "").length, 0);
  });

  it("is deterministic", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Para ${i}.`).join("\n\n");
    assert.deepEqual(chunkMarkdown(text, 300), chunkMarkdown(text, 300));
  });
});

describe("contentHash", () => {
  it("is a stable 64-char hex digest", () => {
    const h1 = contentHash("hello");
    const h2 = contentHash("hello");
    const h3 = contentHash("world");
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });
});

describe("estimateCrawlCost", () => {
  it("prices sitemap as discovery + per-page scrapes", () => {
    // 1 (sitemap) + 10 pages x 1.
    assert.equal(estimateCrawlCost("sitemap", 10), 11);
  });

  it("prices a single page scrape and brand lookup", () => {
    assert.equal(estimateCrawlCost("page", 1), 1);
    assert.equal(estimateCrawlCost("brand", 1), 10);
  });
});
