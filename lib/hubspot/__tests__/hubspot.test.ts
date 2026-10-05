// Phase 11 (conncore): HubSpot — the documented conflict rule, field
// mapping, stage mirroring, and the adapter's request shapes (fetch
// scripted; no network, no database).
// Run: npx tsx --test lib/hubspot/__tests__/hubspot.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  companyFromHubspot,
  contactFromHubspot,
  contactToHubspot,
  dealFromHubspot,
  decidePull,
  localStageId,
  mirrorStages,
  pushAllowed,
} from "../sync";
import { HubspotAdapter } from "@/lib/connectors/m21/native/hubspot";
import { OAUTH_CONFIGS, startOAuthFlow } from "@/lib/vault/oauth";
import { connectorAction, connectorGroup } from "@/lib/agents/grants";
import { jsonResponse, scriptedFetch, liveDeps, oauthCred, ctxWith } from "@/lib/connectors/m21/live/__tests__/fixtures";

const t = (s: string) => new Date(s);
const obj = (id: string, properties: Record<string, string | null>, updatedAt = "2026-10-01T00:00:00Z") => ({ id, properties, updatedAt, associations: {} });

describe("conflict rule", () => {
  const link = { hubspotUpdatedAt: t("2026-10-01T00:00:00Z"), localUpdatedAt: t("2026-10-01T00:00:01Z") };
  it("only HubSpot changed → apply; only local changed → local_ahead; neither → unchanged", () => {
    assert.equal(decidePull(link, t("2026-10-02T00:00:00Z"), t("2026-10-01T00:00:01Z")), "apply");
    assert.equal(decidePull(link, t("2026-10-01T00:00:00Z"), t("2026-10-03T00:00:00Z")), "local_ahead");
    assert.equal(decidePull(link, t("2026-10-01T00:00:00Z"), t("2026-10-01T00:00:01Z")), "skip_unchanged");
  });
  it("both changed → last writer wins by timestamp; a first match counts as both changed", () => {
    assert.equal(decidePull(link, t("2026-10-05T00:00:00Z"), t("2026-10-04T00:00:00Z")), "conflict_hubspot_wins");
    assert.equal(decidePull(link, t("2026-10-04T00:00:00Z"), t("2026-10-05T00:00:00Z")), "conflict_local_wins");
    assert.equal(decidePull(null, t("2026-10-05T00:00:00Z"), t("2026-10-04T00:00:00Z")), "conflict_hubspot_wins");
  });
  it("push: refused only when HubSpot changed since the last sync AND is newer than local (unless force)", () => {
    assert.equal(pushAllowed(null, null, t("2026-10-01T00:00:00Z"), false), true);
    assert.equal(pushAllowed(link, t("2026-10-01T00:00:00Z"), t("2026-10-02T00:00:00Z"), false), true);
    assert.equal(pushAllowed(link, t("2026-10-05T00:00:00Z"), t("2026-10-04T00:00:00Z"), false), false);
    assert.equal(pushAllowed(link, t("2026-10-05T00:00:00Z"), t("2026-10-04T00:00:00Z"), true), true);
    assert.equal(pushAllowed(link, t("2026-10-04T00:00:00Z"), t("2026-10-05T00:00:00Z"), false), true);
  });
});

