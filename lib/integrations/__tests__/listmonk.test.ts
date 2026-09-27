// Marketr — Phase 12: Listmonk sidecar lib tests.
// Run: npx tsx --test lib/integrations/__tests__/listmonk.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LISTMONK_NOT_CONFIGURED_MESSAGE,
  ListmonkApiError,
  ListmonkConfigError,
  addListmonkSubscriber,
  createListmonkList,
  getListmonkConfig,
  listmonkCampaigns,
  listmonkLists,
  listmonkStatus,
  mapCampaign,
  mapList,
  mapSubscriber,
  scheduleListmonkCampaign,
  sendListmonkCampaign,
} from "../listmonk";

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
  LISTMONK_URL: "http://localhost:9000/",
  LISTMONK_USER: "api",
  LISTMONK_TOKEN: "secret-token",
};

describe("getListmonkConfig / listmonkStatus", () => {
  it("strips trailing slashes from the URL", () =>
    withEnv(CONFIGURED, () => {
      assert.equal(getListmonkConfig().url, "http://localhost:9000");
    }));

  it("is unconfigured when any credential is missing", () =>
    withEnv({ LISTMONK_URL: undefined, LISTMONK_USER: "u", LISTMONK_TOKEN: "t" }, () => {
      assert.equal(listmonkStatus().configured, false);
      assert.equal(listmonkStatus().isLive, false);
    }));

  it("is configured when all three are set", () =>
    withEnv(CONFIGURED, () => {
      assert.equal(listmonkStatus().configured, true);
      assert.equal(listmonkStatus().isLive, true);
    }));
});

describe("listmonkLists", () => {
  it("sends Basic auth and maps the wrapped response", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([
        {
          status: 200,
          body: { data: { results: [{ id: 3, name: "Newsletter", type: "public", optin: "double", tags: ["a"], description: "d", subscriber_count: 42 }], total: 1 } },
        },
      ]);
      try {
        const lists = await listmonkLists();
        assert.equal(m.calls.length, 1);
        assert.equal(m.calls[0].url, "http://localhost:9000/api/lists?per_page=all");
        const auth = (m.calls[0].opts.headers as Record<string, string>).Authorization;
        assert.equal(auth, `Basic ${Buffer.from("api:secret-token").toString("base64")}`);
        assert.deepEqual(lists[0], {
          id: 3,
          name: "Newsletter",
          type: "public",
          optin: "double",
          tags: ["a"],
          description: "d",
          subscriberCount: 42,
        });
      } finally {
        m.restore();
      }
    }));

  it("throws ListmonkConfigError with the honest message when unconfigured", () =>
    withEnv({ LISTMONK_URL: undefined, LISTMONK_USER: "u", LISTMONK_TOKEN: "t" }, async () => {
      await assert.rejects(() => listmonkLists(), (e: unknown) => {
        assert.ok(e instanceof ListmonkConfigError);
        assert.equal((e as Error).message, LISTMONK_NOT_CONFIGURED_MESSAGE);
        return true;
      });
    }));

  it("maps a 401 into ListmonkApiError without leaking credentials", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([{ status: 401, body: { message: "Unauthorized" } }]);
      try {
        await assert.rejects(() => listmonkLists(), (e: unknown) => {
          assert.ok(e instanceof ListmonkApiError);
          assert.equal((e as ListmonkApiError).status, 401);
          assert.match((e as Error).message, /unauthorized/i);
          // No secret material in the error surface.
          assert.doesNotMatch(JSON.stringify(e), /secret-token/);
          return true;
        });
      } finally {
        m.restore();
      }
    }));
});

describe("createListmonkList", () => {
  it("posts defaults (private, double opt-in) and maps the result", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([
        { status: 201, body: { data: { id: 7, name: "Launch", type: "private", optin: "double", tags: [], description: "" } } },
      ]);
      try {
        const list = await createListmonkList({ name: "Launch" });
        const sent = JSON.parse(m.calls[0].opts.body as string);
        assert.equal(sent.type, "private");
        assert.equal(sent.optin, "double");
        assert.equal(list.id, 7);
      } finally {
        m.restore();
      }
    }));

  it("rejects an empty name before any network call", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([]);
      try {
        await assert.rejects(() => createListmonkList({ name: "  " }), ListmonkConfigError);
        assert.equal(m.calls.length, 0);
      } finally {
        m.restore();
      }
    }));
});

describe("addListmonkSubscriber", () => {
  it("posts email + list ids with enabled status", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([
        { status: 201, body: { data: { id: 9, email: "a@b.com", name: "A", status: "enabled", lists: [{ id: 3, name: "Newsletter" }] } } },
      ]);
      try {
        const s = await addListmonkSubscriber({ email: "A@B.com", name: "A", listIds: [3] });
        const sent = JSON.parse(m.calls[0].opts.body as string);
        assert.equal(sent.email, "a@b.com");
        assert.equal(sent.status, "enabled");
        assert.deepEqual(sent.lists, [3]);
        assert.equal(mapSubscriber(sent) instanceof Object, true);
        assert.equal(s.id, 9);
      } finally {
        m.restore();
      }
    }));

  it("rejects bad email and empty list ids locally", () =>
    withEnv(CONFIGURED, async () => {
      await assert.rejects(() => addListmonkSubscriber({ email: "nope", listIds: [1] }), ListmonkConfigError);
      await assert.rejects(() => addListmonkSubscriber({ email: "a@b.com", listIds: [] }), ListmonkConfigError);
    }));
});

describe("campaigns", () => {
  const CAMPAIGN = {
    id: 5,
    name: "Launch",
    subject: "It's live",
    status: "draft",
    lists: [{ id: 3, name: "Newsletter" }],
    type: "regular",
    messenger: "email",
    send_at: null,
    sent: 0,
    created_at: "2026-09-27T00:00:00Z",
    updated_at: "2026-09-27T00:00:00Z",
  };

  it("listmonkCampaigns maps the wrapped list", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([{ status: 200, body: { data: { results: [CAMPAIGN], total: 1 } } }]);
      try {
        const rows = await listmonkCampaigns({ status: "draft" });
        assert.match(m.calls[0].url, /status=draft/);
        assert.equal(rows[0].id, 5);
        assert.equal(rows[0].subject, "It's live");
        assert.deepEqual(rows[0].lists, [{ id: 3, name: "Newsletter" }]);
      } finally {
        m.restore();
      }
    }));

  it("sendListmonkCampaign PUTs status=running", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([{ status: 200, body: { data: { ...CAMPAIGN, status: "running" } } }]);
      try {
        const c = await sendListmonkCampaign(5);
        assert.equal(m.calls[0].url, "http://localhost:9000/api/campaigns/5/status");
        assert.deepEqual(JSON.parse(m.calls[0].opts.body as string), { status: "running" });
        assert.equal(c.status, "running");
        assert.equal(mapCampaign(CAMPAIGN).id, 5);
      } finally {
        m.restore();
      }
    }));

  it("scheduleListmonkCampaign refuses the past", () =>
    withEnv(CONFIGURED, async () => {
      const m = mockFetch([]);
      try {
        await assert.rejects(
          () => scheduleListmonkCampaign(5, new Date(Date.now() - 1000).toISOString()),
          (e: unknown) => e instanceof ListmonkConfigError && /future/.test(e.message),
        );
        assert.equal(m.calls.length, 0);
      } finally {
        m.restore();
      }
    }));
});
