// Phase 11 (bizsync): Shopify ↔ Ops sync against Postgres (app role) with a
// FAKE Shopify Admin GraphQL endpoint (in-memory, routed by query text —
// a labelled test fake; the live API is UNVERIFIED-LIVE).
//   1. Catalogue pull creates products/variants (single + multi-variant),
//      links them, and a re-pull is idempotent.
//   2. Conflict rule on products: local-only edit kept, Shopify-only edit
//      applied, a stock move is not a catalogue edit.
//   3. Inventory pull maps the location (auto warehouse), books ONE adjustment
//      per difference, re-pull is a no-op; local move → local_ahead; push sets
//      Shopify with changeFromQuantity; a push over a Shopify change is refused.
//   4. Orders import once (no duplicates on re-pull), payments recorded once,
//      the journal and the stock ledger are untouched by an order import.
//   5. Customers → contacts (dedupe by email); a signed-webhook order update
//      lands on the same order; no active connection → nothing applied.
//   6. biz_sync_links / biz_sync_runs are FORCE RLS and imports stay in their
//      workspace.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/bizsync/__tests__/shopify-sync-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { countWithoutScope, withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { publicResolve } from "@/lib/connectors/m21/live/__tests__/fixtures";
import { applyShopifyWebhook, pullCatalog, pullCustomers, pullInventory, pullOrders, pushInventory } from "../shopify/sync";
import { recordRun, recentRuns } from "../links";
import { recordInventoryTxn } from "@/lib/ops/doctype";

const RUN = `p11s-${Date.now().toString(36)}`;
const WS = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
const auth = { shop: "test-shop.myshopify.com", token: "shpat_test_token" };

let clock = Date.parse("2026-10-01T00:00:00Z");
const tick = () => new Date((clock += 60_000)).toISOString();

type Variant = { id: string; title: string; sku: string | null; price: string; inventoryItem: { id: string; tracked: boolean }; selectedOptions: Array<{ name: string; value: string }> };
const shop = {
  products: [] as Array<{ id: string; title: string; status: string; updatedAt: string; variants: { nodes: Variant[] } }>,
  locations: [{ id: "gid://shopify/Location/9", name: "Main store", isActive: true }],
  levels: new Map<string, { qty: number; updatedAt: string }>(), // `${item}@${loc}`
  orders: [] as Array<Record<string, unknown>>,
  customers: [] as Array<Record<string, unknown>>,
};
const mutations: Array<{ query: string; variables: Record<string, unknown> }> = [];

