// Phase 11 (devtools): Airtable adapter — Web API request shapes, offset
// pagination, the 5 req/s per-base pacing, 429 backoff on reads only (never
// on writes), record validation, the PKCE OAuth entry and the grant mapping.
// fetch is scripted against Airtable's documented responses (no network).
// Run: npx tsx --test lib/connectors/m21/live/__tests__/airtable.test.ts

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { AirtableAdapter } from "../../native/airtable";
import { AIRTABLE_BASE_SPACING_MS, resetAirtablePacing } from "../airtable";
import { OAUTH_CONFIGS } from "@/lib/vault/oauth";
import { connectorAction, connectorGroup } from "@/lib/agents/grants";
import { jsonResponse, scriptedFetch, liveDeps, oauthCred, ctxWith, refreshingCtx } from "./fixtures";

const BASE = "appABCDEFGHIJ1234";
const REC1 = "recAAAAAAAAAAAAA1";
const REC2 = "recAAAAAAAAAAAAA2";

beforeEach(() => resetAirtablePacing());

/** Adapter with a frozen clock so pacing is deterministic (sleeps are recorded, not waited). */
function adapter(script: Parameters<typeof scriptedFetch>[0], now = () => 1_000_000) {
  const f = scriptedFetch(script);
  const { deps, sleeps } = liveDeps(f.fetchImpl);
  return { a: new AirtableAdapter({ ...deps, now }), f, sleeps };
}

const rec = (id: string, fields: Record<string, unknown>) => ({ id, createdTime: "2026-10-01T00:00:00.000Z", fields });