describe("field mapping", () => {
  it("contacts: name from first/last, normalized email; push splits the name and drops empties", () => {
    assert.deepEqual(contactFromHubspot(obj("1", { firstname: "Ada", lastname: "Lovelace", email: " ADA@Example.com ", phone: null, jobtitle: "CTO" })), {
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: null,
      title: "CTO",
    });
    assert.equal(contactFromHubspot(obj("2", {})).name, "HubSpot contact 2");
    assert.deepEqual(contactToHubspot({ name: "Ada King Lovelace", email: "ada@example.com", phone: null, title: "" }), {
      email: "ada@example.com",
      firstname: "Ada",
      lastname: "King Lovelace",
    });
  });
  it("companies dedupe on the normalized domain (website as fallback)", () => {
    assert.equal(companyFromHubspot(obj("3", { name: "Acme", website: "https://www.acme.com/about" })).domain, "acme.com");
  });
  it("deals: amount → cents, closed won/lost → won/lost stages, others hs-<id>", () => {
    const d = dealFromHubspot(obj("4", { dealname: "Big one", amount: "1234.5", dealstage: "appointmentscheduled", pipeline: "default", closedate: "2026-11-01T00:00:00Z" }));
    assert.equal(d.valueCents, 123450);
    assert.equal(d.hubspotStage, "appointmentscheduled");
    assert.equal(localStageId({ id: "closedwon", isClosed: true, probability: 1 }), "won");
    assert.equal(localStageId({ id: "closedlost", isClosed: true, probability: 0 }), "lost");
    assert.equal(localStageId({ id: "qualified to buy", isClosed: false, probability: 0.4 }), "hs-qualified_to_buy");
    const stages = mirrorStages({ id: "default", label: "Sales", stages: [
      { id: "a", label: "A", displayOrder: 0, isClosed: false, probability: 0.2 },
      { id: "closedwon", label: "Won", displayOrder: 1, isClosed: true, probability: 1 },
    ] });
    assert.deepEqual(stages, [{ id: "hs-a", label: "A", hubspotStageId: "a" }, { id: "won", label: "Won", hubspotStageId: "closedwon" }]);
  });
});

describe("HubSpot adapter", () => {
  it("list_records: GET /crm/v3/objects/{type} with the synced properties and associations", async () => {
    const f = scriptedFetch([jsonResponse(200, { results: [{ id: "51", properties: { email: "a@x.com" }, updatedAt: "2026-10-01T00:00:00Z", associations: { companies: { results: [{ id: "9", type: "contact_to_company" }] } } }] })]);
    const r = await new HubspotAdapter(liveDeps(f.fetchImpl).deps).invoke("list_records", { objectType: "contact", limit: 5 }, oauthCred("hs-tok"), ctxWith());
    assert.equal(r.ok, true, r.error);
    const c = f.calls[0];
    assert.equal(c.url.origin + c.url.pathname, "https://api.hubapi.com/crm/v3/objects/contacts");
    assert.equal(c.url.searchParams.get("limit"), "5");
    assert.equal(c.url.searchParams.get("associations"), "companies");
    assert.match(c.url.searchParams.get("properties") ?? "", /^email,firstname,lastname/);
    assert.equal(c.headers.authorization, "Bearer hs-tok");
    assert.deepEqual((r.data as Array<{ associations: unknown }>)[0].associations, { companies: ["9"] });
  });

  it("bad objectType is a bad_request; mock mode writes nothing", async () => {
    const f = scriptedFetch([]);
    const a = new HubspotAdapter(liveDeps(f.fetchImpl).deps);
    assert.equal((await a.invoke("list_records", { objectType: "ticket" }, oauthCred(), ctxWith())).errorCode, "bad_request");
    const m = await a.invoke("push_to_hubspot", { objectType: "contact", localId: "x" }, null, ctxWith());
    assert.equal(m.mock, true);
    assert.equal(f.calls.length, 0);
  });

  it("tools, grants and OAuth", () => {
    const tools = new HubspotAdapter().listTools();
    assert.deepEqual(tools.filter((x) => x.mutating).map((x) => x.name), ["sync_from_hubspot", "push_to_hubspot"]);
    assert.equal(connectorGroup("hubspot"), "ops");
    assert.equal(connectorAction("hubspot", "sync_from_hubspot"), "write_crm_record");
    assert.equal(connectorAction("hubspot", "push_to_hubspot"), "write_hubspot");
    process.env.HUBSPOT_CLIENT_ID = "hs-client";
    process.env.MARKETR_CREDENTIALS_KEY ||= "0".repeat(64);
    try {
      const u = new URL(startOAuthFlow("u1", "ws1", "hubspot", "https://app.example.com").url);
      assert.equal(u.origin + u.pathname, "https://app.hubspot.com/oauth/authorize");
      assert.match(u.searchParams.get("scope") ?? "", /crm\.objects\.deals\.write/);
    } finally {
      delete process.env.HUBSPOT_CLIENT_ID;
    }
    assert.equal(OAUTH_CONFIGS.hubspot.tokenUrl, "https://api.hubapi.com/oauth/v1/token");
  });
});
