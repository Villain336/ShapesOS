// Marketr — Phase 10 M8 tests: opportunity ranking.
// Run: npx tsx --test lib/intelligence/community/__tests__/ranking.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rankOpportunities, dedupeThreads } from "../ranking";
import type { ExpertiseProfile, RawThread } from "../types";

const NOW = new Date("2026-09-26T12:00:00Z");

const PROFILE: ExpertiseProfile = {
  trackedKeywords: ["keyword research", "serp api", "content decay"],
  competitorDomains: ["acme-seo.com"],
  projectDomains: ["marketr.example"],
};

function thread(partial: Partial<RawThread> & { title: string; url: string }): RawThread {
  return {
    source: "hacker_news",
    externalId: partial.url,
    text: "",
    createdAt: new Date(NOW.getTime() - 3_600_000), // 1h ago
    ...partial,
  };
}

describe("rankOpportunities", () => {
  it("ranks a competitor mention above a plain expertise match", () => {
    const competitor = thread({
      title: "Why I cancelled acme-seo.com",
      url: "https://news.ycombinator.com/item?id=1",
      text: "Their keyword research tool kept timing out on big exports.",
    });
    const expertise = thread({
      title: "How do you do keyword research?",
      url: "https://news.ycombinator.com/item?id=2",
      text: "Looking for a solid keyword research workflow for a small team.",
    });
    const ranked = rankOpportunities([expertise, competitor], PROFILE, NOW);
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].url, competitor.url, "competitor mention should rank first");
    assert.ok(ranked[0].signals.includes("competitor_mention"));
    assert.ok(ranked[0].relevanceReason.includes("acme-seo.com"));
    assert.ok(ranked[1].signals.includes("expertise_match"));
    assert.deepEqual(ranked[1].matchedKeywords, ["keyword research"]);
  });

  it("detects launch moments", () => {
    const t = thread({
      title: "Show HN: I built a SERP API for indie hackers",
      url: "https://news.ycombinator.com/item?id=3",
      text: "Just launched today, looking for feedback on pricing.",
    });
    const [r] = rankOpportunities([t], PROFILE, NOW);
    assert.ok(r, "launch thread should score");
    assert.ok(r.signals.includes("launch_moment"));
    assert.match(r.relevanceReason, /launch moment/i);
  });

  it("drops threads with no signal", () => {
    const t = thread({
      title: "My sourdough starter died",
      url: "https://news.ycombinator.com/item?id=4",
      text: "RIP bubbles. Any revival tips?",
    });
    assert.deepEqual(rankOpportunities([t], PROFILE, NOW), []);
  });

  it("does not count the workspace's own domain as a competitor hit", () => {
    const t = thread({
      title: "marketr.example just shipped something",
      url: "https://news.ycombinator.com/item?id=5",
      text: "Saw marketr.example mentioned in the newsletter.",
    });
    const profile: ExpertiseProfile = {
      trackedKeywords: [],
      competitorDomains: ["marketr.example"],
      projectDomains: ["marketr.example"],
    };
    assert.deepEqual(rankOpportunities([t], profile, NOW), []);
  });

  it("decays old threads", () => {
    const fresh = thread({
      title: "keyword research workflows?",
      url: "https://news.ycombinator.com/item?id=6",
      text: "keyword research tips wanted",
      createdAt: new Date(NOW.getTime() - 3_600_000),
    });
    const stale = thread({
      title: "keyword research workflows?",
      url: "https://news.ycombinator.com/item?id=7",
      text: "keyword research tips wanted",
      createdAt: new Date(NOW.getTime() - 5 * 86_400_000),
    });
    const [first, second] = rankOpportunities([stale, fresh], PROFILE, NOW);
    assert.equal(first.url, fresh.url);
    assert.equal(second.url, stale.url);
    assert.ok(first.score > second.score);
  });

  it("caps expertise scoring and lists matched keywords in the reason", () => {
    const t = thread({
      title: "keyword research with a serp api, fighting content decay",
      url: "https://news.ycombinator.com/item?id=8",
      text: "keyword research and serp api and content decay all in one thread",
    });
    const [r] = rankOpportunities([t], PROFILE, NOW);
    assert.equal(r.matchedKeywords.length, 3);
    assert.match(r.relevanceReason, /keyword research/);
  });
});

describe("dedupeThreads", () => {
  it("dedupes identical URLs across sources", () => {
    const a = thread({ title: "A", url: "https://www.reddit.com/r/seo/comments/abc/" });
    const b: RawThread = { ...a, source: "rss", externalId: "x", feedName: "niche" };
    const c = thread({ title: "C", url: "https://news.ycombinator.com/item?id=9" });
    const out = dedupeThreads([a, b, c]);
    assert.equal(out.length, 2);
    assert.equal(out[0].source, "hacker_news", "first occurrence wins");
  });
});
