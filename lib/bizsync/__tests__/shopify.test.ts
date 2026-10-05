// Phase 11 (bizsync): Shopify pure pieces — shop-domain guard, OAuth callback
// HMAC, webhook HMAC (+ the app-secret fallback of the existing ingest),
// documented payload transforms (GraphQL + REST webhook), the conflict rules
// and the OAuth wiring. No network, no DB.
// Run: npx tsx --test lib/bizsync/__tests__/shopify.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { normalizeShopDomain, shopifyHmacMessage, verifyShopifyOAuthHmac } from "../shopify/shop";
import {
  GID,
  customerFromRest,
  levelFromRest,
  moneyToCents,
  orderFields,
  orderFromGql,
  orderFromRest,
  orderStatus,
  productFields,
  productFromGql,
  productFromRest,
  variantName,
} from "../shopify/map";
import { decideInventory, isOpsTopic } from "../shopify/sync";
import { changesSince, fingerprint, runStatusOf, stableJson } from "../links";
import { decideSync, pushAllowedByChanges } from "@/lib/connectors/sync-conflict";
import { verifyShopifyHmac } from "@/lib/substrate/graph/connectors/hmac";
import { resolveWebhookSecret } from "@/lib/substrate/graph/connectors/tierw";
import { buildTokenRequest, getOAuthConfig, parseOAuthState, startOAuthFlow } from "@/lib/vault/oauth";
import { parseParts, shopifyAuthFrom } from "@/lib/connectors/m21/native/shopify";
import { connectorAction, connectorGroup } from "@/lib/agents/grants";

process.env.MARKETR_CREDENTIALS_KEY ??= "a".repeat(64);

describe("shop domain guard", () => {
  it("accepts only *.myshopify.com, normalized", () => {
    assert.equal(normalizeShopDomain("My-Store.myshopify.com"), "my-store.myshopify.com");
    assert.equal(normalizeShopDomain("https://my-store.myshopify.com/admin/products"), "my-store.myshopify.com");
    assert.equal(normalizeShopDomain("my-store"), "my-store.myshopify.com");
    for (const bad of ["", "evil.com", "my-store.myshopify.com.evil.com", "127.0.0.1", "a b.myshopify.com", "-x.myshopify.com", null, undefined]) {
      assert.equal(normalizeShopDomain(bad as string), null, String(bad));
    }
  });
});

describe("Shopify OAuth callback HMAC", () => {
  it("matches Shopify's documented example (secret 'hush')", () => {
    const query = {
      code: "0907a61c0c8d55e99db179b68161bc00",
      hmac: "700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf",
      shop: "some-shop.myshopify.com",
      state: "0.6784241404160823",
      timestamp: "1337178173",
    };
    assert.equal(shopifyHmacMessage(query), "code=0907a61c0c8d55e99db179b68161bc00&shop=some-shop.myshopify.com&state=0.6784241404160823&timestamp=1337178173");
    assert.equal(verifyShopifyOAuthHmac(query, "hush"), true);
    assert.equal(verifyShopifyOAuthHmac(query, "wrong"), false);
    assert.equal(verifyShopifyOAuthHmac({ ...query, shop: "other.myshopify.com" }, "hush"), false);
    assert.equal(verifyShopifyOAuthHmac({ ...query, hmac: "" }, "hush"), false);
    assert.equal(verifyShopifyOAuthHmac(query, ""), false);
  });
});

