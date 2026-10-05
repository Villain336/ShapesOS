// Phase 4b/6: Google Ads adapter live path (REST GAQL searchStream).
// Run: npx tsx --test lib/connectors/m21/live/__tests__/google-ads.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { GoogleAdsAdapter } from "../../native/google-ads";
import { gaqlDateClause } from "../google-ads";
import { jsonResponse, scriptedFetch, liveDeps, oauthCred, ctxWith, refreshingCtx } from "./fixtures";

const BASE = "https://googleads.googleapis.com/v25";
let savedToken: string | undefined;

describe("Google Ads adapter", () => {
  before(() => {
    savedToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "dev-token-test";
  });
  after(() => {
    if (savedToken === undefined) delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    else process.env.GOOGLE_ADS_DEVELOPER_TOKEN = savedToken;
  });

  it("mock mode without a credential", async () => {
    const f = scriptedFetch([]);
    const r = await new GoogleAdsAdapter(liveDeps(f.fetchImpl).deps).invoke("list_accounts", {}, null, ctxWith());
    assert.equal(r.mock, true);
    assert.equal(f.calls.length, 0);
  });

  it("campaign_report: GAQL searchStream with developer-token + login-customer-id, batches flattened", async () => {
    const f = scriptedFetch([
      jsonResponse(200, [
        {
          results: [
            { campaign: { id: "11", name: "Brand", status: "ENABLED" }, metrics: { impressions: "1000", clicks: "50", costMicros: "12345678", conversions: 4, ctr: 0.05, averageCpc: "246913" } },
          ],
          fieldMask: "campaign.id,campaign.name",
          requestId: "r1",
        },
        {
          results: [{ campaign: { id: "12", name: "Generic", status: "PAUSED" }, metrics: { impressions: "10", clicks: "1", costMicros: "1000000", conversions: 0 } }],
          requestId: "r1",
        },
      ]),
    ]);
    const r = await new GoogleAdsAdapter(liveDeps(f.fetchImpl).deps).invoke(
      "campaign_report",
      { customerId: "123-456-7890", dateRange: "last_7_days" },
      oauthCred("ads-tok"),
      ctxWith({ projectConfig: { loginCustomerId: "999-888-7777" } }),
    );
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls.length, 1, "one streamed request, no paging");
    const [c1] = f.calls;
    assert.equal(c1.method, "POST");
    assert.equal(c1.url.href, `${BASE}/customers/1234567890/googleAds:searchStream`);
    assert.equal(c1.headers.authorization, "Bearer ads-tok");
    assert.equal(c1.headers["developer-token"], "dev-token-test");
    assert.equal(c1.headers["login-customer-id"], "9998887777");
    const q = (c1.body as { query: string }).query;
    assert.match(q, /FROM campaign WHERE segments\.date DURING LAST_7_DAYS/);
    assert.match(q, /metrics\.cost_micros/);
    assert.match(q, /ORDER BY metrics\.cost_micros DESC LIMIT 2000$/, "the stream is bounded by a GAQL LIMIT");
    assert.deepEqual(Object.keys(c1.body as object), ["query"]);
    const data = r.data as { campaigns: Array<Record<string, unknown>> };
    assert.deepEqual(data.campaigns[0], { id: "11", name: "Brand", status: "ENABLED", impressions: 1000, clicks: 50, cost: 12.35, conversions: 4, ctr: 0.05, avgCpc: 0.25 });
    assert.equal(data.campaigns.length, 2);
  });

  it("an error element inside the stream fails closed with a scrubbed message", async () => {
    const f = scriptedFetch([
      jsonResponse(200, [
        { results: [{ campaign: { id: "11" } }] },
        { error: { code: 429, message: "quota for ads-tok", details: [{ errors: [{ errorCode: { quotaError: "RESOURCE_EXHAUSTED" }, message: "Too many requests for dev-token-test" }] }] } },
      ]),
    ]);
    const r = await new GoogleAdsAdapter(liveDeps(f.fetchImpl).deps).invoke("campaign_report", { customerId: "1234567890" }, oauthCred("ads-tok"), ctxWith());
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "rate_limited");
    assert.ok(!(r.error ?? "").includes("dev-token-test"), r.error);
    assert.ok(!(r.error ?? "").includes("ads-tok"), r.error);
  });

  it("keyword_report filters by a numeric campaign id only", async () => {
    const f = scriptedFetch([
      jsonResponse(200, [{ results: [{ adGroupCriterion: { keyword: { text: "dentist", matchType: "EXACT" } }, metrics: { impressions: "5", clicks: "1", costMicros: "500000", conversions: 1 } }] }]),
    ]);
    const a = new GoogleAdsAdapter(liveDeps(f.fetchImpl).deps);
    const r = await a.invoke("keyword_report", { customerId: "1234567890", campaignId: "42", dateRange: "2026-09-01..2026-09-30" }, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    const q = (f.calls[0].body as { query: string }).query;
    assert.match(q, /FROM keyword_view WHERE campaign\.id = 42 AND segments\.date BETWEEN '2026-09-01' AND '2026-09-30'/);
    assert.match(q, / LIMIT 500$/);
    assert.doesNotMatch(q, /LIMIT \d+ LIMIT/, "an existing LIMIT is not doubled");
    assert.deepEqual((r.data as { keywords: unknown[] }).keywords[0], { keyword: "dentist", matchType: "EXACT", impressions: 5, clicks: 1, cost: 0.5, conversions: 1 });
    const inj = await a.invoke("keyword_report", { customerId: "1234567890", campaignId: "1 OR 1=1" }, oauthCred(), ctxWith());
    assert.equal(inj.errorCode, "bad_request");
    assert.equal(f.calls.length, 1);
  });

  it("list_accounts: listAccessibleCustomers then descriptive names", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { resourceNames: ["customers/1111111111", "customers/2222222222"] }),
      jsonResponse(200, [{ results: [{ customer: { descriptiveName: "Acme", currencyCode: "USD", manager: false } }] }]),
      jsonResponse(403, { error: { message: "USER_PERMISSION_DENIED", details: [{ errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" }, message: "needs login-customer-id" }] }] } }),
    ]);
    const r = await new GoogleAdsAdapter(liveDeps(f.fetchImpl).deps).invoke("list_accounts", {}, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls[0].method, "GET");
    assert.equal(f.calls[0].url.href, `${BASE}/customers:listAccessibleCustomers`);
    assert.equal(f.calls[0].headers["developer-token"], "dev-token-test");
    assert.deepEqual(r.data, [
      { id: "1111111111", name: "Acme", currency: "USD", manager: false },
      { id: "2222222222", name: null, currency: null, manager: null },
    ]);
  });

  it("quotaError backs off and retries; refresh-on-401 swaps the token", async () => {
    const quota = { error: { code: 429, details: [{ errors: [{ errorCode: { quotaError: "RESOURCE_TEMPORARILY_EXHAUSTED" }, message: "Too many requests" }] }] } };
    const f = scriptedFetch([jsonResponse(429, quota), jsonResponse(401, {}), jsonResponse(200, [])]);
    const { deps, sleeps } = liveDeps(f.fetchImpl);
    const ctx = refreshingCtx();
    const r = await new GoogleAdsAdapter(deps).invoke("campaign_report", { customerId: "1234567890" }, oauthCred(), ctx);
    assert.equal(r.ok, true, r.error);
    assert.equal(sleeps.length, 1);
    assert.equal(ctx.refreshCalls(), 1);
    assert.equal(f.calls[2].headers.authorization, "Bearer tok-2");
  });

  it("surfaces the nested Google Ads error message on a hard failure", async () => {
    const f = scriptedFetch([
      jsonResponse(400, { error: { code: 400, message: "Request contains an invalid argument.", details: [{ errors: [{ errorCode: { queryError: "BAD_FIELD_NAME" }, message: "Unrecognized field" }] }] } }),
    ]);
    const r = await new GoogleAdsAdapter(liveDeps(f.fetchImpl).deps).invoke("campaign_report", { customerId: "1234567890" }, oauthCred(), ctxWith());
    assert.equal(r.errorCode, "bad_request");
    assert.match(r.error ?? "", /Unrecognized field/);
  });

  it("without a developer token: config_missing, no request", async () => {
    delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    try {
      const f = scriptedFetch([]);
      const r = await new GoogleAdsAdapter(liveDeps(f.fetchImpl).deps).invoke("campaign_report", { customerId: "1234567890" }, oauthCred(), ctxWith());
      assert.equal(r.errorCode, "config_missing");
      assert.equal(f.calls.length, 0);
      // A BYO developer token in the credential payload is honoured.
      const f2 = scriptedFetch([jsonResponse(200, { resourceNames: [] })]);
      const h = await new GoogleAdsAdapter(liveDeps(f2.fetchImpl).deps).healthCheck(oauthCred("t", { developerToken: "byo" }), ctxWith());
      assert.equal(h.ok, true);
      assert.equal(f2.calls[0].headers["developer-token"], "byo");
    } finally {
      process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "dev-token-test";
    }
  });

  it("gaqlDateClause only emits enum literals or ISO ranges", () => {
    assert.equal(gaqlDateClause(undefined), "segments.date DURING LAST_30_DAYS");
    assert.throws(() => gaqlDateClause("LAST_30_DAYS; DROP"));
    assert.throws(() => gaqlDateClause("2026-01-01..' OR 1=1"));
  });
});
