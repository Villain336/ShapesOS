// Marketr — Wave 2 context.dev slice 1 tests: REST client.
// Run: npx tsx --test lib/knowledge/contextdev/__tests__/client.test.ts
//
// Pure: mocked fetch, no database, no network. Covers endpoint paths,
// auth header, query params, error-code mapping, response normalization,
// and the key-never-leaks invariant.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createContextDevClient,
  ContextDevError,
  type FetchImpl,
} from "../client";

const API_KEY = "ctx_test_key_123";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function mockFetch(
  handler: (call: RecordedCall) => { status: number; json: unknown },
): { fetchImpl: FetchImpl; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchImpl = async (input: string, init: RequestInit = {}) => {
    const call: RecordedCall = {
      url: input,
      method: (init.method ?? "GET").toUpperCase(),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const { status, json } = handler(call);
    return {
      status,
      json: async () => json,
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

function ok(json: unknown) {
  return mockFetch(() => ({ status: 200, json }));
}

describe("scrapeMarkdown", () => {
  it("hits the verified endpoint with Bearer auth and query params", async () => {
    const { fetchImpl, calls } = ok({
      markdown: "# Hello",
      metadata: { title: "Hi", description: "desc" },
    });
    const client = createContextDevClient({ apiKey: API_KEY }, fetchImpl);
    const res = await client.scrapeMarkdown("https://example.com", {
      includeLinks: true,
      shortenBase64Images: false,
    });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call.url.startsWith("https://api.context.dev/v1/web/scrape/markdown?"));
    assert.ok(call.url.includes("url=https%3A%2F%2Fexample.com"));
    assert.ok(call.url.includes("includeLinks=true"));
    assert.equal(call.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(res.markdown, "# Hello");
    assert.equal(res.title, "Hi");
    assert.equal(res.description, "desc");
  });

  it("rejects an empty URL without calling the API", async () => {
    const { fetchImpl, calls } = ok({});
    const client = createContextDevClient({ apiKey: API_KEY }, fetchImpl);
    await assert.rejects(() => client.scrapeMarkdown("   "), (e: unknown) => {
      assert.ok(e instanceof ContextDevError && e.code === "BAD_REQUEST");
      return true;
    });
    assert.equal(calls.length, 0);
  });
});

describe("other web operations", () => {
  it("scrapeHtml posts to /web/scrape/html", async () => {
    const { fetchImpl, calls } = ok({ html: "<p>x</p>" });
    const client = createContextDevClient({ apiKey: API_KEY }, fetchImpl);
    const res = await client.scrapeHtml("https://example.com");
    assert.ok(calls[0].url.startsWith("https://api.context.dev/v1/web/scrape/html?"));
    assert.equal(res.html, "<p>x</p>");
  });

  it("crawlSitemap accepts the { urls } shape", async () => {
    const { fetchImpl, calls } = ok({ urls: ["https://a.com/1", "https://a.com/2"] });
    const client = createContextDevClient({ apiKey: API_KEY }, fetchImpl);
    const res = await client.crawlSitemap("a.com", { maxLinks: 50 });
    assert.ok(calls[0].url.includes("/v1/web/scrape/sitemap?"));
    assert.ok(calls[0].url.includes("domain=a.com"));
    assert.ok(calls[0].url.includes("maxLinks=50"));
    assert.deepEqual(res.urls, ["https://a.com/1", "https://a.com/2"]);
  });

  it("crawlSitemap accepts the { links: [{ url }] } shape", async () => {
    const { fetchImpl } = ok({ links: [{ url: "https://a.com/1", title: "t" }, { url: 42 }] });
    const client = createContextDevClient({ apiKey: API_KEY }, fetchImpl);
    const res = await client.crawlSitemap("a.com");
    assert.deepEqual(res.urls, ["https://a.com/1"]);
  });
});

describe("brand operations", () => {
  const brandJson = {
    brand: {
      name: "Acme",
      colors: ["#ff0000", "#00ff00"],
      fonts: ["Inter"],
      logos: ["https://acme.com/logo.png", { url: "https://acme.com/dark.png", variant: "dark" }],
      socials: { twitter: "https://x.com/acme" },
      naics: ["541511"],
    },
  };

  it("getBrandByDomain normalizes the profile", async () => {
    const { fetchImpl, calls } = ok(brandJson);
    const client = createContextDevClient({ apiKey: API_KEY }, fetchImpl);
    const res = await client.getBrandByDomain("Acme.com");
    assert.ok(calls[0].url.startsWith("https://api.context.dev/v1/brand/retrieve?"));
    assert.ok(calls[0].url.includes("domain=acme.com"));
    assert.equal(res.domain, "acme.com");
    assert.equal(res.name, "Acme");
    assert.deepEqual(res.colors, ["#ff0000", "#00ff00"]);
    assert.deepEqual(res.fonts, ["Inter"]);
    assert.deepEqual(res.logos, [
      { url: "https://acme.com/logo.png" },
      { url: "https://acme.com/dark.png", variant: "dark" },
    ]);
    assert.deepEqual(res.socials, { twitter: "https://x.com/acme" });
    assert.deepEqual(res.industryCodes, ["541511"]);
  });

  it("getBrandByEmail hits retrieve-by-email and rejects bad emails", async () => {
    const { fetchImpl, calls } = ok(brandJson);
    const client = createContextDevClient({ apiKey: API_KEY }, fetchImpl);
    await client.getBrandByEmail("Jane@Acme.com");
    assert.ok(calls[0].url.includes("/v1/brand/retrieve-by-email?"));
    assert.ok(calls[0].url.includes("email=jane%40acme.com"));
    await assert.rejects(() => client.getBrandByEmail("not-an-email"), (e: unknown) => {
      assert.ok(e instanceof ContextDevError && e.code === "BAD_REQUEST");
      return true;
    });
  });

  it("getBrandByName hits retrieve-by-name and rejects short names", async () => {
    const { fetchImpl, calls } = ok(brandJson);
    const client = createContextDevClient({ apiKey: API_KEY }, fetchImpl);
    await client.getBrandByName("Acme Inc", { countryCode: "US" });
    assert.ok(calls[0].url.includes("/v1/brand/retrieve-by-name?"));
    assert.ok(calls[0].url.includes("country_gl=US"));
    await assert.rejects(() => client.getBrandByName("ab"), (e: unknown) => {
      assert.ok(e instanceof ContextDevError && e.code === "BAD_REQUEST");
      return true;
    });
  });

  it("prefetchBrand POSTs and extractAiProducts sends maxProducts", async () => {
    const { fetchImpl, calls } = ok({ products: [{ name: "Widget" }] });
    const client = createContextDevClient({ apiKey: API_KEY }, fetchImpl);
    const pre = await client.prefetchBrand("acme.com");
    assert.equal(pre.ok, true);
    assert.equal(calls[0].method, "POST");
    assert.ok(calls[0].url.endsWith("/v1/brand/prefetch"));
    const ai = await client.extractAiProducts("acme.com", { maxProducts: 5 });
    assert.equal(ai.products.length, 1);
    assert.deepEqual(JSON.parse(calls[1].body!), { domain: "acme.com", maxProducts: 5 });
  });
});

describe("error mapping", () => {
  async function codeFor(status: number): Promise<string> {
    const { fetchImpl } = mockFetch(() => ({ status, json: {} }));
    const client = createContextDevClient({ apiKey: API_KEY }, fetchImpl);
    try {
      await client.scrapeMarkdown("https://example.com");
    } catch (e) {
      assert.ok(e instanceof ContextDevError);
      return e.code;
    }
    throw new Error("expected throw");
  }

  it("maps HTTP statuses to codes", async () => {
    assert.equal(await codeFor(401), "AUTH_FAILED");
    assert.equal(await codeFor(403), "AUTH_FAILED");
    assert.equal(await codeFor(429), "RATE_LIMITED");
    assert.equal(await codeFor(400), "BAD_REQUEST");
    assert.equal(await codeFor(404), "NOT_FOUND");
    assert.equal(await codeFor(500), "UPSTREAM_ERROR");
    assert.equal(await codeFor(503), "UPSTREAM_ERROR");
  });

  it("maps a fetch throw to NETWORK_ERROR", async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error("socket hang up");
    };
    const client = createContextDevClient({ apiKey: API_KEY }, fetchImpl);
    await assert.rejects(() => client.scrapeMarkdown("https://example.com"), (e: unknown) => {
      assert.ok(e instanceof ContextDevError && e.code === "NETWORK_ERROR");
      assert.ok((e as Error).message.includes("socket hang up"));
      return true;
    });
  });

  it("rejects a missing key before any network call", async () => {
    const { fetchImpl, calls } = ok({});
    const client = createContextDevClient({ apiKey: "  " }, fetchImpl);
    await assert.rejects(() => client.scrapeMarkdown("https://example.com"), /API key is missing/);
    assert.equal(calls.length, 0);
  });

  it("never includes the key in error messages", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 500, json: {} }));
    const client = createContextDevClient({ apiKey: API_KEY }, fetchImpl);
    try {
      await client.scrapeMarkdown("https://example.com");
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(!(e as Error).message.includes(API_KEY));
      assert.ok(!(e as Error).stack?.includes(API_KEY));
    }
  });
});
