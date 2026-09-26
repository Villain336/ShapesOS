// Marketr — Phase 10 M3: branded-mention adapter tests.
// Run: npx tsx --test lib/intelligence/geo/__tests__/mentions.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  gdeltSearchUrl,
  parseGdeltResponse,
  ccNewsIndexUrl,
  parseCcIndexResponse,
  searchGdelt,
  searchCcNews,
  resolveLicensedNewsSource,
  parseNewsApiResponse,
  searchLicensedNews,
  searchBrandedMentions,
} from "../mentions";

describe("gdeltSearchUrl", () => {
  it("builds an exact-phrase artlist query", () => {
    const url = gdeltSearchUrl("Acme Corp");
    assert.match(url, /api\.gdeltproject\.org/);
    assert.match(url, /mode=artlist/);
    assert.match(url, /query=%22Acme%20Corp%22/);
  });
});

describe("parseGdeltResponse", () => {
  it("maps articles to MentionHits", () => {
    const payload = {
      articles: [
        { title: "Acme launches X", url: "https://news.example.com/acme-x", seendate: "20260926", domain: "news.example.com" },
        { title: "No URL here" },
        { url: "https://news.example.com/no-title" },
      ],
    };
    const hits = parseGdeltResponse(payload);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].source, "gdelt");
    assert.equal(hits[0].title, "Acme launches X");
    assert.equal(hits[0].domain, "news.example.com");
  });

  it("returns [] for malformed payloads", () => {
    assert.deepEqual(parseGdeltResponse(null), []);
    assert.deepEqual(parseGdeltResponse({}), []);
    assert.deepEqual(parseGdeltResponse({ articles: "nope" }), []);
  });
});

describe("searchGdelt", () => {
  it("labels failures as honest gaps, never zero-fills", async () => {
    const failing = async () => {
      throw new Error("network down");
    };
    const r = await searchGdelt("Acme", { fetchFn: failing as unknown as typeof fetch });
    assert.equal(r.ok, false);
    assert.equal(r.hits.length, 0);
    assert.match(r.error ?? "", /network down/);
  });

  it("parses a successful fixture response", async () => {
    const ok = async () =>
      ({
        ok: true,
        json: async () => ({
          articles: [{ title: "Acme in the news", url: "https://t.co/x", seendate: "20260926" }],
        }),
      }) as unknown as Response;
    const r = await searchGdelt("Acme", { fetchFn: ok as unknown as typeof fetch });
    assert.equal(r.ok, true);
    assert.equal(r.hits.length, 1);
  });
});

describe("ccNewsIndexUrl", () => {
  it("builds a URL-keyed index query for the brand domain", () => {
    const url = ccNewsIndexUrl("https://www.acme.com/");
    assert.match(url, /index\.commoncrawl\.org/);
    assert.match(url, /acme\.com/);
    assert.match(url, /output=json/);
  });
});

describe("parseCcIndexResponse", () => {
  it("parses newline-delimited index JSON", () => {
    const text = [
      '{"url":"https://acme.com/blog/x","timestamp":"20260926000000","status":"200","mime":"text/html"}',
      '{"url":"https://acme.com/pricing","timestamp":"20260925000000","status":"200"}',
      "not json",
      "",
    ].join("\n");
    const hits = parseCcIndexResponse(text);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].source, "cc-news");
    assert.equal(hits[0].domain, "acme.com");
  });
});

describe("searchCcNews", () => {
  it("labels failures as honest gaps", async () => {
    const failing = async () => {
      throw new Error("timeout");
    };
    const r = await searchCcNews("acme.com", { fetchFn: failing as unknown as typeof fetch });
    assert.equal(r.ok, false);
    assert.equal(r.hits.length, 0);
    assert.ok(r.note.length > 0);
  });
});

describe("resolveLicensedNewsSource", () => {
  const KEEP_PROVIDER = process.env.M3_LICENSED_NEWS_PROVIDER;
  const KEEP_KEY = process.env.M3_NEWSAPI_KEY;
  const restore = () => {
    if (KEEP_PROVIDER === undefined) delete process.env.M3_LICENSED_NEWS_PROVIDER;
    else process.env.M3_LICENSED_NEWS_PROVIDER = KEEP_PROVIDER;
    if (KEEP_KEY === undefined) delete process.env.M3_NEWSAPI_KEY;
    else process.env.M3_NEWSAPI_KEY = KEEP_KEY;
  };

  it("is gracefully OFF when nothing is configured", () => {
    delete process.env.M3_LICENSED_NEWS_PROVIDER;
    delete process.env.M3_NEWSAPI_KEY;
    try {
      const c = resolveLicensedNewsSource();
      assert.equal(c.configured, false);
      assert.ok((c.reason ?? "").length > 0);
    } finally {
      restore();
    }
  });

  it("stays off when the provider is set but the key is missing", () => {
    process.env.M3_LICENSED_NEWS_PROVIDER = "newsapi";
    delete process.env.M3_NEWSAPI_KEY;
    try {
      const c = resolveLicensedNewsSource();
      assert.equal(c.configured, false);
      assert.match(c.reason ?? "", /M3_NEWSAPI_KEY/);
    } finally {
      restore();
    }
  });

  it("rejects unknown providers", () => {
    process.env.M3_LICENSED_NEWS_PROVIDER = "mystery-news";
    try {
      const c = resolveLicensedNewsSource();
      assert.equal(c.configured, false);
      assert.match(c.reason ?? "", /Unknown/);
    } finally {
      restore();
    }
  });

  it("configures when provider + key are set", () => {
    process.env.M3_LICENSED_NEWS_PROVIDER = "newsapi";
    process.env.M3_NEWSAPI_KEY = "test-key";
    try {
      const c = resolveLicensedNewsSource();
      assert.equal(c.configured, true);
      assert.equal(c.provider, "newsapi");
    } finally {
      restore();
    }
  });
});

