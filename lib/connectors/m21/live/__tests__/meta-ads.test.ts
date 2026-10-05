// Phase 4b: Meta Ads adapter live path (versioned Graph Marketing API).
// Run: npx tsx --test lib/connectors/m21/live/__tests__/meta-ads.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { MetaAdsAdapter } from "../../native/meta-ads";
import { classifyMeta } from "../meta-ads";
import { jsonResponse, scriptedFetch, liveDeps, oauthCred, ctxWith, refreshingCtx } from "./fixtures";

const GRAPH = "https://graph.facebook.com/v26.0";

describe("Meta Ads adapter", () => {
  it("mock mode without a credential", async () => {
    const f = scriptedFetch([]);
    const r = await new MetaAdsAdapter(liveDeps(f.fetchImpl).deps).invoke("list_ad_accounts", {}, null, ctxWith());
    assert.equal(r.mock, true);
    assert.equal(f.calls.length, 0);
  });

  it("account_insights: versioned URL, bearer, appsecret_proof, CTR as a fraction, leads", async () => {
    const f = scriptedFetch([
      jsonResponse(200, {
        data: [{ spend: "250.50", impressions: "10000", clicks: "300", ctr: "3.0", cpc: "0.835", actions: [{ action_type: "link_click", value: "280" }, { action_type: "lead", value: "10" }] }],
      }),
    ]);
    const cred = oauthCred("meta-tok", { client_secret: "app-secret" });
    const r = await new MetaAdsAdapter(liveDeps(f.fetchImpl).deps).invoke(
      "account_insights",
      { adAccountId: "123456", datePreset: "last_7d" },
      cred,
      ctxWith(),
    );
    assert.equal(r.ok, true, r.error);
    const call = f.calls[0];
    assert.equal(call.url.origin + call.url.pathname, `${GRAPH}/act_123456/insights`);
    assert.equal(call.headers.authorization, "Bearer meta-tok");
    assert.equal(call.url.searchParams.get("date_preset"), "last_7d");
    assert.equal(call.url.searchParams.get("level"), "account");
    assert.equal(call.url.searchParams.get("fields"), "spend,impressions,clicks,ctr,cpc,actions");
    assert.equal(
      call.url.searchParams.get("appsecret_proof"),
      createHmac("sha256", "app-secret").update("meta-tok").digest("hex"),
    );
    assert.equal(call.url.searchParams.has("access_token"), false);
    assert.deepEqual(r.data, {
      adAccountId: "act_123456",
      datePreset: "last_7d",
      spend: 250.5,
      impressions: 10000,
      clicks: 300,
      ctr: 0.03,
      cpc: 0.835,
      leads: 10,
      costPerLead: 25.05,
    });
  });

  it("list_campaigns follows paging cursors", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { data: [{ id: "1", name: "A", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_LEADS" }], paging: { cursors: { after: "c1" }, next: `${GRAPH}/act_9/campaigns?after=c1` } }),
      jsonResponse(200, { data: [{ id: "2", name: "B", status: "PAUSED" }], paging: { cursors: { after: "c2" } } }),
    ]);
    const r = await new MetaAdsAdapter(liveDeps(f.fetchImpl).deps).invoke("list_campaigns", {}, oauthCred(), ctxWith({ projectConfig: { adAccountId: "act_9" } }));
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls[0].url.searchParams.get("limit"), "100");
    assert.equal(f.calls[1].url.searchParams.get("after"), "c1");
    const data = r.data as { adAccountId: string; campaigns: Array<{ id: string }> };
    assert.equal(data.adAccountId, "act_9");
    assert.deepEqual(data.campaigns.map((c) => c.id), ["1", "2"]);
  });

  it("throttling codes back off and retry (HTTP 400 with code 17)", async () => {
    const f = scriptedFetch([
      jsonResponse(400, { error: { message: "User request limit reached", code: 17 } }),
      jsonResponse(200, { data: [{ spend: "1", impressions: "1", clicks: "0", ctr: "0" }] }),
    ]);
    const { deps, sleeps } = liveDeps(f.fetchImpl);
    const r = await new MetaAdsAdapter(deps).invoke("campaign_insights", { campaignId: "777" }, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.equal(sleeps.length, 1);
    assert.equal(f.calls[1].url.pathname, "/v26.0/777/insights");
  });

  it("error 190 asks the vault refresher once and recomputes the proof", async () => {
    const f = scriptedFetch([
      jsonResponse(400, { error: { message: "Error validating access token", type: "OAuthException", code: 190 } }),
      jsonResponse(200, { id: "me" }),
    ]);
    const ctx = refreshingCtx();
    const r = await new MetaAdsAdapter(liveDeps(f.fetchImpl).deps).healthCheck(oauthCred("tok-1", { client_secret: "s" }), ctx);
    assert.equal(r.ok, true, r.error);
    assert.equal(ctx.refreshCalls(), 1);
    assert.equal(f.calls[1].headers.authorization, "Bearer tok-2");
    assert.equal(f.calls[1].url.searchParams.get("appsecret_proof"), createHmac("sha256", "s").update("tok-2").digest("hex"));
  });

  it("error 190 without a refresh path is auth_rejected", async () => {
    const f = scriptedFetch([jsonResponse(400, { error: { message: "Session has expired", code: 190, error_subcode: 463 } })]);
    const ctx = ctxWith({ refreshCredential: async () => null });
    const r = await new MetaAdsAdapter(liveDeps(f.fetchImpl).deps).invoke("list_ad_accounts", {}, oauthCred(), ctx);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "auth_rejected");
  });

  it("permission + bad input mapping; validation before any call", async () => {
    assert.equal(classifyMeta(403, { error: { code: 200, message: "Permissions error" } }).code, "forbidden");
    assert.equal(classifyMeta(400, { error: { code: 100, error_subcode: 33 } }).code, "not_found");
    assert.equal(classifyMeta(500, { error: { code: 2, is_transient: true } }).retryable, true);
    const f = scriptedFetch([]);
    const a = new MetaAdsAdapter(liveDeps(f.fetchImpl).deps);
    assert.equal((await a.invoke("account_insights", { adAccountId: "act_x" }, oauthCred(), ctxWith())).errorCode, "bad_request");
    assert.equal((await a.invoke("account_insights", { adAccountId: "act_1", datePreset: "forever" }, oauthCred(), ctxWith())).errorCode, "bad_request");
    assert.equal(f.calls.length, 0);
  });
});
