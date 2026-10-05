// ShapesOS Phase 4b — social provider layer: Postiz over raw REST (fetch
// mocked with response shapes from docs.postiz.com/public-api), metric
// mapping, deterministic mock engagement, provider selection.
// Run: npx tsx --test lib/social/__tests__/provider.test.ts

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  MockSocialProvider,
  PostizProvider,
  getSocialProvider,
  mockDailyMetrics,
  seriesToDaily,
  setSocialProviderForTests,
  socialMockAllowed,
} from "../provider";
import { buildPostizPayload, parseAnalytics, parseCreatedPosts } from "@/lib/integrations/postiz";

const CONFIGURED = { POSTIZ_URL: "http://postiz.test/", POSTIZ_API_KEY: "postiz-test-key" };

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

type Call = { url: string; init: RequestInit };
function mockFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const prev = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = prev) };
}

afterEach(() => setSocialProviderForTests(undefined));

describe("Postiz provider (recorded response shapes)", () => {
  it("uploads media as multipart to /public/v1/upload with the raw API key", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([{ body: { id: "e639003b", name: "image.png", path: "https://uploads.postiz.test/image.png", organizationId: "o1" } }]);
      try {
        const ref = await new PostizProvider().uploadMedia({ bytes: Buffer.from([1, 2, 3]), filename: "image.png", mimeType: "image/png" });
        assert.deepEqual(ref, { id: "e639003b", path: "https://uploads.postiz.test/image.png" });
        assert.equal(m.calls[0]!.url, "http://postiz.test/public/v1/upload");
        assert.equal(m.calls[0]!.init.method, "POST");
        assert.ok(m.calls[0]!.init.body instanceof FormData);
        const headers = m.calls[0]!.init.headers as Record<string, string>;
        assert.equal(headers.Authorization, "postiz-test-key", "no Bearer prefix");
        assert.equal(headers["Content-Type"], undefined, "multipart sets its own boundary");
        const file = (m.calls[0]!.init.body as FormData).get("file") as File;
        assert.equal(file.name, "image.png");
        assert.equal(file.size, 3);
      } finally {
        m.restore();
      }
    }));

  it("creates one post per channel with that channel's body and returns refs", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([{ status: 201, body: [{ postId: "pz-1", integration: "int-x" }, { postId: "pz-2", integration: "int-li" }] }]);
      try {
        const refs = await new PostizProvider().createPosts({
          type: "schedule",
          date: "2030-01-01T10:00:00.000Z",
          posts: [
            { channel: { id: "int-x", identifier: "x" }, body: "x body" },
            { channel: { id: "int-li", identifier: "linkedin-page" }, body: "li body" },
          ],
          media: [{ id: "m1", path: "https://uploads.postiz.test/a.png" }],
        });
        assert.deepEqual(refs, [
          { postId: "pz-1", integrationId: "int-x" },
          { postId: "pz-2", integrationId: "int-li" },
        ]);
        const payload = JSON.parse(String(m.calls[0]!.init.body));
        assert.equal(payload.type, "schedule");
        assert.equal(payload.date, "2030-01-01T10:00:00.000Z");
        assert.equal(payload.shortLink, false);
        assert.deepEqual(payload.posts[0], {
          integration: { id: "int-x" },
          value: [{ content: "x body", image: [{ id: "m1", path: "https://uploads.postiz.test/a.png" }] }],
          settings: { __type: "x" },
        });
        assert.equal(payload.posts[1].value[0].content, "li body");
        assert.equal(payload.posts[1].settings.__type, "linkedin-page");
      } finally {
        m.restore();
      }
    }));

  it("maps post states from GET /posts?startDate&endDate", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([
        {
          body: {
            posts: [
              { id: "pz-1", content: "a", publishDate: "2026-10-05T10:00:00.000Z", releaseURL: "https://x.com/a/status/1", state: "PUBLISHED", integration: { id: "int-x", providerIdentifier: "x", name: "X" } },
              { id: "pz-2", content: "b", publishDate: "2026-10-05T10:00:00.000Z", releaseURL: "", state: "ERROR", integration: { id: "int-li" } },
              { id: "other", state: "QUEUE" },
            ],
          },
        },
      ]);
      try {
        const from = new Date("2026-10-04T00:00:00.000Z");
        const to = new Date("2026-10-06T00:00:00.000Z");
        const out = await new PostizProvider().postStatuses(["pz-1", "pz-2"], { from, to });
        const url = new URL(m.calls[0]!.url);
        assert.equal(url.pathname, "/public/v1/posts");
        assert.equal(url.searchParams.get("startDate"), from.toISOString());
        assert.equal(url.searchParams.get("endDate"), to.toISOString());
        assert.deepEqual(out.get("pz-1"), { state: "published", releaseUrl: "https://x.com/a/status/1", publishedAt: "2026-10-05T10:00:00.000Z" });
        assert.equal(out.get("pz-2")?.state, "error");
        assert.equal(out.has("other"), false, "only the asked-for ids");
      } finally {
        m.restore();
      }
    }));

  it("reads per-post analytics and folds labels into daily metrics", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([
        {
          body: [
            { label: "Impressions", data: [{ total: "500", date: "2026-10-05" }, { total: "120", date: "2026-10-06" }], percentageChange: -76 },
            { label: "Likes", data: [{ total: "20", date: "2026-10-05" }], percentageChange: 0 },
            { label: "Reactions", data: [{ total: "999", date: "2026-10-05" }], percentageChange: 0 },
            { label: "Comments", data: [{ total: "3", date: "2026-10-06" }], percentageChange: 0 },
            { label: "Retweets", data: [{ total: "4", date: "2026-10-05" }], percentageChange: 0 },
            { label: "Clicks", data: [{ total: "11", date: "2026-10-05" }], percentageChange: 0 },
          ],
        },
      ]);
      try {
        const days = await new PostizProvider().postMetrics("pz-1", 7);
        assert.equal(m.calls[0]!.url, "http://postiz.test/public/v1/analytics/post/pz-1?date=7");
        assert.deepEqual(days, [
          { day: "2026-10-05", impressions: 500, likes: 20, comments: 0, shares: 4, clicks: 11 },
          { day: "2026-10-06", impressions: 120, likes: 0, comments: 3, shares: 0, clicks: 0 },
        ]);
      } finally {
        m.restore();
      }
    }));

  it("surfaces Postiz errors without the key", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([{ status: 401, body: { message: "Invalid API key" } }]);
      try {
        await assert.rejects(() => new PostizProvider().listChannels(), (e: unknown) => {
          assert.match((e as Error).message, /Invalid API key/);
          assert.doesNotMatch(JSON.stringify(e), /postiz-test-key/);
          return true;
        });
      } finally {
        m.restore();
      }
    }));
});

