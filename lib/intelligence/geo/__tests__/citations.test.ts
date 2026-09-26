// Marketr — Phase 10 M3: citation tracking + gap detection tests.
// Run: npx tsx --test lib/intelligence/geo/__tests__/citations.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCitationDomain,
  isOwnedCitation,
  citationListsByPrompt,
  ownedCitationCoverage,
  detectCitationGaps,
  rankCitedDomains,
  type CitationObservation,
} from "../citations";

describe("normalizeCitationDomain", () => {
  it("lowercases, strips www and ports", () => {
    assert.equal(normalizeCitationDomain("https://WWW.Example.com:8080/pricing"), "example.com");
    assert.equal(normalizeCitationDomain("http://blog.acme.io/post"), "blog.acme.io");
  });

  it("returns null for garbage", () => {
    assert.equal(normalizeCitationDomain("not a url"), null);
    assert.equal(normalizeCitationDomain("ftp://example.com/x"), null);
    assert.equal(normalizeCitationDomain(""), null);
  });
});

describe("isOwnedCitation", () => {
  it("matches the owned domain and subdomains", () => {
    assert.equal(isOwnedCitation("https://acme.com/pricing", ["acme.com"]), true);
    assert.equal(isOwnedCitation("https://docs.acme.com/x", ["acme.com"]), true);
    assert.equal(isOwnedCitation("https://competitor.com/x", ["acme.com"]), false);
  });
});

const OWNED = ["acme.com"];

function fixture(): CitationObservation[] {
  return [
    // prompt 0: openai cites competitor pricing page x3 reps, never acme
    { promptIdx: 0, engine: "openai", citationUrls: ["https://rival.com/pricing"], brandMentioned: true },
    { promptIdx: 0, engine: "openai", citationUrls: ["https://rival.com/pricing"], brandMentioned: true },
    { promptIdx: 0, engine: "openai", citationUrls: ["https://rival.com/pricing"], brandMentioned: false },
    // prompt 0: anthropic cites acme (no gap there)
    { promptIdx: 0, engine: "anthropic", citationUrls: ["https://acme.com/product"], brandMentioned: true },
    // prompt 1: perplexity cites competitor docs, never acme
    { promptIdx: 1, engine: "perplexity", citationUrls: ["https://rival.com/docs/setup", "https://g2.com/rival"], brandMentioned: false },
    { promptIdx: 1, engine: "perplexity", citationUrls: ["https://docs.rival.com/guide"], brandMentioned: false },
  ];
}

describe("citationListsByPrompt", () => {
  it("dedupes URLs and normalizes domains per prompt/engine", () => {
    const lists = citationListsByPrompt(fixture(), OWNED);
    const openaiP0 = lists.find((l) => l.promptIdx === 0 && l.engine === "openai");
    assert.ok(openaiP0);
    assert.deepEqual(openaiP0.urls, ["https://rival.com/pricing"]);
    assert.deepEqual(openaiP0.domains, ["rival.com"]);
    assert.equal(openaiP0.ownedCited, false);
    const anthropicP0 = lists.find((l) => l.promptIdx === 0 && l.engine === "anthropic");
    assert.equal(anthropicP0?.ownedCited, true);
  });
});

describe("ownedCitationCoverage", () => {
  it("returns an HonestShare per engine, never a bare number", () => {
    const coverage = ownedCitationCoverage(fixture(), OWNED);
    const anthropic = coverage.find((c) => c.engine === "anthropic");
    assert.ok(anthropic);
    assert.equal(anthropic.honestMetric, true);
    assert.equal(anthropic.share, 1); // 1/1 prompts
    assert.equal(anthropic.confidenceInterval.length, 2);
    const openai = coverage.find((c) => c.engine === "openai");
    assert.equal(openai?.share, 0);
  });
});

describe("detectCitationGaps", () => {
  it("flags prompts where competitors are cited and the owned domain is not", () => {
    const gaps = detectCitationGaps(fixture(), OWNED);
    const p0 = gaps.find((g) => g.promptIdx === 0);
    assert.ok(p0, "expected a gap on prompt 0");
    assert.deepEqual(p0.engines, ["openai"]);
    assert.ok(p0.competitorDomains.includes("rival.com"));
    assert.ok(p0.competitorUrls.includes("https://rival.com/pricing"));
    assert.equal(p0.gapShare.honestMetric, true);
    // prompt 1: perplexity cites rival docs — also a gap
    const p1 = gaps.find((g) => g.promptIdx === 1);
    assert.ok(p1);
    assert.deepEqual(p1.engines, ["perplexity"]);
  });

  it("does not flag prompts where the owned domain is cited everywhere", () => {
    const obs: CitationObservation[] = [
      { promptIdx: 0, engine: "openai", citationUrls: ["https://acme.com/x"], brandMentioned: true },
      { promptIdx: 0, engine: "anthropic", citationUrls: ["https://acme.com/x"], brandMentioned: true },
    ];
    assert.equal(detectCitationGaps(obs, OWNED).length, 0);
  });
});

describe("rankCitedDomains", () => {
  it("ranks by citation count with per-engine lists", () => {
    const ranked = rankCitedDomains(fixture());
    assert.equal(ranked[0].domain, "rival.com");
    assert.ok(ranked[0].citations >= 3);
    assert.ok(ranked[0].engines.includes("openai"));
  });
});