describe("Shopify webhook HMAC (existing verifier, reused)", () => {
  it("verifies base64 HMAC-SHA256 of the raw body; any byte change fails", () => {
    const body = JSON.stringify({ id: 1, name: "#1001" });
    const sig = createHmac("sha256", "app-secret").update(body, "utf8").digest("base64");
    assert.equal(verifyShopifyHmac("app-secret", body, sig).ok, true);
    assert.equal(verifyShopifyHmac("app-secret", `${body} `, sig).ok, false);
    assert.equal(verifyShopifyHmac("other", body, sig).ok, false);
    assert.equal(verifyShopifyHmac("app-secret", body, null).ok, false);
  });

  it("an app-installed store verifies with SHOPIFY_CLIENT_SECRET; nothing else falls back to it", async () => {
    const saved = process.env.SHOPIFY_CLIENT_SECRET;
    process.env.SHOPIFY_CLIENT_SECRET = "app-secret";
    try {
      const base = { id: "gc1", workspaceId: "ws", tier: "webhook", status: "connected", scopesGranted: [], webhookSecretRef: null, createdAt: new Date(), updatedAt: new Date() };
      const installed = await resolveWebhookSecret({ ...base, platform: "shopify", authRef: "conn_1" } as never);
      assert.deepEqual(installed, { secret: "app-secret", mode: "app" });
      const manual = await resolveWebhookSecret({ ...base, platform: "shopify", authRef: null } as never);
      assert.equal(manual.secret, null);
      const hubspot = await resolveWebhookSecret({ ...base, platform: "hubspot", authRef: "conn_1" } as never);
      assert.equal(hubspot.secret, null);
    } finally {
      if (saved === undefined) delete process.env.SHOPIFY_CLIENT_SECRET;
      else process.env.SHOPIFY_CLIENT_SECRET = saved;
    }
  });
});

