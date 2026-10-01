// Marketr — Phase 18 slice 3 tests: StackAdapt GraphQL client.
// Run: npx tsx --test lib/adplatforms/stackadapt/__tests__/client.test.ts
//
// Pure: mocked fetch, no DB, no real StackAdapt key. Covers the auth
// surface (401 → AUTH_FAILED), the userErrors trap, money conversions,
// inventory-option validation, the modeled write/query shapes, and the
// UNVERIFIED fail-closed codes for the budget and reporting shapes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  StackAdaptClient,
  StackAdaptError,
  centsToMajorString,
  majorStringToCents,
  parseInventoryOptions,
  STACKADAPT_GRAPHQL_URL,
  STACKADAPT_SANDBOX_GRAPHQL_URL,
} from "../client";

const KEY = "test-graphql-api-key";

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
}

function mockFetch(handler: (call: RecordedCall) => { status: number; json: unknown }) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const call: RecordedCall = {
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as RecordedCall["body"],
    };
    calls.push(call);
    const { status, json } = handler(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function okData(data: unknown) {
  return { status: 200, json: { data } };
}

describe("money helpers", () => {
  it("converts cents to MoneyValue decimal strings", () => {
    assert.equal(centsToMajorString(10000), "100.00");
    assert.equal(centsToMajorString(1057), "10.57");
    assert.equal(centsToMajorString(1), "0.01");
  });

  it("converts MoneyValue strings to cents", () => {
    assert.equal(majorStringToCents("100.57"), 10057);
    assert.equal(majorStringToCents("0"), 0);
  });

  it("rejects invalid MoneyValue strings", () => {
    assert.throws(() => majorStringToCents("abc"), (e: Error) => e instanceof StackAdaptError && e.code === "BAD_RESPONSE");
  });
});

describe("inventory options", () => {
  it("accepts absent inventory", () => {
    assert.deepEqual(parseInventoryOptions(undefined, "audio"), {});
    assert.deepEqual(parseInventoryOptions(null, "display"), {});
  });

  it("rejects unknown flags fail-closed", () => {
    assert.throws(
      () => parseInventoryOptions({ cinemaPmp: true, mysteryFlag: true }, "ctv"),
      (e: Error) => e instanceof StackAdaptError && e.code === "INVALID_PAYLOAD",
    );
  });

  it("rejects non-boolean flags", () => {
    assert.throws(
      () => parseInventoryOptions({ podcastAudio: "yes" }, "audio"),
      (e: Error) => e instanceof StackAdaptError && e.code === "INVALID_PAYLOAD",
    );
  });

  it("enforces channel pairing", () => {
    assert.deepEqual(parseInventoryOptions({ podcastAudio: true }, "audio"), { podcastAudio: true });
    assert.deepEqual(parseInventoryOptions({ cinemaPmp: true }, "ctv"), { cinemaPmp: true });
    assert.deepEqual(parseInventoryOptions({ newspaperDigital: true }, "native"), { newspaperDigital: true });
    assert.throws(
      () => parseInventoryOptions({ podcastAudio: true }, "display"),
      (e: Error) => e instanceof StackAdaptError && e.code === "INVALID_PAYLOAD",
    );
    assert.throws(
      () => parseInventoryOptions({ cinemaPmp: true }, "audio"),
      (e: Error) => e instanceof StackAdaptError && e.code === "INVALID_PAYLOAD",
    );
    assert.throws(
      () => parseInventoryOptions({ newspaperDigital: true }, "video"),
      (e: Error) => e instanceof StackAdaptError && e.code === "INVALID_PAYLOAD",
    );
  });
});

describe("auth", () => {
  it("requires an API key at construction", () => {
    assert.throws(
      () => new StackAdaptClient({ auth: { apiKey: "  " } }),
      (e: Error) => e instanceof StackAdaptError && e.code === "MISSING_AUTH",
    );
  });

  it("sends the GraphQL key as a Bearer <redacted> the production endpoint", async () => {
    const { fetchImpl, calls } = mockFetch(() => okData({ tokenInfo: { __typename: "TokenInfo" } }));
    const client = new StackAdaptClient({ auth: { apiKey: KEY }, fetchImpl });
    await client.checkAuth();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, STACKADAPT_GRAPHQL_URL);
    assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
    assert.ok(!("X-Authorization" in calls[0].headers), "must not send the REST key header");
  });

  it("honors the sandbox endpoint", async () => {
    const { fetchImpl, calls } = mockFetch(() => okData({ tokenInfo: { __typename: "TokenInfo" } }));
    const client = new StackAdaptClient({ auth: { apiKey: KEY, baseUrl: STACKADAPT_SANDBOX_GRAPHQL_URL }, fetchImpl });
    await client.checkAuth();
    assert.equal(calls[0].url, STACKADAPT_SANDBOX_GRAPHQL_URL);
  });

  it("maps 401 to AUTH_FAILED on a bad key", async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 401,
      json: { errors: [{ message: "Schema introspection requires authentication." }] },
    }));
    const client = new StackAdaptClient({ auth: { apiKey: "bad-key" }, fetchImpl });
    await assert.rejects(client.checkAuth(), (e: Error) => e instanceof StackAdaptError && e.code === "AUTH_FAILED");
  });

  it("maps 429 to RATE_LIMITED", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 429, json: {} }));
    const client = new StackAdaptClient({ auth: { apiKey: KEY }, fetchImpl });
    await assert.rejects(client.checkAuth(), (e: Error) => e instanceof StackAdaptError && e.code === "RATE_LIMITED");
  });

  it("surfaces top-level GraphQL errors with the trace id", async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      json: { errors: [{ message: "Something broke", extensions: { traceId: "abc123" } }] },
    }));
    const client = new StackAdaptClient({ auth: { apiKey: KEY }, fetchImpl });
    await assert.rejects(
      client.checkAuth(),
      (e: Error) => e instanceof StackAdaptError && e.code === "API_ERROR" && e.message.includes("abc123"),
    );
  });

  it("refuses writes to an unknown environment", async () => {
    const { fetchImpl } = mockFetch(() => okData({}));
    const client = new StackAdaptClient({ auth: { apiKey: KEY, baseUrl: "https://evil.example.com/graphql" }, fetchImpl });
    await assert.rejects(
      client.pauseCampaigns(["c1"]),
      (e: Error) => e instanceof StackAdaptError && e.code === "UNKNOWN_ENVIRONMENT",
    );
  });
});

