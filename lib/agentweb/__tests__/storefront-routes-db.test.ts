// Phase 21A (WS=agentweb): the public storefront agent routes on real Postgres, as the
// least-privilege app role. /shop/[store]/ask, /mcp and /llms.txt are unauthenticated and
// read-only, so the tests pin what makes that safe:
//   - only a PUBLISHED store resolves (unpublished / unknown: 404, nothing revealed);
//   - answers come from THAT store's published catalogue only (the other tenant's product
//     is invisible even to an exact-name query);
//   - per-store+IP window: the 31st request in a minute is a 429 with Retry-After;
//   - MCP: initialize, tools/list (one read-only tool), tools/call; notification 202;
//     GET 405; parse error, batch and oversized bodies refused; unknown tool refused;
//   - llms.txt is a valid llms.txt that points at the products and the endpoints.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=<app role url> MARKETR_CREDENTIALS_KEY=… npx tsx --test lib/agentweb/__tests__/storefront-routes-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "@/lib/ops/entities";
import { opsCreate, type OpsActor } from "@/lib/ops/doctype";
import { __resetStoreLimits } from "@/lib/ops/store/limits";
import { parseLlmsTxt } from "../site/llmstxt";
import { MCP_BODY_LIMIT, __resetStorefrontCache } from "../site/storefront-http";
import { GET as ask } from "@/app/shop/[storeSlug]/ask/route";
import { GET as mcpGet, POST as mcpPost } from "@/app/shop/[storeSlug]/mcp/route";
import { GET as llms } from "@/app/shop/[storeSlug]/llms.txt/route";

const WS_A = "p21shop-ws-a";
const WS_B = "p21shop-ws-b";
const WS_C = "p21shop-ws-c";
const A: OpsActor = { workspaceId: WS_A, userId: "user-p21shop-a" };
const B: OpsActor = { workspaceId: WS_B, userId: "user-p21shop-b" };
const C: OpsActor = { workspaceId: WS_C, userId: "user-p21shop-c" };
const def = (slug: string) => OPS_ENTITY_MAP[slug]!;
const SLUG = "p21shop-acme";

async function ws(id: string) {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${id}, ${"test:" + id}, now())`;
}
async function create(actor: OpsActor, slug: string, body: Record<string, unknown>) {
  const r = await withWorkspaceScope(actor.workspaceId, (tx) => opsCreate(tx, def(slug), actor, body));
  assert.equal(r.outcome, "done");
  return (r as { row: Record<string, unknown> }).row;
}

const ctx = (slug: string) => ({ params: Promise.resolve({ storeSlug: slug }) });
const get = (path: string, ip = "203.0.113.7") => new Request(`https://shop.test${path}`, { headers: { "x-forwarded-for": ip } });
const rpc = (body: unknown, ip = "203.0.113.8") => new Request("https://shop.test/shop/x/mcp", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: typeof body === "string" ? body : JSON.stringify(body) });

before(async () => {
  await ws(WS_A);
  await ws(WS_B);
  await ws(WS_C);
  const mug = await create(A, "products", { name: "Blue mug", sku: "P21S-MUG", priceCents: 1250, stockQty: 4 });
  const tee = await create(A, "products", { name: "Tee", sku: "P21S-TEE", priceCents: 1800, stockQty: 0 });
  const storeA = await create(A, "stores", { name: "Acme shop", slug: SLUG, published: true, description: "Mugs and tees, shipped from Leeds." });
  await create(A, "store-listings", { storeId: storeA.id, productId: mug.id, title: "Blue mug", description: "A glazed mug." });
  await create(A, "store-listings", { storeId: storeA.id, productId: tee.id, title: "Tee" });
  await create(C, "stores", { name: "Hidden shop", slug: "p21shop-hidden", published: false });
  const lamp = await create(B, "products", { name: "Secret lamp", sku: "P21S-LAMP", priceCents: 9900, stockQty: 3 });
  const storeB = await create(B, "stores", { name: "B shop", slug: "p21shop-bee", published: true });
  await create(B, "store-listings", { storeId: storeB.id, productId: lamp.id, title: "Secret lamp" });
});

after(async () => {
  for (const id of [WS_A, WS_B, WS_C]) await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
});

