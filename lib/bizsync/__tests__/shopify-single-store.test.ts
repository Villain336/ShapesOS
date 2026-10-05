// Phase 14 (connectors): Shopify single-store connection against a scripted
// (labelled FAKE) Shopify — the token request and the probe query use the
// documented shapes:
//   shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant
//     POST https://{shop}/admin/oauth/access_token (form: grant_type=client_credentials,
//     client_id, client_secret) → { access_token, scope, expires_in: 86399 }
//   shopify.dev/docs/apps/build/authentication-authorization/legacy/admin-custom-apps
//     (a static X-Shopify-Access-Token)
// Live Shopify is UNVERIFIED-LIVE until a store + app exist.
// Run: npx tsx --test lib/bizsync/__tests__/shopify-single-store.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, publicResolve, scriptedFetch, type RecordedRequest } from "@/lib/connectors/m21/live/__tests__/fixtures";
import { buildSingleStoreCredential, mintClientCredentialsToken, missingScopes, renewSingleStoreCredential, singleStoreModeOf } from "../shopify/single-store";
import { shopifyAuthFrom } from "@/lib/connectors/m21/native/shopify";
import { ConnectorApiError } from "@/lib/connectors/m21/live/http";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const SECRET = "shpss_client_secret_value";
// The documented token response (client credentials grant page).
const TOKEN = { access_token: "f85632530bf277ec9ac6f649fc327f17", scope: "read_products,write_inventory,read_locations,read_orders,read_customers", expires_in: 86399 };
const probe = (scopes: string[]) => jsonResponse(200, { data: { shop: { name: "Ada's Shop", myshopifyDomain: "ada-shop.myshopify.com" }, currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) } } });
const formOf = (r: RecordedRequest) => Object.fromEntries(new URLSearchParams(String(r.body)).entries());

describe("client credentials grant (Dev Dashboard app in the merchant's own organization)", () => {
  it("requests a token with the documented form body", async () => {
    const f = scriptedFetch([jsonResponse(200, TOKEN)]);
    const t = await mintClientCredentialsToken("ada-shop", "cid-1", SECRET, { fetchImpl: f.fetchImpl, resolve: publicResolve });
    assert.equal(t.access_token, TOKEN.access_token);
    assert.equal(t.expires_in, 86399);
    const req = f.calls[0]!;
    assert.equal(req.method, "POST");
    assert.equal(req.url.href, "https://ada-shop.myshopify.com/admin/oauth/access_token");
    assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
    assert.deepEqual(formOf(req), { grant_type: "client_credentials", client_id: "cid-1", client_secret: SECRET });
  });

  it("explains shop_not_permitted (store outside the app's organization) and never echoes the secret", async () => {
    const f = scriptedFetch([jsonResponse(400, { error: "shop_not_permitted", error_description: `Client credentials cannot be performed on this shop. ${SECRET}` })]);
    await assert.rejects(mintClientCredentialsToken("ada-shop", "cid-1", SECRET, { fetchImpl: f.fetchImpl, resolve: publicResolve }), (e: unknown) => {
      assert.ok(e instanceof ConnectorApiError);
      assert.equal(e.code, "forbidden");
      assert.match(e.message, /same Shopify organization/);
      assert.ok(!e.message.includes(SECRET));
      return true;
    });
    const g = scriptedFetch([jsonResponse(401, { error: "invalid_client", error_description: `bad secret ${SECRET}` })]);
    await assert.rejects(mintClientCredentialsToken("ada-shop", "cid-1", SECRET, { fetchImpl: g.fetchImpl, resolve: publicResolve }), (e: unknown) => e instanceof ConnectorApiError && e.code === "auth_rejected" && !e.message.includes(SECRET));
  });

  it("refuses a non-myshopify host before any request", async () => {
    const f = scriptedFetch([]);
    await assert.rejects(mintClientCredentialsToken("evil.example.com", "c", "s", { fetchImpl: f.fetchImpl, resolve: publicResolve }), /myshopify\.com/);
    assert.equal(f.calls.length, 0);
  });

  it("builds { auth_mode, shop, access_token, webhook_secret=client secret } validated by one probe query", async () => {
    const f = scriptedFetch([jsonResponse(200, TOKEN), probe(["read_products", "write_inventory", "read_locations", "read_orders", "read_customers"])]);
    const c = await buildSingleStoreCredential("client_credentials", { shop: "ada-shop.myshopify.com", client_id: "cid-1", client_secret: SECRET }, { fetchImpl: f.fetchImpl, resolve: publicResolve, now: () => NOW });
    assert.deepEqual(c.payload, {
      auth_mode: "client_credentials",
      shop: "ada-shop.myshopify.com",
      access_token: TOKEN.access_token,
      client_id: "cid-1",
      client_secret: SECRET,
      webhook_secret: SECRET,
      scope: TOKEN.scope,
    });
    assert.equal(c.expiresAt?.toISOString(), new Date(NOW + 86399_000).toISOString());
    assert.equal(c.label, "Ada's Shop (ada-shop.myshopify.com)");
    assert.deepEqual(c.warnings, []);
    // The probe uses the minted token in X-Shopify-Access-Token (not Bearer).
    const q = f.calls[1]!;
    assert.match(q.url.pathname, /^\/admin\/api\/\d{4}-\d{2}\/graphql\.json$/);
    assert.equal(q.headers["x-shopify-access-token"], TOKEN.access_token);
    assert.equal(q.headers.authorization, undefined);
    // The adapter reads it unchanged.
    const auth = shopifyAuthFrom({ kind: "oauth2", payload: c.payload });
    assert.deepEqual({ shop: auth?.shop, token: auth?.token }, { shop: "ada-shop.myshopify.com", token: TOKEN.access_token });
    assert.equal(singleStoreModeOf(c.payload), "client_credentials");
  });

  it("warns (doesn't refuse) when the app lacks scopes the sync needs", async () => {
    const f = scriptedFetch([jsonResponse(200, { ...TOKEN, scope: "read_products" }), probe(["read_products"])]);
    const c = await buildSingleStoreCredential("client_credentials", { shop: "ada-shop", client_id: "c", client_secret: "s" }, { fetchImpl: f.fetchImpl, resolve: publicResolve, now: () => NOW });
    assert.equal(c.warnings.length, 1);
    assert.match(c.warnings[0]!, /read_inventory.*write_inventory.*read_locations/);
  });

  it("renewal requests a new 24-hour token (there is no refresh token)", async () => {
    const f = scriptedFetch([jsonResponse(200, { ...TOKEN, access_token: "tok-2" })]);
    const prev = { auth_mode: "client_credentials", shop: "ada-shop.myshopify.com", access_token: "tok-1", client_id: "cid-1", client_secret: SECRET, webhook_secret: SECRET };
    const next = await renewSingleStoreCredential(prev, { fetchImpl: f.fetchImpl, resolve: publicResolve, now: () => NOW });
    assert.equal(next.payload.access_token, "tok-2");
    assert.equal(next.payload.webhook_secret, SECRET);
    assert.equal(next.expiresAt?.getTime(), NOW + 86399_000);
    assert.deepEqual(formOf(f.calls[0]!), { grant_type: "client_credentials", client_id: "cid-1", client_secret: SECRET });
  });
});

