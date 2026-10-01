// Marketr — Phase 18 slice 2 tests: Amazon Ads API client.
// Run: npx tsx --test lib/adplatforms/amazon/__tests__/client.test.ts
//
// Pure + mocked-fetch tests: payload builders, the create → pause →
// budget lifecycle against a fake Amazon API, header wiring, and error
// mapping. No live Amazon credentials are used anywhere.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AmazonAdsClient,
  AmazonAdsError,
  buildCampaignReportRequest,
  buildSbCampaignCreateBody,
  buildSbCampaignUpdateBody,
  buildSpCampaignCreateBody,
  buildSpCampaignUpdateBody,
  centsToMajor,
  majorToCents,
  regionBaseUrl,
  type AmazonAdsAuth,
} from "../client";

const AUTH: AmazonAdsAuth = {
  accessToken: "test-access-token",
  clientId: "test-lwa-client-id",
  profileId: "1234567890",
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(routes: Record<string, { status?: number; json: unknown }>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: unknown, init?: { method?: string; headers?: unknown; body?: unknown }) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url: u, method: init?.method ?? "GET", headers, body });
    const route = routes[u] ?? routes["*"];
    const status = route?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route?.json ?? {},
      text: async () => JSON.stringify(route?.json ?? {}),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("regions + money units", () => {
  it("resolves NA/EU/FE base URLs and rejects unknown regions", () => {
    assert.equal(regionBaseUrl("NA"), "https://advertising-api.amazon.com");
    assert.equal(regionBaseUrl("eu"), "https://advertising-api-eu.amazon.com");
    assert.equal(regionBaseUrl("FE"), "https://advertising-api-fe.amazon.com");
    assert.equal(regionBaseUrl(undefined), "https://advertising-api.amazon.com");
    assert.throws(() => regionBaseUrl("XX"), (e: unknown) => e instanceof AmazonAdsError && e.code === "UNKNOWN_REGION");
  });

  it("converts minor/major currency units", () => {
    assert.equal(centsToMajor(100000), 1000);
    assert.equal(centsToMajor(2599), 25.99);
    assert.equal(majorToCents(25.99), 2599);
  });
});

describe("payload builders", () => {
  it("builds an SP v3 create body in major units", () => {
    const body = buildSpCampaignCreateBody({
      name: "  Launch Test  ",
      targetingType: "manual",
      dailyBudgetCents: 5000,
      startDate: "20261001",
    });
    assert.deepEqual(body, {
      campaigns: [
        {
          name: "Launch Test",
          targetingType: "MANUAL",
          state: "PAUSED",
          dailyBudget: 50,
          startDate: "20261001",
        },
      ],
    });
  });

  it("builds an SB v4 create body with daily budget", () => {
    const body = buildSbCampaignCreateBody({
      name: "Brand Launch",
      dailyBudgetCents: 25000,
      startDate: "20261001",
      endDate: "20261231",
      state: "enabled",
      brandEntityId: "amzn1.brand.abc",
    });
    assert.deepEqual(body, {
      campaigns: [
        {
          name: "Brand Launch",
          state: "ENABLED",
          budgetType: "DAILY",
          budget: 250,
          startDate: "20261001",
          endDate: "20261231",
          brandEntityId: "amzn1.brand.abc",
        },
      ],
    });
  });

  it("rejects invalid create input", () => {
    assert.throws(
      () => buildSpCampaignCreateBody({ name: "", targetingType: "auto", dailyBudgetCents: 100, startDate: "20261001" }),
      (e: unknown) => e instanceof AmazonAdsError && e.code === "INVALID_INPUT",
    );
    assert.throws(
      () => buildSpCampaignCreateBody({ name: "x", targetingType: "auto", dailyBudgetCents: 0, startDate: "20261001" }),
      (e: unknown) => e instanceof AmazonAdsError && e.code === "INVALID_INPUT",
    );
    assert.throws(
      () => buildSpCampaignCreateBody({ name: "x", targetingType: "auto", dailyBudgetCents: 100, startDate: "10/01/2026" }),
      (e: unknown) => e instanceof AmazonAdsError && e.code === "INVALID_INPUT",
    );
  });

  it("builds SP/SB update bodies for pause and budget", () => {
    const pause = buildSpCampaignUpdateBody({ campaignId: "camp_1", state: "paused" });
    assert.deepEqual(pause, { campaigns: [{ campaignId: "camp_1", state: "PAUSED" }] });
    const budget = buildSbCampaignUpdateBody({ campaignId: "camp_2", dailyBudgetCents: 10000 });
    assert.deepEqual(budget, {
      campaigns: [{ campaignId: "camp_2", budgetType: "DAILY", budget: 100 }],
    });
    assert.throws(
      () => buildSpCampaignUpdateBody({ campaignId: "camp_1" }),
      (e: unknown) => e instanceof AmazonAdsError && e.code === "INVALID_INPUT",
    );
  });

  it("builds the v3 async report request", () => {
    const req = buildCampaignReportRequest({
      name: "marketr-campaign-2026-10-01",
      startDate: "2026-09-30",
      endDate: "2026-10-01",
      adProduct: "SPONSORED_PRODUCTS",
      campaignIds: ["camp_1"],
    });
    assert.equal(req.configuration.adProduct, "SPONSORED_PRODUCTS");
    assert.equal(req.configuration.reportTypeId, "spCampaigns");
    assert.equal(req.configuration.timeUnit, "DAILY");
    assert.ok((req.configuration.columns as string[]).includes("cost"));
    assert.throws(
      () => buildCampaignReportRequest({ name: "x", startDate: "09/30/2026", endDate: "2026-10-01", adProduct: "SPONSORED_BRANDS" }),
      (e: unknown) => e instanceof AmazonAdsError && e.code === "INVALID_INPUT",
    );
  });
});

