// Phase 4b: Notion adapter live path (search, pages, data-source queries).
// Run: npx tsx --test lib/connectors/m21/live/__tests__/notion.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NotionAdapter } from "../../native/notion";
import { propertyValue, NOTION_VERSION } from "../notion";
import { buildTokenRequest, OAUTH_CONFIGS } from "@/lib/vault/oauth";
import { jsonResponse, scriptedFetch, liveDeps, oauthCred, ctxWith } from "./fixtures";

const PAGE_ID = "1429989fe8ac4effbc8f57f56486db54";
const PAGE_UUID = "1429989f-e8ac-4eff-bc8f-57f56486db54";
const DB_ID = "a1d8501e1ac44d1a8c6c1b2b0e3c4f5a";

const titleProp = (t: string) => ({ type: "title", title: [{ plain_text: t }] });
const para = (t: string, extra: Record<string, unknown> = {}) => ({
  id: `b-${t}`,
  type: "paragraph",
  paragraph: { rich_text: [{ plain_text: t }] },
  has_children: false,
  ...extra,
});

describe("Notion adapter", () => {
  it("mock mode without a credential", async () => {
    const f = scriptedFetch([]);
    const r = await new NotionAdapter(liveDeps(f.fetchImpl).deps).invoke("search_pages", { query: "brand" }, null, ctxWith());
    assert.equal(r.mock, true);
    assert.equal(f.calls.length, 0);
  });

  it("search_pages: POST /v1/search with Notion-Version, cursor pagination", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { results: [{ object: "page", id: "p1", properties: { Name: titleProp("Brand voice") }, last_edited_time: "2026-09-01T00:00:00.000Z", url: "https://www.notion.so/p1" }], has_more: true, next_cursor: "cur2" }),
      jsonResponse(200, { results: [{ object: "data_source", id: "ds1", title: [{ plain_text: "Pipeline" }] }], has_more: false, next_cursor: null }),
    ]);
    const r = await new NotionAdapter(liveDeps(f.fetchImpl).deps).invoke("search_pages", { query: "brand" }, oauthCred("ntok"), ctxWith());
    assert.equal(r.ok, true, r.error);
    const c = f.calls[0];
    assert.equal(c.method, "POST");
    assert.equal(c.url.href, "https://api.notion.com/v1/search");
    assert.equal(c.headers["notion-version"], NOTION_VERSION);
    assert.equal(c.headers.authorization, "Bearer ntok");
    assert.deepEqual(c.body, { query: "brand", page_size: 25, sort: { timestamp: "last_edited_time", direction: "descending" } });
    assert.equal((f.calls[1].body as { start_cursor: string }).start_cursor, "cur2");
    assert.deepEqual(r.data, [
      { id: "p1", title: "Brand voice", type: "page", lastEdited: "2026-09-01T00:00:00.000Z", url: "https://www.notion.so/p1" },
      { id: "ds1", title: "Pipeline", type: "data_source", lastEdited: null, url: null },
    ]);
  });

  it("read_page: title + paginated blocks + one nested level", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { object: "page", id: PAGE_UUID, properties: { title: titleProp("Strategy") }, url: "u" }),
      jsonResponse(200, { results: [{ id: "h", type: "heading_1", heading_1: { rich_text: [{ plain_text: "Goals" }] } }, para("one", { has_children: true, id: "parent" })], has_more: true, next_cursor: "c2" }),
      jsonResponse(200, { results: [{ id: "t", type: "to_do", to_do: { rich_text: [{ plain_text: "ship" }], checked: true } }], has_more: false }),
      jsonResponse(200, { results: [para("child")], has_more: false }),
    ]);
    const r = await new NotionAdapter(liveDeps(f.fetchImpl).deps).invoke("read_page", { pageId: PAGE_ID }, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls[0].url.pathname, `/v1/pages/${PAGE_UUID}`);
    assert.equal(f.calls[1].url.pathname, `/v1/blocks/${PAGE_UUID}/children`);
    assert.equal(f.calls[1].url.searchParams.get("page_size"), "100");
    assert.equal(f.calls[2].url.searchParams.get("start_cursor"), "c2");
    assert.equal(f.calls[3].url.pathname, "/v1/blocks/parent/children");
    const data = r.data as { title: string; text: string; truncated: boolean };
    assert.equal(data.title, "Strategy");
    assert.equal(data.text, "# Goals\none\n  child\n- [x] ship");
    assert.equal(data.truncated, false);
  });

  it("query_database resolves the database's data source then queries it", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { object: "database", id: DB_ID, data_sources: [{ id: "ds-1", name: "Main" }] }),
      jsonResponse(200, {
        results: [
          {
            id: "row1",
            url: "https://www.notion.so/row1",
            properties: {
              Name: titleProp("Implant guide"),
              Status: { type: "status", status: { name: "Draft" } },
              Due: { type: "date", date: { start: "2026-10-01", end: null } },
              Tags: { type: "multi_select", multi_select: [{ name: "seo" }] },
            },
          },
        ],
        has_more: false,
      }),
    ]);
    const r = await new NotionAdapter(liveDeps(f.fetchImpl).deps).invoke("query_database", { databaseId: DB_ID, limit: "10" }, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls[0].url.pathname, "/v1/databases/a1d8501e-1ac4-4d1a-8c6c-1b2b0e3c4f5a");
    assert.equal(f.calls[1].method, "POST");
    assert.equal(f.calls[1].url.pathname, "/v1/data_sources/ds-1/query");
    assert.deepEqual(f.calls[1].body, { page_size: 10 });
    const data = r.data as { dataSourceId: string; rows: Array<{ title: string; properties: Record<string, unknown> }> };
    assert.equal(data.dataSourceId, "ds-1");
    assert.equal(data.rows[0].title, "Implant guide");
    assert.deepEqual(data.rows[0].properties, { Name: "Implant guide", Status: "Draft", Due: { start: "2026-10-01", end: null }, Tags: ["seo"] });
  });

  it("429 honours Retry-After; 404 maps to not_found; ids are validated", async () => {
    const f = scriptedFetch([
      jsonResponse(429, { object: "error", code: "rate_limited", message: "Rate limited" }, { "retry-after": "1" }),
      jsonResponse(404, { object: "error", code: "object_not_found", message: "Could not find page" }),
    ]);
    const { deps, sleeps } = liveDeps(f.fetchImpl);
    const a = new NotionAdapter(deps);
    const r = await a.invoke("read_page", { pageId: PAGE_ID }, oauthCred(), ctxWith());
    assert.deepEqual(sleeps, [1000]);
    assert.equal(r.errorCode, "not_found");
    assert.match(r.error ?? "", /Could not find page/);
    assert.equal((await a.invoke("read_page", { pageId: "nope" }, oauthCred(), ctxWith())).errorCode, "bad_request");
  });

  it("propertyValue flattens common property types", () => {
    assert.equal(propertyValue({ type: "number", number: 3 }), 3);
    assert.equal(propertyValue({ type: "checkbox", checkbox: true }), true);
    assert.equal(propertyValue({ type: "select", select: null }), null);
    assert.deepEqual(propertyValue({ type: "people", people: [{ id: "u1", name: "Ada" }] }), ["Ada"]);
    assert.equal(propertyValue({ type: "formula", formula: { type: "string", string: "x" } }), "x");
  });

  it("Notion OAuth uses owner=user + Basic client auth with a JSON body", () => {
    const cfg = OAUTH_CONFIGS.notion;
    assert.equal(cfg.extra?.owner, "user");
    const req = buildTokenRequest(cfg, { grant_type: "refresh_token", refresh_token: "r" }, "cid", "csec");
    const headers = req.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Basic ${Buffer.from("cid:csec").toString("base64")}`);
    assert.equal(headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(String(req.body)), { grant_type: "refresh_token", refresh_token: "r" });
    // Google stays form-encoded with client credentials in the body.
    const g = buildTokenRequest(OAUTH_CONFIGS.ga4, { grant_type: "refresh_token", refresh_token: "r" }, "cid", "csec");
    assert.equal((g.body as URLSearchParams).get("client_secret"), "csec");
  });
});