describe("payload transforms", () => {
  it("money strings → cents without float drift", () => {
    assert.equal(moneyToCents("19.99"), 1999);
    assert.equal(moneyToCents("12.5"), 1250);
    assert.equal(moneyToCents("0.10"), 10);
    assert.equal(moneyToCents("1000"), 100000);
    assert.equal(moneyToCents(4.2), 420);
    assert.equal(moneyToCents("-3.00"), 0);
    assert.equal(moneyToCents("abc"), 0);
  });

  const single = productFromGql({
    id: "gid://shopify/Product/10",
    title: "Mug",
    status: "ACTIVE",
    updatedAt: "2026-10-01T10:00:00Z",
    variants: { nodes: [{ id: "gid://shopify/ProductVariant/100", title: "Default Title", sku: "MUG-1", price: "12.00", inventoryItem: { id: "gid://shopify/InventoryItem/1000", tracked: true }, selectedOptions: [{ name: "Title", value: "Default Title" }] }] },
  });
  const multi = productFromGql({
    id: "gid://shopify/Product/20",
    title: "Tee",
    status: "DRAFT",
    updatedAt: "2026-10-01T10:00:00Z",
    variants: { nodes: [
      { id: "gid://shopify/ProductVariant/200", title: "S", sku: "TEE-S", price: "20.00", inventoryItem: { id: "gid://shopify/InventoryItem/2000", tracked: true }, selectedOptions: [{ name: "Size", value: "S" }] },
      { id: "gid://shopify/ProductVariant/201", title: "M", sku: null, price: "21.50", inventoryItem: { id: "gid://shopify/InventoryItem/2001", tracked: false }, selectedOptions: [{ name: "Size", value: "M" }] },
    ] },
  });

  it("single-variant product: variant SKU is the product SKU", () => {
    assert.deepEqual(productFields(single), { name: "Mug", sku: "MUG-1", priceCents: 1200, active: true, trackInventory: true });
    assert.equal(variantName(single, single.variants[0]!), "Mug");
  });

  it("multi-variant product: SHOPIFY-P SKU, variants keep options, missing SKU → SHOPIFY-V, draft → inactive", () => {
    assert.deepEqual(productFields(multi), { name: "Tee", sku: "SHOPIFY-P20", priceCents: 2000, active: false, trackInventory: true });
    assert.deepEqual(multi.variants[0]!.options, { Size: "S" });
    assert.equal(multi.variants[1]!.sku, null);
    assert.equal(variantName(multi, multi.variants[1]!), "Tee — M");
  });

  it("REST product webhook normalizes to the same gids as GraphQL", () => {
    const p = productFromRest({
      id: 20,
      admin_graphql_api_id: "gid://shopify/Product/20",
      title: "Tee",
      status: "active",
      updated_at: "2026-10-02T10:00:00-04:00",
      variants: [{ id: 200, admin_graphql_api_id: "gid://shopify/ProductVariant/200", title: "S", sku: "TEE-S", price: "20.00", inventory_item_id: 2000, inventory_management: "shopify", option1: "S" }],
    })!;
    assert.equal(p.id, multi.id);
    assert.equal(p.status, "ACTIVE");
    assert.equal(p.updatedAt, "2026-10-02T14:00:00.000Z");
    assert.equal(p.variants[0]!.id, multi.variants[0]!.id);
    assert.equal(p.variants[0]!.inventoryItemId, "gid://shopify/InventoryItem/2000");
  });

  it("order status rule", () => {
    const o = (f: string, ful = "UNFULFILLED", cancelledAt: string | null = null) => orderStatus({ financialStatus: f, fulfillmentStatus: ful, cancelledAt });
    assert.equal(o("PENDING"), "draft");
    assert.equal(o("EXPIRED"), "draft");
    assert.equal(o("PAID"), "confirmed");
    assert.equal(o("AUTHORIZED"), "confirmed");
    assert.equal(o("PARTIALLY_REFUNDED"), "confirmed");
    assert.equal(o("PAID", "FULFILLED"), "fulfilled");
    assert.equal(o("PAID", "FULFILLED", "2026-10-01T00:00:00Z"), "cancelled");
    assert.equal(o("VOIDED"), "cancelled");
  });

  it("GraphQL and REST orders normalize alike; lines resolve to local variants", () => {
    const g = orderFromGql({
      id: "gid://shopify/Order/5",
      name: "#1005",
      createdAt: "2026-10-01T09:00:00Z",
      updatedAt: "2026-10-01T09:05:00Z",
      processedAt: "2026-10-01T09:00:00Z",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "UNFULFILLED",
      email: "Ada@Example.com",
      currencyCode: "USD",
      customer: { id: "gid://shopify/Customer/7", displayName: "Ada L" },
      subtotalPriceSet: { shopMoney: { amount: "24.00" } },
      totalTaxSet: { shopMoney: { amount: "2.00" } },
      totalDiscountsSet: { shopMoney: { amount: "0.00" } },
      totalPriceSet: { shopMoney: { amount: "26.00" } },
      totalRefundedSet: { shopMoney: { amount: "0.00" } },
      lineItems: { nodes: [{ name: "Mug", sku: "MUG-1", quantity: 2, originalUnitPriceSet: { shopMoney: { amount: "12.00" } }, variant: { id: "gid://shopify/ProductVariant/100" } }] },
    });
    const r = orderFromRest({
      id: 5,
      admin_graphql_api_id: "gid://shopify/Order/5",
      name: "#1005",
      created_at: "2026-10-01T09:00:00Z",
      updated_at: "2026-10-01T09:05:00Z",
      processed_at: "2026-10-01T09:00:00Z",
      financial_status: "paid",
      fulfillment_status: null,
      email: "ada@example.com",
      currency: "USD",
      customer: { id: 7, first_name: "Ada", last_name: "L" },
      subtotal_price: "24.00",
      total_tax: "2.00",
      total_discounts: "0.00",
      total_price: "26.00",
      line_items: [{ name: "Mug", sku: "MUG-1", quantity: 2, price: "12.00", variant_id: 100 }],
    })!;
    for (const k of ["id", "name", "financialStatus", "fulfillmentStatus", "email", "subtotalCents", "taxCents", "totalCents", "customerId"] as const) {
      assert.deepEqual(r[k], g[k], k);
    }
    assert.deepEqual(r.lines, g.lines);
    const f = orderFields(g, new Map([[GID.variant(100), { productId: "p1", variantId: "v1" }]]));
    assert.equal(f.status, "confirmed");
    assert.deepEqual(f.lineItems, [{ name: "Mug", sku: "MUG-1", qty: 2, priceCents: 1200, productId: "p1", variantId: "v1" }]);
    assert.equal(f.totalCents, 2600);
    assert.ok(f.paidAt instanceof Date);
  });

  it("REST refunds sum successful refund transactions; customers and inventory levels", () => {
    const o = orderFromRest({ id: 6, financial_status: "partially_refunded", refunds: [{ transactions: [{ kind: "refund", status: "success", amount: "5.00" }, { kind: "refund", status: "failure", amount: "9.00" }] }] })!;
    assert.equal(o.refundedCents, 500);
    assert.equal(o.id, "gid://shopify/Order/6");
    assert.deepEqual(customerFromRest({ id: 7, email: "B@X.com", first_name: "Bo", updated_at: "2026-10-01T00:00:00Z" }), { id: "gid://shopify/Customer/7", name: "Bo", email: "b@x.com", phone: null, updatedAt: "2026-10-01T00:00:00.000Z" });
    assert.deepEqual(levelFromRest({ inventory_item_id: 2000, location_id: 9, available: 4, updated_at: "2026-10-01T00:00:00Z" }), { inventoryItemId: "gid://shopify/InventoryItem/2000", locationId: "gid://shopify/Location/9", available: 4, updatedAt: "2026-10-01T00:00:00.000Z" });
    assert.equal(levelFromRest({ location_id: 9 }), null);
  });

  it("only order/product/customer/inventory topics are applied to Ops", () => {
    for (const t of ["orders/create", "orders/updated", "orders/cancelled", "products/update", "customers/create", "inventory_levels/update"]) assert.equal(isOpsTopic(t), true, t);
    for (const t of ["products/delete", "app/uninstalled", "shop/redact", ""]) assert.equal(isOpsTopic(t), false, t);
  });
});