describe("createCampaignGroup", () => {
  function groupHandler() {
    return mockFetch(() =>
      okData({ createCampaignGroup: { campaignGroup: { id: "grp_1", name: "G" }, userErrors: [] } }),
    );
  }

  it("sends the budgeting-container input with a MoneyValue budget", async () => {
    const { fetchImpl, calls } = groupHandler();
    const client = new StackAdaptClient({ auth: { apiKey: KEY }, fetchImpl });
    const group = await client.createCampaignGroup({
      advertiserId: "adv_1",
      name: "Launch group",
      dailyBudgetCents: 50000,
      startDate: "2026-10-01",
      endDate: "2026-10-31",
    });
    assert.equal(group.id, "grp_1");
    const vars = calls[0].body.variables.input as Record<string, unknown>;
    assert.equal(vars.advertiserId, "adv_1");
    assert.equal(vars.budgetType, "DAILY");
    assert.equal(vars.budgetAllocation, "500.00");
    assert.deepEqual(vars.flights, [{ startDate: "2026-10-01", endDate: "2026-10-31" }]);
    assert.ok(calls[0].body.query.includes("createCampaignGroup"));
  });

  it("treats userErrors as a failed mutation (the 200-OK trap)", async () => {
    const { fetchImpl } = mockFetch(() =>
      okData({
        createCampaignGroup: {
          campaignGroup: null,
          userErrors: [{ message: "Budget below minimum", path: ["budgetAllocation"] }],
        },
      }),
    );
    const client = new StackAdaptClient({ auth: { apiKey: KEY }, fetchImpl });
    await assert.rejects(
      client.createCampaignGroup({ advertiserId: "adv_1", name: "G", dailyBudgetCents: 1, startDate: "2026-10-01" }),
      (e: Error) =>
        e instanceof StackAdaptError && e.code === "USER_ERROR" && e.message.includes("Budget below minimum"),
    );
  });

  it("validates input before any network call", async () => {
    const { fetchImpl, calls } = groupHandler();
    const client = new StackAdaptClient({ auth: { apiKey: KEY }, fetchImpl });
    await assert.rejects(
      client.createCampaignGroup({ advertiserId: "adv_1", name: "G", dailyBudgetCents: -5, startDate: "2026-10-01" }),
      (e: Error) => e instanceof StackAdaptError && e.code === "INVALID_INPUT",
    );
    await assert.rejects(
      client.createCampaignGroup({ advertiserId: "adv_1", name: "G", dailyBudgetCents: 100, startDate: "10/01/2026" }),
      (e: Error) => e instanceof StackAdaptError && e.code === "INVALID_INPUT",
    );
    assert.equal(calls.length, 0);
  });
});