describe("GET /shop/[store]/ask", () => {
  it("answers from the published catalogue, with the NLWeb result shape and CORS", async () => {
    __resetStoreLimits();
    __resetStorefrontCache();
    const res = await ask(get(`/shop/${SLUG}/ask?query=${encodeURIComponent("blue mug price")}`), ctx(SLUG));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const body = await res.json();
    assert.equal(body.mode, "list");
    assert.equal(body.results[0].name, "Blue mug");
    assert.equal(body.results[0].url, "https://shop.test/shop/p21shop-acme/p/" + new URL(body.results[0].url).pathname.split("/").pop());
    assert.equal(body.results[0].schema_object["@type"], "Product");
    assert.equal(body.results[0].schema_object.offers.price, "12.50");
    assert.equal(body.results[0].schema_object.offers.availability, "https://schema.org/InStock");
  });

  it("summarize is extractive and says so; out of stock is reported as it is", async () => {
    const res = await ask(get(`/shop/${SLUG}/ask?query=${encodeURIComponent("is the tee in stock")}&mode=summarize`), ctx(SLUG));
    const body = await res.json();
    assert.equal(body.summary.method, "extractive");
    assert.match(body.summary.text, /Out of stock/);
  });

  it("refuses generate mode and an empty query with a 400", async () => {
    assert.equal((await ask(get(`/shop/${SLUG}/ask?query=x&mode=generate`), ctx(SLUG))).status, 400);
    assert.equal((await ask(get(`/shop/${SLUG}/ask`), ctx(SLUG))).status, 400);
  });

  it("404s an unpublished or unknown store alike and never shows another tenant's product", async () => {
    for (const slug of ["p21shop-hidden", "p21shop-nope", "NOT A SLUG"]) {
      const res = await ask(get(`/shop/${slug}/ask?query=lamp`), ctx(slug));
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "Not found" });
    }
    const own = await (await ask(get(`/shop/${SLUG}/ask?query=${encodeURIComponent("secret lamp")}`), ctx(SLUG))).json();
    assert.deepEqual(own.results, []);
    assert.match(own.message, /nothing on this site/i);
  });

  it("rate limits per store and IP: the 31st request in a window is a 429 with Retry-After", async () => {
    __resetStoreLimits();
    const ip = "198.51.100.99";
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) last = await ask(get(`/shop/${SLUG}/ask?query=mug`, ip), ctx(SLUG));
    assert.equal(last!.status, 429);
    assert.ok(Number(last!.headers.get("retry-after")) >= 1);
    // another client is not affected
    assert.equal((await ask(get(`/shop/${SLUG}/ask?query=mug`, "198.51.100.100"), ctx(SLUG))).status, 200);
  });
});

describe("POST /shop/[store]/mcp", () => {
  it("initialize, tools/list (one read-only tool) and tools/call", async () => {
    __resetStoreLimits();
    const init = await (await mcpPost(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }), ctx(SLUG))).json();
    assert.equal(init.result.serverInfo.name, "Acme shop");
    const list = await (await mcpPost(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), ctx(SLUG))).json();
    assert.deepEqual(list.result.tools.map((t: { name: string; annotations: { readOnlyHint: boolean } }) => [t.name, t.annotations.readOnlyHint]), [["ask", true]]);
    const call = await (await mcpPost(rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask", arguments: { query: "blue mug" } } }), ctx(SLUG))).json();
    assert.equal(JSON.parse(call.result.content[0].text).results[0].name, "Blue mug");
  });

  it("a notification is 202 with no body; an unknown tool is refused", async () => {
    const note = await mcpPost(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }), ctx(SLUG));
    assert.equal(note.status, 202);
    assert.equal(await note.text(), "");
    const bad = await (await mcpPost(rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "checkout", arguments: {} } }), ctx(SLUG))).json();
    assert.equal(bad.error.code, -32602);
  });

  it("refuses malformed, batched and oversized requests; GET is 405", async () => {
    assert.equal((await (await mcpPost(rpc("{nope"), ctx(SLUG))).json()).error.code, -32700);
    assert.equal((await (await mcpPost(rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }]), ctx(SLUG))).json()).error.code, -32600);
    const big = await mcpPost(rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(MCP_BODY_LIMIT) })), ctx(SLUG));
    assert.equal(big.status, 413);
    assert.equal(mcpGet().status, 405);
  });

  it("404s an unpublished store", async () => {
    assert.equal((await mcpPost(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }), ctx("p21shop-hidden"))).status, 404);
  });
});

describe("GET /shop/[store]/llms.txt", () => {
  it("is a valid llms.txt listing the products and the read-only endpoints", async () => {
    __resetStoreLimits();
    const res = await llms(get(`/shop/${SLUG}/llms.txt`), ctx(SLUG));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
    const text = await res.text();
    const parsed = parseLlmsTxt(text);
    assert.ok(parsed.valid, parsed.problems.join(";"));
    assert.equal(parsed.title, "Acme shop");
    const urls = parsed.sections.flatMap((s) => s.links.map((l) => l.url));
    assert.ok(urls.some((u) => u.endsWith("/shop/p21shop-acme/mcp")));
    assert.ok(urls.some((u) => u.includes("/p/")));
    assert.ok(!/lamp/i.test(text));
    assert.equal((await llms(get(`/shop/p21shop-hidden/llms.txt`), ctx("p21shop-hidden"))).status, 404);
  });
});
