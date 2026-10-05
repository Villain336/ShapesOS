// Phase 4b: live outreach sending partners (Smartlead / Instantly relay
// campaigns) against recorded API fixtures. No network, no real keys.
// Run: npx tsx --test lib/authority/outreach/__tests__/sending.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveSendingPartner, NotConfiguredError, type SendRequest } from "@/lib/authority/fake";
import { SendRejectedError, parseRelayCampaignIds, idempotencyKeyFor } from "../sending";
import { jsonResponse, scriptedFetch, liveDeps } from "@/lib/connectors/m21/live/__tests__/fixtures";

const REQ: SendRequest = {
  to: "pat@example.com",
  subject: "Quick question",
  body: "Hi Pat",
  fromMailbox: "outreach@acme.test",
  campaignId: "camp_1",
  sequenceId: "seq_1",
  unsubscribeUrl: "https://app.test/u/abc",
  physicalAddress: "1 Main St",
  stepIndex: 0,
  idempotencyKey: "shapes:seq_1:0",
  workspaceId: "ws_1",
};

describe("resolveSendingPartner", () => {
  it("fake without a key; NotConfiguredError with a key but no relay campaigns", () => {
    assert.equal(resolveSendingPartner({ apiKey: null }).name, "fake");
    assert.throws(
      () => resolveSendingPartner({ provider: "smartlead", apiKey: "k", fake: false }),
      (e: unknown) => e instanceof NotConfiguredError && /SMARTLEAD_RELAY_CAMPAIGN_IDS/.test(e.message),
    );
    assert.throws(
      () => resolveSendingPartner({ provider: "instantly", apiKey: "k", relayCampaignIds: " , " }),
      /INSTANTLY_RELAY_CAMPAIGN_IDS/,
    );
  });

  it("parses relay ids and builds a stable idempotency key", () => {
    assert.deepEqual(parseRelayCampaignIds("101, 102 ,bad id,103"), ["101", "102", "103"]);
    assert.equal(idempotencyKeyFor({ sequenceId: "s", stepIndex: 2 }), "shapes:s:2");
  });
});

describe("Smartlead live partner", () => {
  it("adds the lead to the step's relay campaign with merge fields + idempotency key", async () => {
    const f = scriptedFetch([jsonResponse(200, { ok: true, upload_count: 1, total_leads: 1 })]);
    const partner = resolveSendingPartner({ provider: "smartlead", apiKey: "sl-key", relayCampaignIds: "101,102,103", deps: liveDeps(f.fetchImpl).deps });
    assert.equal(partner.name, "smartlead");
    const res = await partner.send({ ...REQ, stepIndex: 1, idempotencyKey: "shapes:seq_1:1" });
    assert.equal(res.accepted, true);
    assert.equal(res.messageId, "smartlead:102:shapes:seq_1:1");
    const c = f.calls[0];
    assert.equal(c.method, "POST");
    assert.equal(c.url.origin + c.url.pathname, "https://server.smartlead.ai/api/v1/campaigns/102/leads");
    assert.equal(c.url.searchParams.get("api_key"), "sl-key");
    assert.equal(c.headers.authorization, undefined);
    const body = c.body as { lead_list: Array<{ email: string; custom_fields: Record<string, string> }>; settings: Record<string, boolean> };
    assert.equal(body.lead_list[0].email, "pat@example.com");
    assert.deepEqual(body.lead_list[0].custom_fields, {
      shapes_subject: "Quick question",
      shapes_body: "Hi Pat",
      shapes_unsubscribe_url: "https://app.test/u/abc",
      shapes_physical_address: "1 Main St",
      shapes_from_mailbox: "outreach@acme.test",
      shapes_sequence_id: "seq_1",
      shapes_campaign_id: "camp_1",
      shapes_workspace_id: "ws_1",
      shapes_idempotency_key: "shapes:seq_1:1",
    });
    assert.equal(body.settings.ignore_unsubscribe_list, false);
    assert.equal(body.settings.ignore_global_block_list, false);
  });

  it("a duplicate (retried) send is accepted with the same message id", async () => {
    const f = scriptedFetch([jsonResponse(200, { ok: true, upload_count: 0, already_added_to_campaign: 1 })]);
    const partner = resolveSendingPartner({ provider: "smartlead", apiKey: "k", relayCampaignIds: "101", deps: liveDeps(f.fetchImpl).deps });
    const res = await partner.send(REQ);
    assert.deepEqual([res.accepted, res.messageId], [true, "smartlead:101:shapes:seq_1:0"]);
  });

  it("block-listed / unsubscribed leads are rejected, not reported as sent", async () => {
    const f = scriptedFetch([jsonResponse(200, { ok: true, upload_count: 0, block_list: 1 })]);
    const partner = resolveSendingPartner({ provider: "smartlead", apiKey: "k", relayCampaignIds: "101", deps: liveDeps(f.fetchImpl).deps });
    await assert.rejects(partner.send(REQ), (e: unknown) => e instanceof SendRejectedError && /block list/.test(e.message));
  });

  it("no relay campaign for a follow-up step fails closed before any request", async () => {
    const f = scriptedFetch([]);
    const partner = resolveSendingPartner({ provider: "smartlead", apiKey: "k", relayCampaignIds: "101", deps: liveDeps(f.fetchImpl).deps });
    await assert.rejects(partner.send({ ...REQ, stepIndex: 2 }), /no relay campaign for step 2/);
    assert.equal(f.calls.length, 0);
  });

  it("429 backs off and retries; 401 is auth_rejected without leaking the key", async () => {
    const f = scriptedFetch([jsonResponse(429, { message: "Rate limit" }, { "retry-after": "2" }), jsonResponse(200, { upload_count: 1 }), jsonResponse(401, { message: "Invalid api_key=sl-key" })]);
    const { deps, sleeps } = liveDeps(f.fetchImpl);
    const partner = resolveSendingPartner({ provider: "smartlead", apiKey: "sl-key", relayCampaignIds: "101", deps });
    assert.equal((await partner.send(REQ)).accepted, true);
    assert.deepEqual(sleeps, [2000]);
    await assert.rejects(partner.send(REQ), (e: unknown) => {
      const err = e as { code?: string; message: string };
      return err.code === "auth_rejected" && !err.message.includes("sl-key");
    });
  });
});

