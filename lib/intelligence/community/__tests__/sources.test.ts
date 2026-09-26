// Marketr — Phase 10 M8 tests: source adapters.
// Recorded fixtures only — zero live network.
// Run: npx tsx --test lib/intelligence/community/__tests__/sources.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { searchHackerNews } from "../sources/hn";
import { searchReddit } from "../sources/reddit";
import { fetchRssFeed } from "../sources/rss";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Recorded Algolia HN Search API response shape (2 hits: story + comment). */
const HN_FIXTURE = {
  hits: [
    {
      objectID: "42424242",
      title: "Ask HN: How do you do keyword research in 2026?",
      url: null,
      author: "indiehacker",
      points: 87,
      num_comments: 64,
      created_at: "2026-09-25T10:00:00.000Z",
      story_text: "Looking for workflows that don't cost $200/mo.",
      _tags: ["story", "author_indiehacker", "ask_hn"],
    },
    {
      objectID: "42424300",
      title: null,
      url: null,
      author: "seopro",
      points: 12,
      created_at: "2026-09-25T11:30:00.000Z",
      comment_text: "We switched off <b>acme-seo.com</b> last month &amp; never looked back.",
      _tags: ["comment", "author_seopro"],
    },
  ],
  nbHits: 2,
};

const REDDIT_TOKEN_FIXTURE = { access_token: "tok_test", token_type: "bearer", expires_in: 3600 };

/** Recorded oauth.reddit.com/search.json shape. */
const REDDIT_SEARCH_FIXTURE = {
  data: {
    children: [
      {
        data: {
          id: "1k2m3n",
          name: "t3_1k2m3n",
          title: "What's your content decay process?",
          selftext: "Our old posts keep slipping. How do you handle content decay?",
          permalink: "/r/SEO/comments/1k2m3n/whats_your_content_decay_process/",
          author: "contentperson",
          score: 45,
          num_comments: 23,
          created_utc: 1758800000,
          subreddit: "SEO",
        },
      },
    ],
  },
};

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel><title>Niche SEO Forum</title>
<item>
  <title>Anyone tried the new SERP API pricing?</title>
  <link>https://forum.example/t/123</link>
  <pubDate>Thu, 25 Sep 2026 09:00:00 GMT</pubDate>
  <description>Comparing vendors for a &lt;b&gt;serp api&lt;/b&gt; migration.</description>
</item>
<item>
  <title></title>
  <link>https://forum.example/t/124</link>
  <description>No title — should be skipped.</description>
</item>
</channel></rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Dev Marketing</title>
<entry>
  <title>Show HN style launch post</title>
  <link href="https://blog.example/launch"/>
  <published>2026-09-25T08:00:00Z</published>
  <summary>We just launched our tool.</summary>