/** FAKE Shopify Admin GraphQL (tests only). */
const fakeShopify = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  assert.equal(url.host, "test-shop.myshopify.com");
  assert.match(url.pathname, /^\/admin\/api\/\d{4}-\d{2}\/graphql\.json$/);
  assert.equal(new Headers(init?.headers).get("x-shopify-access-token"), "shpat_test_token");
  const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
  const page = <T,>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  if (query.includes("inventorySetQuantities")) {
    mutations.push({ query, variables });
    const input = variables.input as { quantities: Array<{ inventoryItemId: string; locationId: string; quantity: number; changeFromQuantity: number }> };
    for (const q of input.quantities) {
      const cur = shop.levels.get(`${q.inventoryItemId}@${q.locationId}`);
      if (!cur || cur.qty !== q.changeFromQuantity) return json({ data: { inventorySetQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ field: ["input"], message: "The quantity changed", code: "CHANGE_FROM_QUANTITY_STALE" }] } } });
    }
    for (const q of input.quantities) shop.levels.set(`${q.inventoryItemId}@${q.locationId}`, { qty: q.quantity, updatedAt: tick() });
    return json({ data: { inventorySetQuantities: { inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" }, userErrors: [] } } });
  }
  if (query.includes("inventoryItem(id")) {
    const lvl = shop.levels.get(`${variables.item}@${variables.loc}`);
    return json({ data: { inventoryItem: { inventoryLevel: lvl ? { updatedAt: lvl.updatedAt, quantities: [{ name: "available", quantity: lvl.qty }] } : null } } });
  }
  if (query.includes("inventoryLevels(")) {
    const nodes = [...shop.levels.entries()]
      .filter(([k]) => k.endsWith(`@${variables.id}`))
      .map(([k, v]) => ({ updatedAt: v.updatedAt, item: { id: k.split("@")[0] }, quantities: [{ name: "available", quantity: v.qty }] }));
    return json({ data: { location: { inventoryLevels: page(nodes) } } });
  }
  if (query.includes("locations(")) return json({ data: { locations: page(shop.locations) } });
  if (query.includes("products(")) return json({ data: { products: page(shop.products) } });
  if (query.includes("orders(")) return json({ data: { orders: page(shop.orders) } });
  if (query.includes("customers(")) return json({ data: { customers: page(shop.customers) } });
  return json({ errors: [{ message: "unknown query (fake)" }] });
}) as typeof fetch;

const deps = { fetchImpl: fakeShopify, resolve: publicResolve, sleep: async () => undefined };

const v = (n: number, title: string, sku: string | null, price: string, opts: Array<{ name: string; value: string }> = []): Variant => ({
  id: `gid://shopify/ProductVariant/${n}`,
  title,
  sku,
  price,
  inventoryItem: { id: `gid://shopify/InventoryItem/${n}`, tracked: true },
  selectedOptions: opts,
});
const MAIN = "gid://shopify/Location/9";

before(async () => {
  for (const id of [WS, WS_B]) await prisma.workspace.create({ data: { id, name: `P11 ${id}`, ownerUserId: USER } });
  shop.products.push({ id: "gid://shopify/Product/10", title: "Mug", status: "ACTIVE", updatedAt: tick(), variants: { nodes: [v(100, "Default Title", "MUG-1", "12.00")] } });
  shop.products.push({ id: "gid://shopify/Product/20", title: "Tee", status: "ACTIVE", updatedAt: tick(), variants: { nodes: [v(200, "S", "TEE-S", "20.00", [{ name: "Size", value: "S" }]), v(201, "M", null, "21.50", [{ name: "Size", value: "M" }])] } });
  shop.levels.set(`gid://shopify/InventoryItem/100@${MAIN}`, { qty: 7, updatedAt: tick() });
  shop.levels.set(`gid://shopify/InventoryItem/200@${MAIN}`, { qty: 3, updatedAt: tick() });
  shop.customers.push({ id: "gid://shopify/Customer/7", firstName: "Ada", lastName: "Lovelace", updatedAt: tick(), defaultEmailAddress: { emailAddress: "Ada@Example.com" }, defaultPhoneNumber: null });
  shop.customers.push({ id: "gid://shopify/Customer/8", firstName: "Bob", lastName: null, updatedAt: tick(), defaultEmailAddress: { emailAddress: "bob@example.com" }, defaultPhoneNumber: { phoneNumber: "+15550001" } });
  shop.orders.push({
    id: "gid://shopify/Order/5", name: "#1005", createdAt: tick(), updatedAt: tick(), processedAt: "2026-10-01T09:00:00Z",
    displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", email: "ada@example.com", currencyCode: "USD",
    customer: { id: "gid://shopify/Customer/7", displayName: "Ada Lovelace" },
    subtotalPriceSet: { shopMoney: { amount: "24.00" } }, totalTaxSet: { shopMoney: { amount: "2.00" } }, totalDiscountsSet: { shopMoney: { amount: "0.00" } },
    totalPriceSet: { shopMoney: { amount: "26.00" } }, totalRefundedSet: { shopMoney: { amount: "0.00" } },
    lineItems: { nodes: [{ name: "Mug", sku: "MUG-1", quantity: 2, originalUnitPriceSet: { shopMoney: { amount: "12.00" } }, variant: { id: "gid://shopify/ProductVariant/100" } }] },
  });
  // An existing local contact (dedupe-by-email target).
  await withWorkspaceScope(WS, (tx) => tx.opsContact.create({ data: { workspaceId: WS, name: "Bob (local)", email: "bob@example.com" } }));
});

after(async () => {
  for (const id of [WS, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

const local = () =>
  withWorkspaceScope(WS, async (tx) => ({
    products: await tx.opsProduct.findMany({ where: { workspaceId: WS }, orderBy: { sku: "asc" } }),
    variants: await tx.opsProductVariant.findMany({ where: { workspaceId: WS }, orderBy: { sku: "asc" } }),
    txns: await tx.opsInventoryTxn.findMany({ where: { workspaceId: WS }, orderBy: { createdAt: "asc" } }),
    orders: await tx.opsOrder.findMany({ where: { workspaceId: WS } }),
    payments: await tx.opsPayment.findMany({ where: { workspaceId: WS } }),
    contacts: await tx.opsContact.findMany({ where: { workspaceId: WS }, orderBy: { email: "asc" } }),
    journal: await tx.opsJournalEntry.count({ where: { workspaceId: WS } }),
    journalLines: await tx.opsJournalLine.count({ where: { workspaceId: WS } }),
    links: await tx.bizSyncLink.findMany({ where: { workspaceId: WS } }),
  }));

describe("Shopify catalogue", () => {
  it("creates products and variants, links them, and a re-pull changes nothing", async () => {
    const r1 = await pullCatalog(WS, auth, { userId: USER }, deps);
    const l = await local();
    assert.deepEqual(l.products.map((p) => [p.sku, p.name, p.priceCents]), [["MUG-1", "Mug", 1200], ["SHOPIFY-P20", "Tee", 2000]]);
    const tee = l.products.find((p) => p.sku === "SHOPIFY-P20")!;
    const teeVariants = l.variants.filter((x) => x.productId === tee.id && !x.isDefault);
    assert.deepEqual(teeVariants.map((x) => [x.sku, x.name, x.priceCents]).sort(), [["SHOPIFY-V201", "Tee — M", 2150], ["TEE-S", "Tee — S", 2000]]);
    assert.equal(r1.created, 4);
    // product×2, variant×3 (one default), inventory_item×3
    assert.equal(l.links.filter((x) => x.objectType === "product").length, 2);
    assert.equal(l.links.filter((x) => x.objectType === "variant").length, 3);
    assert.equal(l.links.filter((x) => x.objectType === "inventory_item").length, 3);

    const r2 = await pullCatalog(WS, auth, { userId: USER }, deps);
    assert.equal(r2.created, 0);
    assert.equal(r2.updated, 0);
    assert.equal(r2.unchanged, 4);
    assert.equal((await local()).products.length, 2);
  });

  it("local-only edits are kept, Shopify-only edits applied; a stock move is not an edit", async () => {
    const mug = (await local()).products.find((p) => p.sku === "MUG-1")!;
    await withWorkspaceScope(WS, (tx) => tx.opsProduct.update({ where: { id: mug.id }, data: { name: "Mug (local name)" } }));
    const r1 = await pullCatalog(WS, auth, { userId: USER }, deps);
    assert.equal(r1.localAhead, 1);
    assert.equal((await local()).products.find((p) => p.id === mug.id)!.name, "Mug (local name)");

    const tee = (await local()).products.find((p) => p.sku === "SHOPIFY-P20")!;
    await withWorkspaceScope(WS, (tx) => recordInventoryTxn(tx, { workspaceId: WS, userId: USER }, { productId: tee.id, delta: 1, reason: "restock" }));
    shop.products[1]!.title = "Tee (v2)";
    shop.products[1]!.updatedAt = tick();
    const r2 = await pullCatalog(WS, auth, { userId: USER }, deps);
    assert.equal((await local()).products.find((p) => p.id === tee.id)!.name, "Tee (v2)");
    assert.equal(r2.conflicts.filter((c) => c.objectType === "product").length, 0, "the stock move did not make the product 'locally changed'");
    // Undo the test restock so the inventory section starts from Shopify's numbers.
    await withWorkspaceScope(WS, (tx) => recordInventoryTxn(tx, { workspaceId: WS, userId: USER }, { productId: tee.id, delta: -1, reason: "adjustment" }));
  });
});

describe("Shopify inventory", () => {
  it("maps the location, books one adjustment per difference, and a re-pull is a no-op", async () => {
    const before = (await local()).txns.length;
    const r1 = await pullInventory(WS, auth, { userId: USER }, deps);
    const l = await local();
    const locLink = l.links.find((x) => x.objectType === "location");
    assert.ok(locLink, "Shopify location mapped");
    const wh = await withWorkspaceScope(WS, (tx) => tx.opsWarehouse.findFirst({ where: { workspaceId: WS, code: "SHOP-9" } }));
    assert.ok(wh, "warehouse auto-created");
    const adj = l.txns.slice(before);
    assert.equal(adj.length, 2);
    assert.ok(adj.every((t) => t.reason === "adjustment" && t.locationId === locLink!.localId));
    assert.deepEqual(adj.map((t) => t.delta).sort(), [3, 7]);
    assert.equal(r1.updated, 2);
    const r2 = await pullInventory(WS, auth, { userId: USER }, deps);
    assert.equal(r2.updated, 0);
    assert.equal(r2.unchanged, 2);
    assert.equal((await local()).txns.length, before + 2);
  });

  it("Shopify-only change applies the difference; a local move is kept and pushed", async () => {
    shop.levels.set(`gid://shopify/InventoryItem/100@${MAIN}`, { qty: 10, updatedAt: tick() });
    await pullInventory(WS, auth, { userId: USER }, deps);
    const l = await local();
    const mug = l.products.find((p) => p.sku === "MUG-1")!;
    assert.equal(l.txns.at(-1)!.delta, 3);
    const locId = l.links.find((x) => x.objectType === "location")!.localId;

    // Local sale of 4 at that location → local_ahead on pull, then push.
    await withWorkspaceScope(WS, (tx) => recordInventoryTxn(tx, { workspaceId: WS, userId: USER }, { productId: mug.id, delta: -4, reason: "sale", locationId: locId }));
    const r = await pullInventory(WS, auth, { userId: USER }, deps);
    assert.equal(r.localAhead, 1);
    assert.equal(shop.levels.get(`gid://shopify/InventoryItem/100@${MAIN}`)!.qty, 10);
    const pushed = await pushInventory(WS, auth, { userId: USER }, deps);
    assert.equal(pushed.pushed, 1);
    assert.equal(shop.levels.get(`gid://shopify/InventoryItem/100@${MAIN}`)!.qty, 6);
    const q = (mutations.at(-1)!.variables.input as { quantities: Array<Record<string, unknown>> }).quantities[0]!;
    assert.equal(q.changeFromQuantity, 10);
    assert.equal(q.quantity, 6);
    assert.ok(typeof mutations.at(-1)!.variables.key === "string", "idempotency key sent");
    // Nothing left to push.
    assert.equal((await pushInventory(WS, auth, { userId: USER }, deps)).pushed, 0);
  });

  it("a push over a newer Shopify change is refused unless force", async () => {
    const l = await local();
    const mug = l.products.find((p) => p.sku === "MUG-1")!;
    const locId = l.links.find((x) => x.objectType === "location")!.localId;
    await withWorkspaceScope(WS, (tx) => recordInventoryTxn(tx, { workspaceId: WS, userId: USER }, { productId: mug.id, delta: -1, reason: "sale", locationId: locId }));
    // Shopify's change is newer than the local move (wall clock + 1h).
    shop.levels.set(`gid://shopify/InventoryItem/100@${MAIN}`, { qty: 2, updatedAt: new Date(Date.now() + 3_600_000).toISOString() });
    const refused = await pushInventory(WS, auth, { userId: USER }, deps);
    assert.equal(refused.pushed, 0);
    assert.equal(refused.conflicts.length, 1);
    assert.equal(shop.levels.get(`gid://shopify/InventoryItem/100@${MAIN}`)!.qty, 2);
    const forced = await pushInventory(WS, auth, { userId: USER, force: true }, deps);
    assert.equal(forced.pushed, 1);
    assert.equal(shop.levels.get(`gid://shopify/InventoryItem/100@${MAIN}`)!.qty, 5);
  });
});

describe("Shopify orders + customers", () => {
  it("imports an order once, records its payment once, never touches the journal or stock", async () => {
    const before = await local();
    const r1 = await pullOrders(WS, auth, {}, deps);
    const r2 = await pullOrders(WS, auth, {}, deps);
    const l = await local();
    assert.equal(r1.created, 1);
    assert.equal(r2.created, 0);
    assert.equal(r2.unchanged, 1);
    const orders = l.orders.filter((o) => o.source === "shopify");
    assert.equal(orders.length, 1);
    assert.equal(orders[0]!.status, "confirmed");
    assert.equal(orders[0]!.totalCents, 2600);
    const mug = l.products.find((p) => p.sku === "MUG-1")!;
    assert.equal((orders[0]!.lineItems as Array<{ productId?: string }>)[0]!.productId, mug.id);
    assert.equal(l.payments.filter((p) => p.provider === "shopify" && p.kind === "charge").length, 1);
    assert.equal(l.journal, before.journal);
    assert.equal(l.journalLines, before.journalLines);
    assert.equal(l.txns.length, before.txns.length, "an imported order moves no stock");
  });

  it("customers dedupe onto local contacts by email", async () => {
    const r = await pullCustomers(WS, auth, {}, deps);
    const l = await local();
    assert.equal(r.created, 1);
    assert.equal(r.linked, 1);
    assert.equal(l.contacts.filter((c) => c.email === "bob@example.com").length, 1);
    assert.equal(l.contacts.find((c) => c.email === "ada@example.com")?.name, "Ada Lovelace");
  });

  it("a verified webhook updates the same order only when the app is connected", async () => {
    const body = {
      id: 5, admin_graphql_api_id: "gid://shopify/Order/5", name: "#1005", created_at: "2026-10-01T09:00:00Z", updated_at: new Date(clock + 7_200_000).toISOString(),
      financial_status: "paid", fulfillment_status: "fulfilled", email: "ada@example.com", currency: "USD", subtotal_price: "24.00", total_tax: "2.00", total_discounts: "0.00", total_price: "26.00",
      line_items: [{ name: "Mug", sku: "MUG-1", quantity: 2, price: "12.00", variant_id: 100 }],
    };
    const skipped = await applyShopifyWebhook(WS, "orders/updated", body);
    assert.equal(skipped.applied, false);
    await prisma.connectorConnection.create({ data: { workspaceId: WS, userId: USER, connectorKey: "shopify", status: "active", scopes: [] } });
    const applied = await applyShopifyWebhook(WS, "orders/updated", body);
    assert.equal(applied.applied, true);
    const orders = (await local()).orders.filter((o) => o.source === "shopify");
    assert.equal(orders.length, 1);
    assert.equal(orders[0]!.status, "fulfilled");
    assert.equal((await applyShopifyWebhook(WS, "app/uninstalled", {})).applied, false);
  });
});

describe("isolation + run log", () => {
  it("records runs, and both tables are FORCE RLS; nothing leaks to another workspace", async () => {
    await recordRun(WS, "shopify", "sync_catalog", USER, () => pullCatalog(WS, auth, { userId: USER }, deps));
    await assert.rejects(recordRun(WS, "shopify", "sync_orders", USER, async () => { throw new Error("boom shpat_secret_token_value"); }));
    const runs = await recentRuns(WS, "shopify");
    assert.equal(runs[0]!.status, "failed");
    assert.ok(runs[0]!.error?.includes("boom"));
    assert.ok(runs.some((r) => r.operation === "sync_catalog" && r.status !== "running" && r.finishedAt));
    assert.equal(await countWithoutScope("biz_sync_links"), 0);
    assert.equal(await countWithoutScope("biz_sync_runs"), 0);
    const b = await withWorkspaceScope(WS_B, async (tx) => ({
      links: await tx.bizSyncLink.count(),
      runs: await tx.bizSyncRun.count(),
      products: await tx.opsProduct.count({ where: { workspaceId: WS_B } }),
      orders: await tx.opsOrder.count({ where: { workspaceId: WS_B } }),
      contacts: await tx.opsContact.count({ where: { workspaceId: WS_B } }),
    }));
    assert.deepEqual(b, { links: 0, runs: 0, products: 0, orders: 0, contacts: 0 });
    assert.ok((await withWorkspaceScope(WS, (tx) => tx.bizSyncLink.count())) > 8);
  });
});