describe("Postiz payload helpers", () => {
  it("parses create-post responses (array, wrapped, junk)", () => {
    assert.deepEqual(parseCreatedPosts([{ postId: "a", integration: "i" }, { postId: "b", integration: { id: "j" } }, {}]), [
      { postId: "a", integrationId: "i" },
      { postId: "b", integrationId: "j" },
    ]);
    assert.deepEqual(parseCreatedPosts({ data: [{ id: "c" }] }), [{ postId: "c", integrationId: null }]);
    assert.deepEqual(parseCreatedPosts(null), []);
  });

  it("always sends a date (required by the create-post API)", () => {
    const p = buildPostizPayload({ type: "now", content: "x", channelIds: ["a"] });
    assert.ok(typeof p.date === "string" && Number.isFinite(Date.parse(p.date as string)));
  });

  it("drops malformed analytics points", () => {
    assert.deepEqual(parseAnalytics([{ label: "Likes", data: [{ total: "x", date: "2026-10-01" }, { total: 2, date: "2026-10-02T00:00:00Z" }] }, "junk"]), [
      { label: "Likes", data: [{ date: "2026-10-02", total: 2 }] },
    ]);
    assert.deepEqual(seriesToDaily([]), []);
  });
});

describe("mock provider", () => {
  it("is deterministic and only covers days since publishing", () => {
    const pub = new Date("2026-10-01T15:00:00Z");
    const now = new Date("2026-10-04T09:00:00Z");
    const a = mockDailyMetrics("post-1", pub, now, 30);
    const b = mockDailyMetrics("post-1", pub, now, 30);
    assert.deepEqual(a, b);
    assert.deepEqual(a.map((d) => d.day), ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    assert.ok(a[0]!.impressions > a[3]!.impressions, "launch-day peak decays");
    assert.notDeepEqual(mockDailyMetrics("post-2", pub, now, 30), a);
    assert.equal(mockDailyMetrics("post-1", pub, now, 2).length, 2, "window respected");
  });

  it("publishes and lists sample channels", async () => {
    const p = new MockSocialProvider();
    const ch = await p.listChannels();
    assert.ok(ch.every((c) => c.name.includes("(mock)")));
    const refs = await p.createPosts({ type: "now", posts: [{ channel: ch[0]!, body: "hi" }], media: [] });
    assert.equal(refs.length, 1);
    assert.equal((await p.postStatuses([refs[0]!.postId], { from: new Date(), to: new Date() })).get(refs[0]!.postId)?.state, "published");
    assert.deepEqual(await p.postMetrics("x", 7, { publishedAt: null, now: new Date() }), []);
  });
});

describe("provider selection", () => {
  it("Postiz when configured; mock outside production; none in production without opt-in", () =>
    withEnv({ POSTIZ_URL: undefined, POSTIZ_API_KEY: undefined, SOCIAL_MOCK_MODE: undefined }, async () => {
      assert.equal(socialMockAllowed({ NODE_ENV: "development" }), true);
      assert.equal(socialMockAllowed({ NODE_ENV: "production" }), false);
      assert.equal(socialMockAllowed({ NODE_ENV: "production", SOCIAL_MOCK_MODE: "1" }), true);
      assert.equal(getSocialProvider()?.name, process.env.NODE_ENV === "production" ? undefined : "mock");
      await withEnv(CONFIGURED, async () => assert.equal(getSocialProvider()?.name, "postiz"));
      setSocialProviderForTests(null);
      assert.equal(getSocialProvider(), null);
    }));
});