describe("upsertCampaign", () => {
  it("rejects unsupported channels before the network", async () => {
    const { fetchImpl, calls } = mockFetch(() => okData({}));
    const client = new StackAdaptClient({ auth: { apiKey: KEY }, fetchImpl });
    await assert.rejects(
      client.upsertCampaign({ campaignGroupId: "grp_1", channel: "billboard" as never, name: "C" }),
      (e: Error) => e instanceof StackAdaptError && e.code === "UNSUPPORTED_CHANNEL",
    );
    assert.equal(calls.length, 0);
  });

  it("sends the channel-typed upsert, defaulting to paused", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      okData({
        upsertCampaign: {
          campaign: { __typename: "AudioCampaign", id: "cmp_1", campaignStatus: "PAUSED", channelType: "audio" },
          userErrors: [],
        },
      }),
    );
    const client = new StackAdaptClient({ auth: { apiKey: KEY }, fetchImpl });
    const campaign = await client.upsertCampaign({ campaignGroupId: "grp_1", channel: "audio", name: "Podcast test" });
    assert.equal(campaign.id, "cmp_1");
    const vars = calls[0].body.variables.input as Record<string, unknown>;
    assert.equal(vars.channelType, "AUDIO");
    assert.equal(vars.paused, true);
    assert.equal(vars.campaignGroupId, "grp_1");
  });
});

describe("pauseCampaigns", () => {
  it("requires ids and sends the pause mutation", async () => {
    const { fetchImpl, calls } = mockFetch(() => okData({ pauseCampaigns: { userErrors: [] } }));
    const client = new StackAdaptClient({ auth: { apiKey: KEY }, fetchImpl });
    await assert.rejects(client.pauseCampaigns([]), (e: Error) => e instanceof StackAdaptError && e.code === "INVALID_INPUT");
    await client.pauseCampaigns(["cmp_1", "cmp_2"]);
    assert.ok(calls[0].body.query.includes("pauseCampaigns"));
    assert.deepEqual(calls[0].body.variables.ids, ["cmp_1", "cmp_2"]);
  });
});

describe("setCampaignGroupBudget (unverified)", () => {
  it("wraps a platform rejection in UNVERIFIED_BUDGET_MUTATION", async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      json: { errors: [{ message: 'Cannot query field "updateCampaignGroup" on type "Mutation"' }] },
    }));
    const client = new StackAdaptClient({ auth: { apiKey: KEY }, fetchImpl });
    await assert.rejects(
      client.setCampaignGroupBudget("grp_1", 60000),
      (e: Error) => e instanceof StackAdaptError && e.code === "UNVERIFIED_BUDGET_MUTATION",
    );
  });
});

describe("campaignDelivery (unverified)", () => {
  it("parses day-grain records with MoneyValue strings", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      okData({
        campaignDelivery: {
          records: [
            {
              date: "2026-09-28",
              campaign: { id: "cmp_1" },
              impressions: 1000,
              clicks: 25,
              cost: "45.50",
              conversions: 3,
              revenue: "120.00",
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
    );
    const client = new StackAdaptClient({ auth: { apiKey: KEY }, fetchImpl });
    const page = await client.campaignDelivery({ campaignIds: ["cmp_1"], startDate: "2026-09-28", endDate: "2026-09-29" });
    assert.equal(page.nodes.length, 1);
    assert.deepEqual(page.nodes[0], {
      date: "2026-09-28",
      campaignId: "cmp_1",
      impressions: 1000,
      clicks: 25,
      cost: "45.50",
      conversions: 3,
      revenue: "120.00",
    });
    assert.equal(page.hasNextPage, false);
    assert.ok(calls[0].body.query.includes("campaignDelivery"));
  });

  it("fails closed on malformed records", async () => {
    const { fetchImpl } = mockFetch(() =>
      okData({
        campaignDelivery: {
          records: [{ date: "not-a-date", campaign: { id: "cmp_1" }, impressions: 1, clicks: 1, cost: "1.00", conversions: 0, revenue: "0" }],
          pageInfo: { hasNextPage: false },
        },
      }),
    );
    const client = new StackAdaptClient({ auth: { apiKey: KEY }, fetchImpl });
    await assert.rejects(
      client.campaignDelivery({ startDate: "2026-09-28", endDate: "2026-09-29" }),
      (e: Error) => e instanceof StackAdaptError && e.code === "BAD_RESPONSE",
    );
  });

  it("wraps a schema rejection in UNVERIFIED_REPORTING_QUERY", async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      json: { errors: [{ message: 'Cannot query field "campaignDelivery" on type "Query"' }] },
    }));
    const client = new StackAdaptClient({ auth: { apiKey: KEY }, fetchImpl });
    await assert.rejects(
      client.campaignDelivery({ startDate: "2026-09-28", endDate: "2026-09-29" }),
      (e: Error) => e instanceof StackAdaptError && e.code === "UNVERIFIED_REPORTING_QUERY",
    );
  });
});
