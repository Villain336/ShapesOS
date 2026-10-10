// Phase 21A (WS=agentweb): the SearchProvider contract, run against all three
// adapters. Brave and Exa are tested against documented-shape FIXTURES (MOCK:
// no live key exists; the fixtures follow the vendors' published response
// shapes, they were not recorded from a live call, so live use is
// UNVERIFIED-LIVE). The mock provider serves canned pages and is labelled.
//   Brave: GET https://api.search.brave.com/res/v1/web/search, X-Subscription-Token,
//          web.results[{title,url,description,extra_snippets,page_age}]
//          (api-dashboard.search.brave.com/app/documentation/web-search/get-started)
//   Exa:   POST https://api.exa.ai/search, x-api-key, {query,type,numResults,contents},
//          results[{title,url,publishedDate,text,highlights}], costDollars.total
//          (exa.ai/docs/reference/search)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BraveProvider } from "../providers/brave";
import { ExaProvider } from "../providers/exa";
import { MockSearchProvider } from "../providers/mock";
import { resolveProviders } from "../providers";
import { SearchProviderError } from "../providers/errors";
import type { SearchProvider } from "../types";

const BRAVE_BODY = {
  web: {
    results: [
      { title: "Opening hours - <strong>Riverside</strong> Dental", url: "https://riverside.test/hours", description: "Open <strong>Mon</strong>-Fri 9:00 to 17:00.", extra_snippets: ["Closed weekends."], page_age: "2026-09-30T10:00:00" },
      { title: "NHS dentist costs", url: "https://www.nhs.uk/dental/costs", description: "A crown costs £450 at most NHS practices." },
      { title: "No url", description: "dropped" },
    ],
  },
};
const EXA_BODY = {
  requestId: "r1",
  results: [
    { title: "Riverside Dental hours", url: "https://riverside.test/hours", publishedDate: "2026-09-30T00:00:00.000Z", highlights: ["Open Mon-Fri 9:00 to 17:00."], text: "full text" },
    { title: "Crowns", url: "https://www.nhs.uk/dental/costs", text: "A crown costs £450 at most NHS practices. More text follows." },
  ],
  costDollars: { total: 0.007 },
};

interface Seen { url: string; method: string; headers: Headers; body: string }
function fake(status: number, body: unknown) {
  const seen: Seen[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchFn, seen };
}

type Maker = (status?: number, body?: unknown) => { provider: SearchProvider; seen: Seen[] };
const makers: Record<string, Maker> = {
  brave: (status = 200, body = BRAVE_BODY) => {
    const f = fake(status, body);
    return { provider: new BraveProvider({ apiKey: "bk", fetchFn: f.fetchFn }), seen: f.seen };
  },
  exa: (status = 200, body = EXA_BODY) => {
    const f = fake(status, body);
    return { provider: new ExaProvider({ apiKey: "ek", fetchFn: f.fetchFn }), seen: f.seen };
  },
  mock: () => ({ provider: new MockSearchProvider(), seen: [] }),
};