describe("AmazonAdsClient (mocked API)", () => {
  it("requires auth at construction", () => {
    assert.throws(
      () => new AmazonAdsClient({ auth: { accessToken: "", clientId: "c", profileId: "p" } }),
      (e: unknown) => e instanceof AmazonAdsError && e.code === "MISSING_AUTH",
    );
  });

  it("lists profiles unscoped with the client-id header", async () => {
    const { fetchImpl, calls } = mockFetch({
      "https://advertising-api.amazon.com/v2/profiles": {
        json: [{ profileId: 123, countryCode: "US", currencyCode: "USD", accountInfo: { type: "seller" } }],
      },
    });
    const client = new AmazonAdsClient({ auth: AUTH, fetchImpl });
    const profiles = await client.listProfiles();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].profileId, 123);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers["Amazon-Ads-ClientId"], "test-lwa-client-id");
    assert.ok(!("Amazon-Advertising-API-Scope" in calls[0].headers), "profiles call must be unscoped");
  });

  it("creates an SP campaign with the v3 content type and scope headers", async () => {
    const { fetchImpl, calls } = mockFetch({
      "https://advertising-api.amazon.com/sp/campaigns": {
        json: { campaigns: [{ campaignId: "camp_new", name: "Launch Test", state: "PAUSED" }] },
      },
    });
    const client = new AmazonAdsClient({ auth: AUTH, fetchImpl });
    const created = await client.createSpCampaign({
      name: "Launch Test",
      targetingType: "manual",
      dailyBudgetCents: 5000,
      startDate: "20261001",
    });
    assert.equal(created.campaignId, "camp_new");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["Content-Type"], "application/vnd.spCampaign.v3+json");
    assert.equal(calls[0].headers["Amazon-Advertising-API-Scope"], "1234567890");
    assert.equal(calls[0].headers["Authorization"], "Bearer test-access-token");
    const body = calls[0].body as { campaigns: { dailyBudget: number }[] };
    assert.equal(body.campaigns[0].dailyBudget, 50);
  });

  it("runs pause then budget adjust as PUT updates", async () => {
    const { fetchImpl, calls } = mockFetch({
      "https://advertising-api.amazon.com/sp/campaigns": { json: { campaigns: [{}] } },
    });
    const client = new AmazonAdsClient({ auth: AUTH, fetchImpl });
    await client.pauseCampaign("sp", "camp_1");
    await client.setCampaignBudget("sp", "camp_1", 7500);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "PUT");
    assert.deepEqual((calls[0].body as { campaigns: unknown[] }).campaigns, [
      { campaignId: "camp_1", state: "PAUSED" },
    ]);
    assert.deepEqual((calls[1].body as { campaigns: unknown[] }).campaigns, [
      { campaignId: "camp_1", dailyBudget: 75 },
    ]);
  });

  it("lists SB campaigns under the v4 path", async () => {
    const { fetchImpl, calls } = mockFetch({
      "https://advertising-api.amazon.com/sb/v4/campaigns/list": {
        json: { campaigns: [{ campaignId: "sb_1", name: "Brand", state: "ENABLED" }] },
      },
    });
    const client = new AmazonAdsClient({ auth: AUTH, fetchImpl });
    const rows = await client.listCampaigns({ adProduct: "sb", states: ["ENABLED"] });
    assert.equal(rows.length, 1);
    assert.equal(calls[0].headers["Content-Type"], "application/vnd.sbcampaignresource.v4+json");
    const body = calls[0].body as { stateFilter: { include: string[] } };
    assert.deepEqual(body.stateFilter.include, ["ENABLED"]);
  });

  it("requests a report, polls status, and downloads rows", async () => {
    const { fetchImpl, calls } = mockFetch({
      "https://advertising-api.amazon.com/reporting/reports": { json: { reportId: "rpt_1" } },
      "https://advertising-api.amazon.com/reporting/reports/rpt_1": {
        json: { reportId: "rpt_1", status: "COMPLETED", url: "https://signed.example/report.json" },
      },
      "https://signed.example/report.json": {
        json: [{ date: "2026-09-30", campaignId: "camp_1", impressions: 100, clicks: 5, cost: 12.5, purchases7d: 1, sales7d: 40 }],
      },
    });
    const client = new AmazonAdsClient({ auth: AUTH, fetchImpl });
    const reportId = await client.requestCampaignReport({
      name: "r",
      startDate: "2026-09-30",
      endDate: "2026-09-30",
      adProduct: "SPONSORED_PRODUCTS",
    });
    assert.equal(reportId, "rpt_1");
    const status = await client.getReportStatus(reportId);
    assert.equal(status.status, "COMPLETED");
    assert.equal(status.url, "https://signed.example/report.json");
    const rows = await client.downloadReport(status.url!);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cost, 12.5);
    // The pre-signed download must NOT carry our auth headers.
    const dl = calls.find((c) => c.url === "https://signed.example/report.json")!;
    assert.ok(!("Authorization" in dl.headers), "pre-signed download must be unauthenticated");
  });

  it("maps HTTP failures to error codes without leaking tokens", async () => {
    const { fetchImpl } = mockFetch({
      "*": { status: 401, json: { message: "Unauthorized" } },
    });
    const client = new AmazonAdsClient({ auth: AUTH, fetchImpl });
    const err = await client.listProfiles().catch((e: unknown) => e);
    assert.ok(err instanceof AmazonAdsError);
    assert.equal(err.code, "AUTH_FAILED");
    assert.ok(!err.message.includes("test-access-token"), "token must never appear in errors");
  });

  it("maps 429 to RATE_LIMITED", async () => {
    const { fetchImpl } = mockFetch({ "*": { status: 429, json: {} } });
    const client = new AmazonAdsClient({ auth: AUTH, fetchImpl });
    const err = await client.listProfiles().catch((e: unknown) => e);
    assert.ok(err instanceof AmazonAdsError && err.code === "RATE_LIMITED");
  });

  it("fails closed on Sponsored TV (unverified REST surface)", async () => {
    const client = new AmazonAdsClient({ auth: AUTH, fetchImpl: mockFetch({}).fetchImpl });
    const err = await client.createStvCampaign().catch((e: unknown) => e);
    assert.ok(err instanceof AmazonAdsError && err.code === "STV_NOT_VERIFIED");
  });
});