describe("Airtable reads", () => {
  it("list_bases: GET /v0/meta/bases with the bearer token, follows offset", async () => {
    const { a, f } = adapter([
      jsonResponse(200, { bases: [{ id: BASE, name: "Content", permissionLevel: "create" }], offset: "itr1" }),
      jsonResponse(200, { bases: [{ id: "appZZZZZZZZZZZZZZ", name: "CRM", permissionLevel: "read" }] }),
    ]);
    const r = await a.invoke("list_bases", {}, oauthCred("air-tok"), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.deepEqual((r.data as Array<{ name: string }>).map((b) => b.name), ["Content", "CRM"]);
    assert.equal(f.calls[0].url.href, "https://api.airtable.com/v0/meta/bases");
    assert.equal(f.calls[0].headers.authorization, "Bearer air-tok");
    assert.equal(f.calls[1].url.searchParams.get("offset"), "itr1");
  });

  it("list_tables: base schema with fields", async () => {
    const { a, f } = adapter([
      jsonResponse(200, { tables: [{ id: "tblX", name: "Posts", primaryFieldId: "fld1", fields: [{ id: "fld1", name: "Name", type: "singleLineText" }], views: [] }] }),
    ]);
    const r = await a.invoke("list_tables", { baseId: BASE }, oauthCred(), ctxWith());
    assert.deepEqual(r.data, [{ id: "tblX", name: "Posts", primaryFieldId: "fld1", fields: [{ id: "fld1", name: "Name", type: "singleLineText" }] }]);
    assert.equal(f.calls[0].url.pathname, `/v0/meta/bases/${BASE}/tables`);
  });

  it("list_records: table name is URL-encoded; view, formula, pageSize and offset pagination up to the limit", async () => {
    const { a, f } = adapter([
      jsonResponse(200, { records: [rec(REC1, { Name: "A" })], offset: "itr/1" }),
      jsonResponse(200, { records: [rec(REC2, { Name: "B" })], offset: "itr/2" }),
    ]);
    const r = await a.invoke(
      "list_records",
      { baseId: BASE, table: "Content calendar", view: "Grid view", filterByFormula: '{Status} = "Open"', limit: 2 },
      oauthCred(),
      ctxWith(),
    );
    assert.equal(r.ok, true, r.error);
    const data = r.data as { records: Array<{ id: string; fields: Record<string, unknown> }>; nextOffset: string | null };
    assert.deepEqual(data.records.map((x) => x.id), [REC1, REC2]);
    assert.equal(data.nextOffset, "itr/2", "more remain → offset to continue");
    const q = f.calls[0].url;
    assert.equal(q.pathname, `/v0/${BASE}/Content%20calendar`);
    assert.equal(q.searchParams.get("view"), "Grid view");
    assert.equal(q.searchParams.get("filterByFormula"), '{Status} = "Open"');
    assert.equal(q.searchParams.get("pageSize"), "2");
    assert.equal(f.calls[1].url.searchParams.get("pageSize"), "1");
    assert.equal(f.calls[1].url.searchParams.get("offset"), "itr/1");
  });

  it("paces requests to one base at ≥ 200 ms (5 req/s); other bases are not held up", async () => {
    // A clock that advances only when the adapter sleeps (requests are instant).
    let t = 1_000_000;
    const sleeps: number[] = [];
    const f = scriptedFetch([
      jsonResponse(200, { records: [rec(REC1, {})], offset: "o1" }),
      jsonResponse(200, { records: [rec(REC2, {})], offset: "o2" }),
      jsonResponse(200, { records: [rec(REC1, {})] }),
      jsonResponse(200, { records: [] }),
    ]);
    const a = new AirtableAdapter({
      fetchImpl: f.fetchImpl,
      resolve: async () => ["142.250.80.10"],
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      now: () => t,
    });
    await a.invoke("list_records", { baseId: BASE, table: "T", limit: 10 }, oauthCred(), ctxWith());
    assert.deepEqual(sleeps, [AIRTABLE_BASE_SPACING_MS, AIRTABLE_BASE_SPACING_MS], "2nd and 3rd request each waited one slot");
    await a.invoke("list_records", { baseId: "appZZZZZZZZZZZZZZ", table: "T" }, oauthCred(), ctxWith());
    assert.equal(sleeps.length, 2, "a different base has its own budget");
  });

  it("429 on a read backs off (first wait ≥ the configured base) and then succeeds", async () => {
    const { a, f, sleeps } = adapter([jsonResponse(429, { errors: [{ error: "RATE_LIMIT_REACHED" }] }), jsonResponse(200, { records: [] })]);
    const r = await a.invoke("list_records", { baseId: BASE, table: "T" }, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls.length, 2);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] >= 100, `backoff waited ${sleeps[0]}ms`);
  });

  it("the default read backoff honours Airtable's 30-second rule", async () => {
    const f = scriptedFetch([jsonResponse(429, {}), jsonResponse(200, { bases: [] })]);
    const sleeps: number[] = [];
    const a = new AirtableAdapter({ fetchImpl: f.fetchImpl, resolve: async () => ["142.250.80.10"], sleep: async (ms) => void sleeps.push(ms), now: () => 0 });
    await a.invoke("list_bases", {}, oauthCred(), ctxWith());
    assert.ok(sleeps[0] >= 30_000, `waited ${sleeps[0]}ms`);
  });

  it("errors map to closed codes; bad ids are bad_request without a call", async () => {
    const { a, f } = adapter([jsonResponse(403, { error: { type: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", message: "Invalid permissions" } })]);
    const r = await a.invoke("list_tables", { baseId: BASE }, oauthCred(), ctxWith());
    assert.equal(r.errorCode, "forbidden");
    assert.match(r.error ?? "", /Invalid permissions/);
    const bad = await a.invoke("list_records", { baseId: "nope", table: "T" }, oauthCred(), ctxWith());
    assert.equal(bad.errorCode, "bad_request");
    assert.equal(f.calls.length, 1);
  });

  it("a token refreshed on page 1 is reused for page 2", async () => {
    const { a, f } = adapter([
      jsonResponse(401, { error: { type: "AUTHENTICATION_REQUIRED", message: "Authentication required" } }),
      jsonResponse(200, { bases: [{ id: BASE, name: "A" }], offset: "o1" }),
      jsonResponse(200, { bases: [{ id: "appZZZZZZZZZZZZZZ", name: "B" }] }),
    ]);
    const ctx = refreshingCtx();
    const r = await a.invoke("list_bases", {}, oauthCred("old"), ctx);
    assert.equal(r.ok, true, r.error);
    assert.equal(ctx.refreshCalls(), 1);
    assert.deepEqual(f.calls.map((c) => c.headers.authorization), ["Bearer old", "Bearer tok-2", "Bearer tok-2"]);
  });
});

describe("Airtable writes (never retried)", () => {
  it("create_records: POST {records:[{fields}]} (plain or {fields}-wrapped input) with typecast", async () => {
    const { a, f } = adapter([jsonResponse(200, { records: [rec(REC1, { Name: "Launch" }), rec(REC2, { Name: "Recap" })] })]);
    const r = await a.invoke(
      "create_records",
      { baseId: BASE, table: "tblPosts", records: JSON.stringify([{ Name: "Launch" }, { fields: { Name: "Recap" } }]), typecast: true },
      oauthCred(),
      ctxWith(),
    );
    assert.equal(r.ok, true, r.error);
    assert.deepEqual((r.data as { created: Array<{ id: string }> }).created.map((x) => x.id), [REC1, REC2]);
    const c = f.calls[0];
    assert.equal(c.method, "POST");
    assert.equal(c.url.pathname, `/v0/${BASE}/tblPosts`);
    assert.deepEqual(c.body, { records: [{ fields: { Name: "Launch" } }, { fields: { Name: "Recap" } }], typecast: true });
  });

  it("create_records: a 429 is NOT retried", async () => {
    const { a, f, sleeps } = adapter([jsonResponse(429, {})]);
    const r = await a.invoke("create_records", { baseId: BASE, table: "T", records: '[{"Name":"x"}]' }, oauthCred(), ctxWith());
    assert.equal(r.errorCode, "rate_limited");
    assert.equal(f.calls.length, 1);
    assert.deepEqual(sleeps, []);
  });

  it("update_records: PATCH {records:[{id, fields}]}", async () => {
    const { a, f } = adapter([jsonResponse(200, { records: [rec(REC1, { Status: "Done" })] })]);
    const r = await a.invoke("update_records", { baseId: BASE, table: "T", records: [{ id: REC1, fields: { Status: "Done" } }] }, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls[0].method, "PATCH");
    assert.deepEqual(f.calls[0].body, { records: [{ id: REC1, fields: { Status: "Done" } }], typecast: false });
  });

  it("record validation: JSON, 1–10 records, record ids, non-empty fields, no duplicate ids — all before any call", async () => {
    const { a, f } = adapter([]);
    const eleven = JSON.stringify(Array.from({ length: 11 }, () => ({ Name: "x" })));
    const cases: Array<[string, Record<string, unknown>]> = [
      ["create_records", { records: "not json" }],
      ["create_records", { records: "[]" }],
      ["create_records", { records: eleven }],
      ["create_records", { records: "[{}]" }],
      ["update_records", { records: '[{"id":"nope","fields":{"a":1}}]' }],
      ["update_records", { records: JSON.stringify([{ id: REC1, fields: { a: 1 } }, { id: REC1, fields: { a: 2 } }]) }],
      ["update_records", { records: JSON.stringify([{ id: REC1 }]) }],
    ];
    for (const [tool, extra] of cases) {
      const r = await a.invoke(tool, { baseId: BASE, table: "T", ...extra }, oauthCred(), ctxWith());
      assert.equal(r.errorCode, "bad_request", `${tool} ${JSON.stringify(extra)}`);
    }
    assert.equal(f.calls.length, 0);
  });
});

describe("Airtable wiring", () => {
  it("OAuth: PKCE + Basic client auth on the token endpoint", () => {
    assert.equal(OAUTH_CONFIGS.airtable.pkce, true);
    assert.equal(OAUTH_CONFIGS.airtable.tokenRequest, "form_basic");
    assert.equal(OAUTH_CONFIGS.airtable.authorizeUrl, "https://airtable.com/oauth2/v1/authorize");
    assert.deepEqual(OAUTH_CONFIGS.airtable.scopes, ["data.records:read", "data.records:write", "schema.bases:read"]);
  });

  it("grants: files group; record writes are Tier-2 connector_write", () => {
    assert.equal(connectorGroup("airtable"), "files");
    assert.equal(connectorAction("airtable", "create_records"), "connector_write");
    assert.equal(connectorAction("airtable", "update_records"), "connector_write");
  });

  it("mock mode is labelled and writes nothing", async () => {
    const r = await new AirtableAdapter().invoke("create_records", { baseId: BASE, table: "T", records: "[]" }, null, ctxWith());
    assert.equal(r.mock, true);
    assert.equal((r.data as { written: boolean }).written, false);
  });
});