describe("an existing admin-created custom app's token", () => {
  it("validates the static token with the probe and keeps the optional webhook secret", async () => {
    const f = scriptedFetch([probe(["read_products", "read_inventory", "write_inventory", "read_locations", "read_orders", "read_customers"])]);
    const c = await buildSingleStoreCredential("admin_token", { shop: "ada-shop", access_token: "shpat_abc", webhook_secret: "api-secret-key" }, { fetchImpl: f.fetchImpl, resolve: publicResolve });
    assert.deepEqual(c.payload, { auth_mode: "admin_token", shop: "ada-shop.myshopify.com", access_token: "shpat_abc", webhook_secret: "api-secret-key" });
    assert.equal(c.expiresAt, null);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.headers["x-shopify-access-token"], "shpat_abc");
  });

  it("without the API secret key it connects but warns that webhooks will be refused", async () => {
    const f = scriptedFetch([probe(["read_products", "write_inventory", "read_locations", "read_orders", "read_customers"])]);
    const c = await buildSingleStoreCredential("admin_token", { shop: "ada-shop", access_token: "shpat_abc" }, { fetchImpl: f.fetchImpl, resolve: publicResolve });
    assert.equal("webhook_secret" in c.payload, false);
    assert.match(c.warnings.join(" "), /webhooks from this store will be refused/);
  });

  it("a rejected token fails the connect (nothing stored) and the renewal", async () => {
    const f = scriptedFetch([jsonResponse(401, { errors: "[API] Invalid API key or access token" })]);
    await assert.rejects(buildSingleStoreCredential("admin_token", { shop: "ada-shop", access_token: "shpat_bad" }, { fetchImpl: f.fetchImpl, resolve: publicResolve, maxRetries: 0 }), (e: unknown) => e instanceof ConnectorApiError && e.code === "auth_rejected");
    const g = scriptedFetch([jsonResponse(401, { errors: "[API] Invalid API key or access token" })]);
    await assert.rejects(renewSingleStoreCredential({ auth_mode: "admin_token", shop: "ada-shop.myshopify.com", access_token: "shpat_bad" }, { fetchImpl: g.fetchImpl, resolve: publicResolve, maxRetries: 0 }));
  });

  it("missingScopes: write implies read", () => {
    assert.deepEqual(missingScopes(["write_inventory", "read_products"], ["read_products", "read_inventory", "write_inventory", "read_orders"]), ["read_orders"]);
    assert.equal(singleStoreModeOf({ access_token: "x" }), null);
  });
});
