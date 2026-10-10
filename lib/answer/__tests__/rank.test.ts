// Phase 21A (WS=agentweb): de-duplication, trust and freshness scoring, ranking.
// Expected values are worked by hand from the rules in rank.ts's header.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedupe, freshnessScore, normalizeUrl, rankResults, trustScore, validateRerank } from "../rank";
import type { SearchResult } from "../types";

const r = (url: string, title: string, provider = "brave", extra: Partial<SearchResult> = {}): SearchResult => ({ url, title, snippet: `${title} snippet`, provider, ...extra });
const NOW = new Date("2026-10-10T00:00:00Z");

describe("normalizeUrl", () => {
  it("makes the same page the same string", () => {
    const base = "https://example.com/a/b";
    for (const u of ["https://www.example.com/a/b/", "HTTPS://Example.com:443/a/b#top", "https://example.com/a/b?utm_source=x&fbclid=y", "https://example.com/a/b?gclid=1"]) assert.equal(normalizeUrl(u), base, u);
  });
  it("keeps the query that matters, sorted", () => {
    assert.equal(normalizeUrl("https://example.com/s?b=2&a=1&utm_medium=m"), "https://example.com/s?a=1&b=2");
  });
  it("returns a bad url unchanged", () => {
    assert.equal(normalizeUrl("not a url"), "not a url");
  });
});

describe("dedupe", () => {
  it("merges the same URL from two providers and keeps both providers and the longer snippet", () => {
    const out = dedupe([r("https://a.test/x", "A", "brave", { snippet: "short" }), r("https://www.a.test/x/", "A", "exa", { snippet: "a much longer snippet" })]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]!.providers, ["brave", "exa"]);
    assert.equal(out[0]!.snippet, "a much longer snippet");
  });
  it("drops a syndicated copy with the same title on another host, keeping the first", () => {
    const out = dedupe([r("https://a.test/story", "Dentists warn about sugar"), r("https://b.test/copy", "Dentists warn about sugar!")]);
    assert.deepEqual(out.map((x) => x.url), ["https://a.test/story"]);
  });
  it("keeps different pages with similar-looking hosts", () => {
    assert.equal(dedupe([r("https://a.test/x", "One"), r("https://a.test/y", "Two")]).length, 2);
  });
});

describe("trustScore (0.5 base, +0.05 https / -0.1 http, +0.3 gov-edu-health bodies, +0.25 reference, +0.2 major news, -0.3 bare IP, -0.2 coupon/affiliate patterns)", () => {
  const cases: Array<[string, string, number]> = [
    ["https://www.nhs.uk/conditions/x", "brave", 0.85],
    ["https://en.wikipedia.org/wiki/Dentist", "brave", 0.8],
    ["https://www.reuters.com/world/a", "exa", 0.75],
    ["https://example.com/", "brave", 0.55],
    ["http://shady.example/coupon/free-download", "brave", 0.2],
    ["https://192.168.0.1/", "brave", 0.25],
    ["https://shop.example/p?aff=123", "brave", 0.35],
    ["https://anything.test/", "workspace", 1],
    ["not a url", "brave", 0.2],
  ];
  for (const [url, provider, want] of cases) it(`${url} (${provider}) = ${want}`, () => assert.equal(trustScore(url, provider), want));
});

describe("freshnessScore", () => {
  const days = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
  it("steps down with age: <=7d 1, <=30d 0.85, <=180d 0.65, <=365d 0.5, older 0.3 (0.1 when recent matters)", () => {
    assert.deepEqual([3, 20, 100, 300, 900].map((d) => freshnessScore(days(d), NOW, false)), [1, 0.85, 0.65, 0.5, 0.3]);
    assert.equal(freshnessScore(days(900), NOW, true), 0.1);
  });
  it("an unknown date is neutral, and worse when the question needs recent news", () => {
    assert.deepEqual([freshnessScore(undefined, NOW, false), freshnessScore("garbage", NOW, true)], [0.5, 0.3]);
  });
  it("a date in the future counts as today", () => {
    assert.equal(freshnessScore(days(-5), NOW, false), 1);
  });
});

describe("rankResults", () => {
  it("a government source one place down beats an unknown blog in first place", () => {
    const out = rankResults([r("https://blog.example/dental", "Blog"), r("https://www.nhs.uk/dental", "NHS")], { now: NOW, recent: false });
    assert.deepEqual(out.map((s) => s.title), ["NHS", "Blog"]);
    assert.equal(out[0]!.id, 1);
  });
  it("when recent matters, a fresh page beats an old, more trusted one", () => {
    const fresh = r("https://blog.example/new", "Fresh", "brave", { publishedAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() });
    const old = r("https://www.nhs.uk/old", "Old", "brave", { publishedAt: new Date(NOW.getTime() - 900 * 86_400_000).toISOString() });
    assert.deepEqual(rankResults([old, fresh], { now: NOW, recent: true }).map((s) => s.title), ["Fresh", "Old"]);
    assert.deepEqual(rankResults([old, fresh], { now: NOW, recent: false }).map((s) => s.title), ["Old", "Fresh"]);
  });
  it("two providers agreeing on a page lifts it", () => {
    const out = rankResults([r("https://a.test/1", "First", "brave"), r("https://b.test/2", "Second", "brave"), r("https://b.test/2", "Second", "exa")], { now: NOW, recent: false });
    assert.equal(out[0]!.title, "Second");
    assert.deepEqual(out[0]!.providers, ["brave", "exa"]);
  });
  it("stores what claims will be checked against, clipped", () => {
    const out = rankResults([r("https://a.test/1", "T", "brave", { snippet: "x".repeat(5000) })], { now: NOW, recent: false });
    assert.equal(out[0]!.text.length, 1200);
  });
  it("workspace results keep full trust and are never dropped for being old", () => {
    const out = rankResults([r("https://app.test/notes/1", "Our note", "workspace")], { now: NOW, recent: true });
    assert.equal(out[0]!.trust, 1);
  });
});

describe("validateRerank", () => {
  it("keeps the model's order, drops unknown and repeated ids, appends the ones it forgot", () => {
    assert.deepEqual(validateRerank([3, 1, 9, 3], 4), [3, 1, 2, 4]);
  });
  it("rejects an answer that is not a list of ids, or mostly invalid", () => {
    assert.equal(validateRerank("3,1,2", 3), null);
    assert.equal(validateRerank([8, 9, 10], 3), null);
  });
});