describe("parseNewsApiResponse", () => {
  it("maps articles to licensed-news hits, skipping [Removed] and titleless", () => {
    const payload = {
      articles: [
        {
          title: "Acme launches X",
          url: "https://news.example.com/acme-x",
          publishedAt: "2026-09-26T10:00:00Z",
          description: "A big launch.",
        },
        { title: "[Removed]", url: "https://news.example.com/removed" },
        { title: "No URL here" },
      ],
    };
    const hits = parseNewsApiResponse(payload);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].source, "licensed-news");
    assert.equal(hits[0].title, "Acme launches X");
    assert.equal(hits[0].domain, "news.example.com");
    assert.equal(hits[0].snippet, "A big launch.");
  });

  it("returns [] for malformed payloads", () => {
    assert.deepEqual(parseNewsApiResponse(null), []);
    assert.deepEqual(parseNewsApiResponse({}), []);
  });
});

describe("searchLicensedNews", () => {
  const KEEP_PROVIDER = process.env.M3_LICENSED_NEWS_PROVIDER;
  const KEEP_KEY = process.env.M3_NEWSAPI_KEY;
  const restore = () => {
    if (KEEP_PROVIDER === undefined) delete process.env.M3_LICENSED_NEWS_PROVIDER;
    else process.env.M3_LICENSED_NEWS_PROVIDER = KEEP_PROVIDER;
    if (KEEP_KEY === undefined) delete process.env.M3_NEWSAPI_KEY;
    else process.env.M3_NEWSAPI_KEY = KEEP_KEY;
  };

  it("degrades gracefully when unconfigured: ok:false, error:null, never throws", async () => {
    delete process.env.M3_LICENSED_NEWS_PROVIDER;
    delete process.env.M3_NEWSAPI_KEY;
    try {
      const r = await searchLicensedNews("Acme");
      assert.equal(r.source, "licensed-news");
      assert.equal(r.ok, false);
      assert.equal(r.error, null);
      assert.deepEqual(r.hits, []);
      assert.ok((r.note ?? "").length > 0);
    } finally {
      restore();
    }
  });

  it("parses a fixture response when configured", async () => {
    process.env.M3_LICENSED_NEWS_PROVIDER = "newsapi";
    process.env.M3_NEWSAPI_KEY = "test-key";
    const ok = async () =>
      ({
        ok: true,
        json: async () => ({
          articles: [
            { title: "Acme in licensed news", url: "https://news.example.com/acme", publishedAt: "2026-09-26" },
          ],
        }),
      }) as unknown as Response;
    try {
      // No workspaceId → metering is skipped, so no DB is touched.
      const r = await searchLicensedNews("Acme", { fetchFn: ok as unknown as typeof fetch });
      assert.equal(r.ok, true);
      assert.equal(r.hits.length, 1);
      assert.equal(r.hits[0].source, "licensed-news");
    } finally {
      restore();
    }
  });

  it("labels HTTP failures as honest gaps", async () => {
    process.env.M3_LICENSED_NEWS_PROVIDER = "newsapi";
    process.env.M3_NEWSAPI_KEY = "test-key";
    const failing = async () => {
      throw new Error("downstream 500");
    };
    try {
      const r = await searchLicensedNews("Acme", { fetchFn: failing as unknown as typeof fetch });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /downstream 500/);
    } finally {
      restore();
    }
  });
});

describe("searchBrandedMentions", () => {
  const KEEP_PROVIDER = process.env.M3_LICENSED_NEWS_PROVIDER;
  const KEEP_KEY = process.env.M3_NEWSAPI_KEY;
  const restore = () => {
    if (KEEP_PROVIDER === undefined) delete process.env.M3_LICENSED_NEWS_PROVIDER;
    else process.env.M3_LICENSED_NEWS_PROVIDER = KEEP_PROVIDER;
    if (KEEP_KEY === undefined) delete process.env.M3_NEWSAPI_KEY;
    else process.env.M3_NEWSAPI_KEY = KEEP_KEY;
  };

  it("returns only the free layer by default (2 results)", async () => {
    const fetchFn = async (url: string) => {
      if (String(url).includes("gdeltproject")) {
        return { ok: true, json: async () => ({ articles: [] }) } as unknown as Response;
      }
      return { ok: true, text: async () => "" } as unknown as Response;
    };
    const rs = await searchBrandedMentions("Acme", "acme.com", { fetchFn: fetchFn as unknown as typeof fetch });
    assert.equal(rs.length, 2);
    assert.deepEqual(rs.map((r) => r.source), ["gdelt", "cc-news"]);
  });

  it("appends the licensed layer when opted in (graceful when unconfigured)", async () => {
    delete process.env.M3_LICENSED_NEWS_PROVIDER;
    delete process.env.M3_NEWSAPI_KEY;
    const fetchFn = async (url: string) => {
      if (String(url).includes("gdeltproject")) {
        return { ok: true, json: async () => ({ articles: [] }) } as unknown as Response;
      }
      return { ok: true, text: async () => "" } as unknown as Response;
    };
    try {
      const rs = await searchBrandedMentions("Acme", "acme.com", {
        fetchFn: fetchFn as unknown as typeof fetch,
        includeLicensed: true,
      });
      assert.equal(rs.length, 3);
      assert.equal(rs[2].source, "licensed-news");
      assert.equal(rs[2].ok, false);
      assert.equal(rs[2].error, null); // graceful off, not a failure
    } finally {
      restore();
    }
  });
});