for (const [name, make] of Object.entries(makers)) {
  describe(`SearchProvider contract: ${name}`, () => {
    it("returns {results, costMicroUsd} with usable web results, labelled with its id", async () => {
      const { provider } = make();
      const out = await provider.search("riverside dental opening hours", { limit: 5 });
      assert.ok(out.results.length >= 1, "at least one result");
      for (const r of out.results) {
        assert.match(r.url, /^https?:\/\//);
        assert.ok(r.title.length > 0 && typeof r.snippet === "string");
        assert.equal(r.provider, provider.id);
        assert.equal(r.title.includes("<strong>"), false, "markup is stripped");
      }
      assert.ok(Number.isInteger(out.costMicroUsd) && out.costMicroUsd >= 0);
    });
    it("honours the limit", async () => {
      const out = await make().provider.search("riverside dental opening hours", { limit: 1 });
      assert.equal(out.results.length, 1);
    });
    it("says whether it is a mock", () => {
      assert.equal(make().provider.mock, name === "mock");
    });
  });
}

describe("Brave", () => {
  it("sends the documented request and parses the documented response", async () => {
    const { provider, seen } = makers.brave!();
    const out = await provider.search("dental hours", { limit: 7, freshness: "week" });
    const u = new URL(seen[0]!.url);
    assert.equal(`${u.origin}${u.pathname}`, "https://api.search.brave.com/res/v1/web/search");
    assert.deepEqual([u.searchParams.get("q"), u.searchParams.get("count"), u.searchParams.get("freshness")], ["dental hours", "7", "pw"]);
    assert.equal(seen[0]!.headers.get("x-subscription-token"), "bk");
    assert.equal(seen[0]!.headers.get("accept"), "application/json");
    assert.deepEqual(out.results[0], { url: "https://riverside.test/hours", title: "Opening hours - Riverside Dental", snippet: "Open Mon-Fri 9:00 to 17:00. Closed weekends.", publishedAt: "2026-09-30T10:00:00.000Z", provider: "brave" });
    assert.equal(out.results.length, 2, "an item with no url is dropped");
    assert.equal(out.costMicroUsd, 5000, "about $5 per 1,000 requests (vendor claim, unverified)");
  });
  it("is configured only with a key", () => {
    assert.equal(new BraveProvider({ apiKey: "" }).isConfigured(), false);
    assert.equal(new BraveProvider({ apiKey: "k" }).isConfigured(), true);
  });
});

describe("Exa", () => {
  it("sends the documented request and parses the documented response, with the cost the vendor reports", async () => {
    const { provider, seen } = makers.exa!();
    const out = await provider.search("dental hours", { limit: 4, freshness: "month" });
    assert.equal(seen[0]!.url, "https://api.exa.ai/search");
    assert.equal(seen[0]!.method, "POST");
    assert.equal(seen[0]!.headers.get("x-api-key"), "ek");
    const body = JSON.parse(seen[0]!.body);
    assert.deepEqual([body.query, body.numResults, body.type, typeof body.startPublishedDate], ["dental hours", 4, "auto", "string"]);
    assert.ok(body.contents.highlights);
    assert.deepEqual(out.results.map((r) => [r.url, r.snippet]), [
      ["https://riverside.test/hours", "Open Mon-Fri 9:00 to 17:00."],
      ["https://www.nhs.uk/dental/costs", "A crown costs £450 at most NHS practices. More text follows."],
    ]);
    assert.equal(out.results[0]!.publishedAt, "2026-09-30T00:00:00.000Z");
    assert.equal(out.costMicroUsd, 7000);
  });
  it("falls back to about $7 per 1,000 when the vendor reports no cost", async () => {
    const { provider } = makers.exa!(200, { results: [{ title: "T", url: "https://a.test/", text: "x" }] });
    assert.equal((await provider.search("q")).costMicroUsd, 7000);
  });
});

describe("failures are classified, never swallowed", () => {
  for (const name of ["brave", "exa"]) {
    it(`${name}: 429 is rate_limited, 401 is auth, 500 is unavailable, bad JSON is bad_response`, async () => {
      const kinds: Array<[number, unknown, string]> = [[429, {}, "rate_limited"], [401, {}, "auth"], [500, {}, "unavailable"], [200, "<html>not json", "bad_response"]];
      for (const [status, body, kind] of kinds) {
        await assert.rejects(() => makers[name]!(status, body).provider.search("q"), (e: unknown) => e instanceof SearchProviderError && e.kind === kind, `${status}`);
      }
    });
    it(`${name}: a network error is classified`, async () => {
      const provider = name === "brave" ? new BraveProvider({ apiKey: "k", fetchFn: async () => { throw new TypeError("fetch failed"); } }) : new ExaProvider({ apiKey: "k", fetchFn: async () => { throw new TypeError("fetch failed"); } });
      await assert.rejects(() => provider.search("q"), (e: unknown) => e instanceof SearchProviderError && e.kind === "network");
    });
  }
});

describe("MockSearchProvider", () => {
  it("serves fixtures whose words match the query, free, and nothing for a query it has no page for", async () => {
    const p = new MockSearchProvider();
    const hit = await p.search("riverside dental opening hours");
    assert.equal(hit.costMicroUsd, 0);
    assert.match(hit.results[0]!.url, /^https:\/\/riverside-dental\.example\.test\//);
    assert.deepEqual((await p.search("xylophone quantum zebra")).results, []);
  });
});

describe("resolveProviders", () => {
  const env = (e: Record<string, string>) => e;
  it("uses the configured live providers in default order", () => {
    assert.deepEqual(resolveProviders([], env({ BRAVE_SEARCH_API_KEY: "a", EXA_API_KEY: "b" })).providers.map((p) => p.id), ["brave", "exa"]);
    assert.deepEqual(resolveProviders([], env({ EXA_API_KEY: "b" })).providers.map((p) => p.id), ["exa"]);
  });
  it("falls back to the labelled mock when no key exists", () => {
    const r = resolveProviders([], env({}));
    assert.deepEqual(r.providers.map((p) => [p.id, p.mock]), [["mock", true]]);
    assert.match(r.notes.join(" "), /No search provider is configured/);
  });
  it("follows the workspace's order and says what it skipped", () => {
    const r = resolveProviders(["exa", "brave", "mock"], env({ BRAVE_SEARCH_API_KEY: "a" }));
    assert.deepEqual(r.providers.map((p) => p.id), ["brave", "mock"]);
    assert.match(r.notes.join(" "), /exa is not configured/);
  });
});