describe("conflict rules", () => {
  const t = (m: number) => new Date(Date.UTC(2026, 9, 1, 0, m));
  it("the shared record rule", () => {
    assert.equal(decideSync({ remoteChanged: true, localChanged: false, remoteAt: t(1), localAt: t(5) }), "apply");
    assert.equal(decideSync({ remoteChanged: false, localChanged: true, remoteAt: t(5), localAt: t(1) }), "local_ahead");
    assert.equal(decideSync({ remoteChanged: false, localChanged: false, remoteAt: t(1), localAt: t(1) }), "skip_unchanged");
    assert.equal(decideSync({ remoteChanged: true, localChanged: true, remoteAt: t(5), localAt: t(1) }), "conflict_remote_wins");
    assert.equal(decideSync({ remoteChanged: true, localChanged: true, remoteAt: t(1), localAt: t(5) }), "conflict_local_wins");
  });

  it("local change = fingerprint of mapped fields, not updatedAt", () => {
    const h = fingerprint({ name: "Mug", priceCents: 1200 });
    assert.equal(h, fingerprint({ priceCents: 1200, name: "Mug" }), "key order does not matter");
    assert.notEqual(h, fingerprint({ name: "Mug", priceCents: 1300 }));
    assert.equal(stableJson({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
    assert.deepEqual(changesSince(null, t(1), h), { remoteChanged: true, localChanged: true });
    assert.deepEqual(changesSince({ remoteUpdatedAt: t(1), localHash: h }, t(1), h), { remoteChanged: false, localChanged: false });
    assert.deepEqual(changesSince({ remoteUpdatedAt: t(1), localHash: h }, t(2), h), { remoteChanged: true, localChanged: false });
    assert.deepEqual(changesSince({ remoteUpdatedAt: t(1), localHash: h }, t(1), "other"), { remoteChanged: false, localChanged: true });
  });

  it("inventory rule compares quantities against the last agreed quantity", () => {
    const base = { remoteAt: t(5), localAt: t(1) };
    assert.equal(decideInventory({ lastQty: 4, remoteQty: 7, localQty: 7, ...base }), "in_sync");
    assert.equal(decideInventory({ lastQty: 4, remoteQty: 6, localQty: 4, ...base }), "apply");
    assert.equal(decideInventory({ lastQty: 4, remoteQty: 4, localQty: 2, ...base }), "local_ahead");
    assert.equal(decideInventory({ lastQty: 4, remoteQty: 6, localQty: 2, ...base }), "conflict_remote_wins");
    assert.equal(decideInventory({ lastQty: 4, remoteQty: 6, localQty: 2, remoteAt: t(1), localAt: t(5) }), "conflict_local_wins");
    assert.equal(decideInventory({ lastQty: null, remoteQty: 9, localQty: 0, remoteAt: t(1), localAt: new Date(0) }), "conflict_remote_wins", "first sync onto an empty location takes Shopify's");
  });

  it("push guard: refused over a newer remote change unless force", () => {
    assert.equal(pushAllowedByChanges({ linked: true, remoteChanged: false, remoteAt: t(9), localAt: t(1), force: false }), true);
    assert.equal(pushAllowedByChanges({ linked: true, remoteChanged: true, remoteAt: t(9), localAt: t(1), force: false }), false);
    assert.equal(pushAllowedByChanges({ linked: true, remoteChanged: true, remoteAt: t(1), localAt: t(9), force: false }), true);
    assert.equal(pushAllowedByChanges({ linked: true, remoteChanged: true, remoteAt: t(9), localAt: t(1), force: true }), true);
    assert.equal(pushAllowedByChanges({ linked: false, remoteChanged: true, remoteAt: t(9), localAt: t(1), force: false }), true);
  });

  it("a run with conflicts or failures is partial", () => {
    assert.equal(runStatusOf({ conflicts: [] }), "succeeded");
    assert.equal(runStatusOf({ conflicts: [{}] }), "partial");
    assert.equal(runStatusOf({ failed: 1 }), "partial");
    assert.equal(runStatusOf({ truncated: true }), "partial");
  });
});

describe("OAuth + adapter wiring", () => {
  it("Shopify flow needs a valid store; the shop is signed into the state and is the authorize host", () => {
    process.env.SHOPIFY_CLIENT_ID = "shp-client";
    try {
      assert.throws(() => startOAuthFlow("u1", "ws1", "shopify", "https://app.example"), /store domain/);
      assert.throws(() => startOAuthFlow("u1", "ws1", "shopify", "https://app.example", { shop: "evil.com" }), /store domain/);
      const { url, state } = startOAuthFlow("u1", "ws1", "shopify", "https://app.example", { shop: "My-Store.myshopify.com" });
      const u = new URL(url);
      assert.equal(u.origin, "https://my-store.myshopify.com");
      assert.equal(u.pathname, "/admin/oauth/authorize");
      assert.equal(u.searchParams.get("scope"), "read_products,read_inventory,write_inventory,read_locations,read_orders,read_customers");
      assert.equal(parseOAuthState(state).shop, "my-store.myshopify.com");
      assert.deepEqual(getOAuthConfig("shopify")!.callbackMeta!({}, parseOAuthState(state)), { shop: "my-store.myshopify.com", label: "my-store.myshopify.com" });
    } finally {
      delete process.env.SHOPIFY_CLIENT_ID;
    }
  });

  it("form_basic token requests carry Basic client auth and a form body without the secret", () => {
    const req = buildTokenRequest({ tokenRequest: "form_basic" }, { grant_type: "authorization_code", code: "c1" }, "id", "sec");
    assert.equal((req.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("id:sec").toString("base64")}`);
    assert.equal(String(req.body), "grant_type=authorization_code&code=c1");
  });

  it("adapter auth needs both token and shop; parts are ordered catalogue-first", () => {
    assert.equal(shopifyAuthFrom({ kind: "oauth2", payload: { access_token: "t" } }), null);
    assert.equal(shopifyAuthFrom({ kind: "oauth2", payload: { access_token: "t", shop: "a.myshopify.com" } })?.shop, "a.myshopify.com");
    assert.deepEqual(parseParts("orders, catalog"), ["catalog", "orders"]);
    assert.deepEqual(parseParts(undefined), ["catalog", "inventory", "orders", "customers"]);
    assert.throws(() => parseParts("everything"), /subset/);
  });

  it("tools land in the ops group with Tier-2 actions", () => {
    assert.equal(connectorGroup("shopify"), "ops");
    assert.equal(connectorAction("shopify", "sync_from_shopify"), "import_commerce_data");
    assert.equal(connectorAction("shopify", "push_inventory"), "update_store_inventory");
    assert.equal(connectorAction("shopify", "register_webhooks"), "write_shopify");
  });
});
