// Marketr — Phase 12: Postiz sidecar lib tests.
// Run: npx tsx --test lib/integrations/__tests__/postiz.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  POSTIZ_NOT_CONFIGURED_MESSAGE,
  PostizApiError,
  PostizConfigError,
  buildPostizPayload,
  deletePostizPost,
  getPostizConfig,
  listPostizChannels,
  listPostizPosts,
  mapChannel,
  postizStatus,
  schedulePostizPost,
  verifyPostizKey,
} from "../postiz";

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  return Promise.resolve().then(async () => {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
}

function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; opts: RequestInit }> = [];
  let i = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = (async (url: string, opts: RequestInit = {}) => {
    calls.push({ url, opts });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = prev;
    },
  };
}

const CONFIGURED = {
  POSTIZ_URL: "http://localhost:5000/",
  POSTIZ_API_KEY: "postiz-test-key",
};

describe("getPostizConfig / postizStatus", () => {
  it("strips trailing slashes from the URL", () =>
    withEnv(CONFIGURED, () => {
      assert.equal(getPostizConfig().url, "http://localhost:5000");
    }));

  it("is unconfigured when the API key is missing", () =>
    withEnv({ POSTIZ_URL: "http://localhost:5000", POSTIZ_API_KEY: undefined }, () => {
      assert.equal(postizStatus().configured, false);
      assert.equal(postizStatus().isLive, false);
    }));

  it("is configured when both are set", () =>
    withEnv(CONFIGURED, () => {
      assert.equal(postizStatus().configured, true);
    }));
});

describe("listPostizChannels", () => {
  it("hits /public/v1/integrations with the raw key (no Bearer prefix)", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([
        {
          status: 200,
          body: [{ id: "int-1", identifier: "x", name: "@handle", picture: null, connectedAt: "2026-09-27T00:00:00Z" }],
        },
      ]);
      try {
        const channels = await listPostizChannels();
        assert.equal(m.calls[0].url, "http://localhost:5000/public/v1/integrations");
        const auth = (m.calls[0].opts.headers as Record<string, string>).Authorization;
        assert.equal(auth, "postiz-test-key");
        assert.ok(!auth.startsWith("Bearer"), "Postiz public API uses the raw key, no Bearer prefix");
        assert.deepEqual(channels[0], {
          id: "int-1",
          identifier: "x",
          name: "@handle",
          picture: null,
          connectedAt: "2026-09-27T00:00:00Z",
        });
        assert.deepEqual(mapChannel({ id: 1, identifier: "x" }).id, "1");
      } finally {
        m.restore();
      }
    }));

  it("throws PostizConfigError with the honest message when unconfigured", () =>
    withEnv({ POSTIZ_URL: undefined, POSTIZ_API_KEY: "k" }, async () => {
      await assert.rejects(() => listPostizChannels(), (e: unknown) => {
        assert.ok(e instanceof PostizConfigError);
        assert.equal((e as Error).message, POSTIZ_NOT_CONFIGURED_MESSAGE);
        return true;
      });
    }));
});

describe("verifyPostizKey", () => {
  it("returns true on 2xx and false on failure — never throws", () =>
    withEnv(CONFIGURED, async () => {
      const m1 = mockFetch([{ status: 200, body: {} }]);
      try {
        assert.equal(await verifyPostizKey(), true);
      } finally {
        m1.restore();
      }
      const m2 = mockFetch([{ status: 401, body: { message: "no" } }]);
      try {
        assert.equal(await verifyPostizKey(), false);
        assert.equal(m2.calls[0].url, "http://localhost:5000/public/v1/is-connected");
      } finally {
        m2.restore();
      }
    }));
});

describe("buildPostizPayload", () => {
  it("builds a schedule payload with per-channel settings", () => {
    const date = new Date(Date.now() + 3600_000).toISOString();
    const p = buildPostizPayload({
      type: "schedule",
      date,
      content: "Hello",
      channelIds: ["int-1", "int-2"],
      platformTypes: { "int-1": "x" },
    });
    assert.equal(p.type, "schedule");
    assert.equal(p.date, new Date(date).toISOString());
    const posts = p.posts as Array<Record<string, unknown>>;
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0].integration, { id: "int-1" });
    assert.deepEqual((posts[0].settings as Record<string, unknown>).__type, "x");
    assert.deepEqual((posts[0].value as Array<unknown>)[0], { content: "Hello", image: [] });
  });

  it("rejects empty content, no channels, missing/past dates locally", () => {
    assert.throws(() => buildPostizPayload({ type: "draft", content: "  ", channelIds: ["a"] }), PostizConfigError);
    assert.throws(() => buildPostizPayload({ type: "draft", content: "x", channelIds: [] }), PostizConfigError);
    assert.throws(
      () => buildPostizPayload({ type: "schedule", content: "x", channelIds: ["a"] }),
      /date is required/,
    );
    assert.throws(
      () =>
        buildPostizPayload({
          type: "schedule",
          date: new Date(Date.now() - 1000).toISOString(),
          content: "x",
          channelIds: ["a"],
        }),
      /future/,
    );
  });
});

describe("schedulePostizPost / listPostizPosts / deletePostizPost", () => {
  it("posts to /public/v1/posts", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([{ status: 201, body: { id: "post-1" } }]);
      try {
        const out = (await schedulePostizPost({
          type: "now",
          content: "Ship it",
          channelIds: ["int-1"],
        })) as Record<string, unknown>;
        assert.equal(m.calls[0].url, "http://localhost:5000/public/v1/posts");
        assert.equal(m.calls[0].opts.method, "POST");
        assert.equal(out.id, "post-1");
      } finally {
        m.restore();
      }
    }));

  it("maps the posts list to a trimmed shape", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([
        {
          status: 200,
          body: [
            {
              id: "p1",
              type: "schedule",
              date: "2026-09-28T10:00:00Z",
              posts: [
                {
                  value: [{ content: "Hi" }],
                  settings: { __type: "x" },
                },
              ],
              createdAt: "2026-09-27T00:00:00Z",
            },
          ],
        },
      ]);
      try {
        const posts = await listPostizPosts();
        assert.equal(posts[0].id, "p1");
        assert.equal(posts[0].content, "Hi");
        assert.deepEqual(posts[0].channels, ["x"]);
      } finally {
        m.restore();
      }
    }));

  it("maps a 400 into PostizApiError without leaking the key", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([{ status: 400, body: { message: "bad" } }]);
      try {
        await assert.rejects(() => schedulePostizPost({ type: "now", content: "x", channelIds: ["a"] }), (e: unknown) => {
          assert.ok(e instanceof PostizApiError);
          assert.equal((e as PostizApiError).status, 400);
          assert.doesNotMatch(JSON.stringify(e), /postiz-test-key/);
          return true;
        });
      } finally {
        m.restore();
      }
    }));

  it("deletePostizPost sends DELETE to the id path", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([{ status: 200, body: {} }]);
      try {
        await deletePostizPost("post-9");
        assert.equal(m.calls[0].url, "http://localhost:5000/public/v1/posts/post-9");
        assert.equal(m.calls[0].opts.method, "DELETE");
      } finally {
        m.restore();
      }
    }));
});
