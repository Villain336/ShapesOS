// Phase 4b: Search Console adapter live path (sites list + searchAnalytics.query).
// Run: npx tsx --test lib/connectors/m21/live/__tests__/search-console.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GoogleSearchConsoleAdapter } from "../../native/google-search-console";
import { jsonResponse, scriptedFetch, liveDeps, oauthCred, ctxWith, refreshingCtx } from "./fixtures";

const ARGS = { property: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-30" };

describe("Search Console adapter", () => {
  it("mock mode without a credential", async () => {
    const f = scriptedFetch([]);
    const r = await new GoogleSearchConsoleAdapter(liveDeps(f.fetchImpl).deps).invoke("list_sites", {}, null, ctxWith());
    assert.equal(r.mock, true);
    assert.equal(f.calls.length, 0);
  });

  it("list_sites → GET /webmasters/v3/sites", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] }),
    ]);
    const r = await new GoogleSearchConsoleAdapter(liveDeps(f.fetchImpl).deps).invoke("list_sites", {}, oauthCred("g"), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls[0].url.href, "https://www.googleapis.com/webmasters/v3/sites");
    assert.equal(f.calls[0].headers.authorization, "Bearer g");
    assert.deepEqual(r.data, [{ property: "sc-domain:example.com", permissionLevel: "siteOwner" }]);
  });

  it("query_performance posts the documented body with the property URL-encoded", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { rows: [{ keys: ["dentist"], clicks: 10, impressions: 100, ctr: 0.1, position: 3.14159 }] }),
    ]);
    const r = await new GoogleSearchConsoleAdapter(liveDeps(f.fetchImpl).deps).invoke(
      "query_performance",
      { ...ARGS, limit: 10 },
      oauthCred(),
      ctxWith(),
    );
    assert.equal(r.ok, true, r.error);
    const call = f.calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.url.pathname, "/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
    assert.deepEqual(call.body, {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      dimensions: ["query"],
      rowLimit: 10,
      startRow: 0,
      dataState: "final",
    });
    assert.deepEqual((r.data as { rows: unknown[] }).rows, [{ query: "dentist", clicks: 10, impressions: 100, ctr: 0.1, position: 3.1 }]);
  });

  it("page_performance paginates by startRow past 25,000 rows", async () => {
    const page1 = Array.from({ length: 25_000 }, (_, i) => ({ keys: [`https://x.test/${i}`], clicks: 1, impressions: 2, ctr: 0.5, position: 1 }));
    const f = scriptedFetch([
      jsonResponse(200, { rows: page1 }),
      jsonResponse(200, { rows: [{ keys: ["https://x.test/last"], clicks: 1, impressions: 1, ctr: 1, position: 1 }] }),
    ]);
    const r = await new GoogleSearchConsoleAdapter(liveDeps(f.fetchImpl).deps).invoke(
      "page_performance",
      { ...ARGS, property: "https://x.test/", limit: 25_001 },
      oauthCred(),
      ctxWith(),
    );
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(
      [(f.calls[0].body as { rowLimit: number }).rowLimit, (f.calls[1].body as { startRow: number; rowLimit: number }).startRow],
      [25_000, 25_000],
    );
    assert.equal((f.calls[1].body as { rowLimit: number }).rowLimit, 1);
    assert.equal(f.calls[0].url.pathname, "/webmasters/v3/sites/https%3A%2F%2Fx.test%2F/searchAnalytics/query");
    const rows = (r.data as { rows: Array<{ page: string }> }).rows;
    assert.equal(rows.length, 25_001);
    assert.equal(rows.at(-1)?.page, "https://x.test/last");
  });

  it("uses projectConfig.property, refreshes on 401, and rejects junk properties", async () => {
    const f = scriptedFetch([jsonResponse(401, {}), jsonResponse(200, { rows: [] })]);
    const a = new GoogleSearchConsoleAdapter(liveDeps(f.fetchImpl).deps);
    const ctx = refreshingCtx({ projectConfig: { property: "sc-domain:proj.test" } });
    const r = await a.invoke("query_performance", { startDate: "2026-09-01", endDate: "2026-09-02" }, oauthCred(), ctx);
    assert.equal(r.ok, true, r.error);
    assert.equal(ctx.refreshCalls(), 1);
    assert.match(f.calls[1].url.pathname, /sc-domain%3Aproj\.test/);
    const bad = await a.invoke("query_performance", { ...ARGS, property: "javascript:alert(1)" }, oauthCred(), ctxWith());
    assert.equal(bad.errorCode, "bad_request");
    const badDate = await a.invoke("query_performance", { ...ARGS, startDate: "yesterday" }, oauthCred(), ctxWith());
    assert.equal(badDate.errorCode, "bad_request");
  });

  it("quota 403 backs off; 404 maps to not_found", async () => {
    const f = scriptedFetch([
      jsonResponse(403, { error: { errors: [{ reason: "quotaExceeded" }], message: "Quota exceeded" } }),
      jsonResponse(404, { error: { message: "Site not found" } }),
    ]);
    const { deps, sleeps } = liveDeps(f.fetchImpl);
    const r = await new GoogleSearchConsoleAdapter(deps).invoke("query_performance", ARGS, oauthCred(), ctxWith());
    assert.equal(sleeps.length, 1);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "not_found");
  });

  it("health check lists sites", async () => {
    const f = scriptedFetch([jsonResponse(200, { siteEntry: [] })]);
    const r = await new GoogleSearchConsoleAdapter(liveDeps(f.fetchImpl).deps).healthCheck(oauthCred(), ctxWith());
    assert.deepEqual(r.data, { reachable: true, sites: 0 });
  });
});