</entry>
</feed>`;

function jsonFetch(body: unknown, ok = true) {
  return (async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

function textFetch(body: string) {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/rss+xml" },
    })) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("searchHackerNews (recorded fixture)", () => {
  it("parses stories and comments into threads", async () => {
    const threads = await searchHackerNews("keyword research", {
      fetchImpl: jsonFetch(HN_FIXTURE),
    });
    assert.equal(threads.length, 2);

    const [story, comment] = threads;
    assert.equal(story.source, "hacker_news");
    assert.equal(story.title, "Ask HN: How do you do keyword research in 2026?");
    assert.equal(story.url, "https://news.ycombinator.com/item?id=42424242");
    assert.equal(story.points, 87);
    assert.equal(story.commentCount, 64);

    assert.equal(comment.url, "https://news.ycombinator.com/item?id=42424300");
    // HTML stripped, entities decoded
    assert.match(comment.text, /acme-seo\.com/);
    assert.doesNotMatch(comment.text, /<b>/);
  });

  it("returns [] on transport failure (never throws)", async () => {
    const boom = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    assert.deepEqual(await searchHackerNews("x", { fetchImpl: boom }), []);
  });

  it("returns [] on HTTP error", async () => {
    assert.deepEqual(
      await searchHackerNews("x", { fetchImpl: jsonFetch({}, false) }),
      [],
    );
  });
});

describe("searchReddit", () => {
  const CONFIG = {
    clientId: "cid",
    clientSecret: "csec",
    refreshToken: "rtok",
    username: "testuser",
  };

  it("degrades gracefully when unconfigured — no fetch is issued", async () => {
    let calls = 0;
    const spy = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    for (const cfg of [null, undefined, {}, { ...CONFIG, refreshToken: "" }]) {
      const r = await searchReddit(cfg as never, "seo", { fetchImpl: spy });
      assert.equal(r.configured, false);
      assert.deepEqual(r.opportunities, []);
      assert.match(r.detail, /unconfigured/i);
    }
    assert.equal(calls, 0, "no HTTP when Reddit is unconfigured");
  });

  it("parses the official search listing with the user's credentials", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const router = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      if (String(url).includes("access_token")) {
        return new Response(JSON.stringify(REDDIT_TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify(REDDIT_SEARCH_FIXTURE), { status: 200 });
    }) as typeof fetch;

    const r = await searchReddit(CONFIG, "content decay", { fetchImpl: router });
    assert.equal(r.configured, true);
    assert.equal(r.opportunities.length, 1);
    const [t] = r.opportunities;
    assert.equal(t.source, "reddit");
    assert.equal(t.title, "What's your content decay process?");
    assert.equal(
      t.url,
      "https://www.reddit.com/r/SEO/comments/1k2m3n/whats_your_content_decay_process/",
    );
    assert.equal(t.feedName, "r/SEO");
    // User-Agent carries the user's identity (honest identity, one account)
    const searchCall = seen.find((s) => s.url.includes("oauth.reddit.com"));
    assert.ok(searchCall, "search went to the official OAuth endpoint");
    assert.match(
      String((searchCall!.init!.headers as Record<string, string>)["User-Agent"]),
      /testuser/,
    );
  });

  it("treats token-exchange failure as unconfigured-ish, without throwing", async () => {
    const bad = jsonFetch({ error: "invalid_grant" }, false);
    const r = await searchReddit(CONFIG, "seo", { fetchImpl: bad });
    assert.equal(r.configured, false);
    assert.deepEqual(r.opportunities, []);
  });
});

describe("fetchRssFeed (recorded fixtures)", () => {
  it("parses RSS 2.0 items, skipping title-less entries", async () => {
    const threads = await fetchRssFeed(
      { name: "Niche SEO Forum", url: "https://forum.example/rss" },
      { fetchImpl: textFetch(RSS_FIXTURE) },
    );
    assert.equal(threads.length, 1);
    const [t] = threads;
    assert.equal(t.source, "rss");
    assert.equal(t.title, "Anyone tried the new SERP API pricing?");
    assert.equal(t.url, "https://forum.example/t/123");
    assert.equal(t.feedName, "Niche SEO Forum");
    assert.match(t.text, /serp api/);
    assert.doesNotMatch(t.text, /<b>/);
  });

  it("parses Atom entries", async () => {
    const threads = await fetchRssFeed(
      { name: "Dev Marketing", url: "https://blog.example/atom" },
      { fetchImpl: textFetch(ATOM_FIXTURE) },
    );
    assert.equal(threads.length, 1);
    assert.equal(threads[0].url, "https://blog.example/launch");
    assert.equal(threads[0].title, "Show HN style launch post");
  });

  it("returns [] on fetch failure (never throws)", async () => {
    const boom = (async () => {
      throw new Error("dns fail");
    }) as typeof fetch;
    assert.deepEqual(
      await fetchRssFeed({ name: "x", url: "https://x.example/rss" }, { fetchImpl: boom }),
      [],
    );
  });
});
