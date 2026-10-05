// Phase 4b: GA4 adapter live path against recorded Data/Admin API fixtures.
// Run: npx tsx --test lib/connectors/m21/live/__tests__/ga4.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Ga4Adapter } from "../../native/ga4";
import { jsonResponse, scriptedFetch, liveDeps, oauthCred, ctxWith, refreshingCtx } from "./fixtures";

const REPORT_FIXTURE = {
  metricHeaders: [{ name: "sessions" }, { name: "totalUsers" }, { name: "newUsers" }, { name: "engagementRate" }, { name: "keyEvents" }],
  rows: [{ metricValues: [{ value: "1200" }, { value: "900" }, { value: "700" }, { value: "0.61" }, { value: "42" }] }],
  rowCount: 1,
};

describe("GA4 adapter", () => {
  it("stays in labeled mock mode without a credential (no network)", async () => {
    const f = scriptedFetch([]);
    const a = new Ga4Adapter(liveDeps(f.fetchImpl).deps);
    const r = await a.invoke("traffic_report", { propertyId: "1", startDate: "2026-09-01", endDate: "2026-09-30" }, null, ctxWith());
    assert.equal(r.ok, true);
    assert.equal(r.mock, true);
    assert.equal(f.calls.length, 0);
  });

  it("traffic_report → runReport with metrics, bearer token, mapped result", async () => {
    const f = scriptedFetch([jsonResponse(200, REPORT_FIXTURE)]);
    const a = new Ga4Adapter(liveDeps(f.fetchImpl).deps);
    const r = await a.invoke(
      "traffic_report",
      { propertyId: "properties/123456", startDate: "2026-09-01", endDate: "30daysAgo" },
      oauthCred("ga-tok"),
      ctxWith(),
    );
    assert.equal(r.ok, true, r.error);
    assert.equal(r.mock, false);
    const call = f.calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.url.href, "https://analyticsdata.googleapis.com/v1beta/properties/123456:runReport");
    assert.equal(call.headers.authorization, "Bearer ga-tok");
    const body = call.body as { metrics: Array<{ name: string }>; dateRanges: unknown[] };
    assert.deepEqual(body.metrics.map((m) => m.name), ["sessions", "totalUsers", "newUsers", "engagementRate", "keyEvents"]);
    assert.deepEqual(body.dateRanges, [{ startDate: "2026-09-01", endDate: "30daysAgo" }]);
    assert.deepEqual(r.data, {
      propertyId: "123456",
      startDate: "2026-09-01",
      endDate: "30daysAgo",
      sessions: 1200,
      totalUsers: 900,
      newUsers: 700,
      engagementRate: 0.61,
      conversions: 42,
    });
  });

  it("top_pages orders by sessions, limits, and maps dimensions", async () => {
    const f = scriptedFetch([
      jsonResponse(200, {
        rows: [
          { dimensionValues: [{ value: "/" }, { value: "Home" }], metricValues: [{ value: "50" }, { value: "40" }, { value: "0.5" }, { value: "3" }] },
        ],
        rowCount: 9,
      }),
    ]);
    const a = new Ga4Adapter(liveDeps(f.fetchImpl).deps);
    const r = await a.invoke(
      "top_pages",
      { startDate: "2026-09-01", endDate: "2026-09-30", limit: 5 },
      oauthCred(),
      ctxWith({ projectConfig: { propertyId: "777" } }),
    );
    assert.equal(r.ok, true, r.error);
    const body = f.calls[0].body as Record<string, unknown>;
    assert.equal(body.limit, 5);
    assert.deepEqual(body.orderBys, [{ metric: { metricName: "sessions" }, desc: true }]);
    assert.match(f.calls[0].url.pathname, /properties\/777:runReport$/);
    const data = r.data as { totalRows: number; rows: Array<Record<string, unknown>> };
    assert.equal(data.totalRows, 9);
    assert.deepEqual(data.rows[0], { pagePath: "/", pageTitle: "Home", sessions: 50, users: 40, engagementRate: 0.5, conversions: 3 });
  });

  it("list_properties follows nextPageToken", async () => {
    const f = scriptedFetch([
      jsonResponse(200, {
        accountSummaries: [{ account: "accounts/1", displayName: "A", propertySummaries: [{ property: "properties/11", displayName: "P11" }] }],
        nextPageToken: "pg2",
      }),
      jsonResponse(200, {
        accountSummaries: [{ account: "accounts/2", displayName: "B", propertySummaries: [{ property: "properties/22", displayName: "P22" }] }],
      }),
    ]);
    const a = new Ga4Adapter(liveDeps(f.fetchImpl).deps);
    const r = await a.invoke("list_properties", {}, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls[1].url.searchParams.get("pageToken"), "pg2");
    assert.deepEqual(
      (r.data as { properties: Array<{ propertyId: string }> }).properties.map((p) => p.propertyId),
      ["11", "22"],
    );
  });

  it("refreshes on 401 through the vault refresher", async () => {
    const f = scriptedFetch([jsonResponse(401, { error: { code: 401, status: "UNAUTHENTICATED" } }), jsonResponse(200, REPORT_FIXTURE)]);
    const a = new Ga4Adapter(liveDeps(f.fetchImpl).deps);
    const ctx = refreshingCtx();
    const r = await a.invoke("traffic_report", { propertyId: "1", startDate: "2026-09-01", endDate: "2026-09-02" }, oauthCred("tok-1"), ctx);
    assert.equal(r.ok, true, r.error);
    assert.equal(ctx.refreshCalls(), 1);
    assert.equal(f.calls[1].headers.authorization, "Bearer tok-2");
  });

  it("backs off on 429 RESOURCE_EXHAUSTED and retries", async () => {
    const f = scriptedFetch([jsonResponse(429, { error: { status: "RESOURCE_EXHAUSTED" } }), jsonResponse(200, REPORT_FIXTURE)]);
    const { deps, sleeps } = liveDeps(f.fetchImpl);
    const r = await new Ga4Adapter(deps).invoke("traffic_report", { propertyId: "1", startDate: "2026-09-01", endDate: "2026-09-02" }, oauthCred(), ctxWith());
    assert.equal(r.ok, true);
    assert.equal(sleeps.length, 1);
  });

  it("maps a permission error to forbidden and validates input before any call", async () => {
    const f = scriptedFetch([jsonResponse(403, { error: { code: 403, message: "User does not have sufficient permissions", status: "PERMISSION_DENIED" } })]);
    const a = new Ga4Adapter(liveDeps(f.fetchImpl).deps);
    const denied = await a.invoke("traffic_report", { propertyId: "1", startDate: "2026-09-01", endDate: "2026-09-02" }, oauthCred(), ctxWith());
    assert.equal(denied.ok, false);
    assert.equal(denied.errorCode, "forbidden");
    assert.match(denied.error ?? "", /sufficient permissions/);
    const bad = await a.invoke("traffic_report", { propertyId: "abc", startDate: "2026-09-01", endDate: "2026-09-02" }, oauthCred(), ctxWith());
    assert.equal(bad.errorCode, "bad_request");
    assert.equal(f.calls.length, 1);
  });

  it("health check calls accountSummaries with pageSize=1", async () => {
    const f = scriptedFetch([jsonResponse(200, { accountSummaries: [] })]);
    const r = await new Ga4Adapter(liveDeps(f.fetchImpl).deps).healthCheck(oauthCred(), ctxWith());
    assert.equal(r.ok, true);
    assert.equal(f.calls[0].url.href, "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=1");
  });
});