describe("Instantly live partner", () => {
  it("creates the lead in the relay campaign with Bearer auth + skip_if_in_campaign", async () => {
    const f = scriptedFetch([jsonResponse(200, { id: "lead-uuid", status: 1, campaign: "c-0" })]);
    const partner = resolveSendingPartner({ provider: "instantly", apiKey: "in-key", relayCampaignIds: "c-0,c-1", deps: liveDeps(f.fetchImpl).deps });
    const res = await partner.send(REQ);
    assert.deepEqual([res.accepted, res.messageId], [true, "instantly:lead-uuid"]);
    const c = f.calls[0];
    assert.equal(c.url.href, "https://api.instantly.ai/api/v2/leads");
    assert.equal(c.headers.authorization, "Bearer in-key");
    const body = c.body as Record<string, unknown>;
    assert.equal(body.campaign, "c-0");
    assert.equal(body.email, "pat@example.com");
    assert.equal(body.skip_if_in_campaign, true);
    assert.equal((body.custom_variables as Record<string, string>).shapes_idempotency_key, "shapes:seq_1:0");
  });

  it("a skipped duplicate keeps the idempotent message id; bounced/unsubscribed leads are rejected", async () => {
    const f = scriptedFetch([jsonResponse(200, {}), jsonResponse(200, { id: "x", status: -2 })]);
    const partner = resolveSendingPartner({ provider: "instantly", apiKey: "k", relayCampaignIds: "c-0", deps: liveDeps(f.fetchImpl).deps });
    assert.equal((await partner.send(REQ)).messageId, "instantly:c-0:shapes:seq_1:0");
    await assert.rejects(partner.send(REQ), /unsubscribed/);
  });

  it("402 (no paid plan) maps to forbidden", async () => {
    const f = scriptedFetch([jsonResponse(402, { message: "Workspace lacks an active paid plan" })]);
    const partner = resolveSendingPartner({ provider: "instantly", apiKey: "k", relayCampaignIds: "c-0", deps: liveDeps(f.fetchImpl).deps });
    await assert.rejects(partner.send(REQ), (e: unknown) => (e as { code?: string }).code === "forbidden");
  });
});
