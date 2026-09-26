// Marketr — Phase 10 M3: first-party correlation tests.
// Run: npx tsx --test lib/intelligence/geo/__tests__/first-party.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectAiCrawler,
  parseServerLog,
  summarizeAiReferrers,
  AI_REFERRER_HOSTS,
} from "../first-party";

describe("detectAiCrawler", () => {
  it("identifies the six spec'd crawlers", () => {
    const cases: Array<[string, string]> = [
      ["Mozilla/5.0 ... GPTBot/1.0", "GPTBot"],
      ["OAI-SearchBot/1.0; +https://openai.com/searchbot", "OAI-SearchBot"],
      ["ClaudeBot/1.0", "ClaudeBot"],
      ["Claude-User/1.0", "Claude-User"],
      ["PerplexityBot/1.0", "PerplexityBot"],
      ["Bytespider/1.0", "Bytespider"],
    ];
    for (const [ua, name] of cases) {
      assert.equal(detectAiCrawler(ua), name);
    }
  });

  it("returns null for ordinary browsers", () => {
    assert.equal(
      detectAiCrawler("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"),
      null,
    );
  });
});

describe("parseServerLog", () => {
  const lines = [
    '203.0.113.1 - - [26/Sep/2026:10:00:00 +0000] "GET /pricing HTTP/1.1" 200 1234 "-" "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"',
    '203.0.113.2 - - [2026-09-26T10:01:00Z] "GET /docs/setup HTTP/2" 200 999 "-" "PerplexityBot/1.0"',
    '203.0.113.3 - - [2026-09-26T10:02:00Z] "GET / HTTP/2" 200 111 "-" "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"',
    '203.0.113.4 - - [2026-09-26T10:03:00Z] "GET /blog/ai-guide?x=1 HTTP/2" 200 222 "-" "ClaudeBot/1.0"',
  ];

  it("counts AI-bot hits per bot with sample paths", () => {
    const s = parseServerLog(lines);
    assert.equal(s.totalLines, 4);
    assert.equal(s.aiBotLines, 3);
    const gpt = s.perBot.find((b) => b.bot === "GPTBot");
    assert.ok(gpt);
    assert.equal(gpt.hits, 1);
    assert.deepEqual(gpt.samplePaths, ["/pricing"]);
    const perplexity = s.perBot.find((b) => b.bot === "PerplexityBot");
    assert.ok(perplexity);
    assert.deepEqual(perplexity.samplePaths, ["/docs/setup"]);
  });

  it("collects dates for windowing", () => {
    const s = parseServerLog(lines);
    assert.ok(s.dates.includes("2026-09-26"));
  });
});

describe("summarizeAiReferrers", () => {
  it("filters to known AI referrer hosts only", () => {
    const s = summarizeAiReferrers([
      { host: "chat.openai.com", sessions: 120 },
      { host: "www.perplexity.ai", sessions: 45 },
      { host: "google.com", sessions: 9000 },
      { host: "gemini.google.com", sessions: 30, mock: true },
    ]);
    assert.equal(s.totalSessions, 195);
    assert.equal(s.perHost.length, 3);
    assert.equal(s.perHost[0].host, "chat.openai.com");
    assert.equal(s.fromMock, true);
    assert.match(s.note, /MOCK-ONLY/);
  });

  it("labels live rows honestly", () => {
    const s = summarizeAiReferrers([{ host: "chat.openai.com", sessions: 5 }]);
    assert.equal(s.fromMock, false);
    assert.match(s.note, /Live/);
  });

  it("knows the spec'd referrer hosts", () => {
    const hosts = [...AI_REFERRER_HOSTS];
    assert.ok(hosts.includes("chat.openai.com"));
    assert.ok(hosts.includes("perplexity.ai"));
    assert.ok(hosts.includes("gemini.google.com"));
  });
});
