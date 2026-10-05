// Phase 14 (connectors): Shopify single-store connection on real Postgres
// (app role) against a labelled FAKE Shopify (token endpoint + Admin GraphQL,
// documented shapes; live Shopify is UNVERIFIED-LIVE):
//   1. connect (client credentials grant) stores { shop, access_token,
//      webhook_secret } encrypted, points the Tier-W connector's
//      webhookSecretRef at the connection, and the adapter uses the token;
//   2. webhooks verify with the per-connection secret — NOT the hosted app's
//      SHOPIFY_CLIENT_SECRET;
//   3. an expired 24-hour token is renewed with the client credentials;
//   4. app/uninstalled revokes the connection, stops ingest (410), is
//      idempotent, and ignores another store's uninstall;
//   5. an admin-created app token without its API secret key: webhooks are
//      refused honestly (503), never verified with the hosted app secret.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… MARKETR_CREDENTIALS_KEY=… npx tsx --test lib/bizsync/__tests__/shopify-single-store-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope as graphScope } from "@/lib/substrate/graph/rls";
import { publicResolve } from "@/lib/connectors/m21/live/__tests__/fixtures";
import { connectShopifySingleStore } from "../shopify/single-store";
import { handleShopifyAppUninstalled } from "../shopify/uninstall";
import { getDecryptedCredential } from "@/lib/vault/refresh";
import { loadLiveCredential } from "@/lib/connectors/m21/live/credentials";
import { ShopifyAdapter } from "@/lib/connectors/m21/native/shopify";
import { resolveWebhookSecret, verifyTierWWebhook } from "@/lib/substrate/graph/connectors/tierw";

process.env.MARKETR_CREDENTIALS_KEY ??= "b".repeat(64);
const RUN = `p14ss-${Date.now().toString(36)}`;
const WS = `${RUN}-a`;
const USER = `${RUN}-user`;
const SHOP = "ada-shop.myshopify.com";
const CLIENT_SECRET = "dev-dashboard-client-secret";
const HOSTED_APP_SECRET = "hosted-app-secret-must-not-verify";

let minted = 0;
/** FAKE Shopify (tests only): token endpoint + the probe and locations queries. */
const fakeShopify = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  assert.equal(url.host, SHOP);
  if (url.pathname === "/admin/oauth/access_token") {
    const form = new URLSearchParams(String(init?.body));
    if (form.get("grant_type") !== "client_credentials" || form.get("client_secret") !== CLIENT_SECRET) return json({ error: "invalid_client" }, 401);
    minted += 1;
    return json({ access_token: `cc-token-${minted}`, scope: "read_products,write_inventory,read_locations,read_orders,read_customers", expires_in: 86399 });
  }
  const token = new Headers(init?.headers).get("x-shopify-access-token") ?? "";
  if (!/^cc-token-\d+$|^shpat_/.test(token)) return json({ errors: "[API] Invalid API key or access token" }, 401);
  const { query } = JSON.parse(String(init?.body)) as { query: string };
  if (query.includes("ShapesProbe")) {
    return json({ data: { shop: { name: "Ada's Shop", myshopifyDomain: SHOP }, currentAppInstallation: { accessScopes: ["read_products", "write_inventory", "read_locations", "read_orders", "read_customers"].map((handle) => ({ handle })) } } });
  }
  if (query.includes("locations(")) return json({ data: { locations: { nodes: [{ id: "gid://shopify/Location/9", name: "Main store", isActive: true }], pageInfo: { hasNextPage: false, endCursor: null } } } });
  return json({ errors: [{ message: `unexpected query ${query.slice(0, 40)}` }] });
}) as typeof fetch;
const deps = { fetchImpl: fakeShopify, resolve: publicResolve };

const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body, "utf8").digest("base64");
const graphConnector = () => graphScope(WS, (tx) => tx.graphConnector.findUniqueOrThrow({ where: { workspaceId_platform: { workspaceId: WS, platform: "shopify" } } }));
async function verify(secret: string, id: string) {
  const body = JSON.stringify({ id: 1, name: "#1001" });
  return verifyTierWWebhook({
    platform: "shopify",
    connector: await graphConnector(),
    method: "POST",
    uri: `/api/substrate/graph/webhooks/shopify?workspaceId=${WS}`,
    headers: { "x-shopify-hmac-sha256": sign(secret, body), "x-shopify-webhook-id": `${RUN}-${id}` },
    rawBody: body,
  });
}

let connectionId = "";

before(async () => {
  process.env.SHOPIFY_CLIENT_SECRET = HOSTED_APP_SECRET;
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${WS}, ${WS}, ${USER}, now())`;
});

after(async () => {
  delete process.env.SHOPIFY_CLIENT_SECRET;
  await prisma.connectorConnection.deleteMany({ where: { workspaceId: WS } });
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$disconnect();
});

describe("Shopify single-store connection", () => {
  it("connect stores { shop, access_token, webhook_secret } encrypted and wires the per-connection secret", async () => {
    const r = await connectShopifySingleStore({ userId: USER, workspaceId: WS, mode: "client_credentials", values: { shop: SHOP, client_id: "cid-1", client_secret: CLIENT_SECRET } }, deps);
    connectionId = r.connection.id;
    assert.deepEqual(r.warnings, []);
    assert.equal(r.connection.status, "active");
    assert.deepEqual(r.connection.meta, { label: `Ada's Shop (${SHOP})`, shop: SHOP, authMode: "client_credentials" });
    const raw = await prisma.connectorCredential.findUniqueOrThrow({ where: { connectionId } });
    assert.ok(!raw.encryptedBlob.includes(CLIENT_SECRET) && !raw.encryptedBlob.includes("cc-token-1"), "stored encrypted");
    assert.ok(raw.expiresAt && raw.expiresAt.getTime() > Date.now() + 23 * 3600_000);
    const cred = await getDecryptedCredential(connectionId);
    assert.equal(cred?.kind, "oauth2");
    assert.equal(cred?.payload.access_token, "cc-token-1");
    assert.equal(cred?.payload.shop, SHOP);
    assert.equal(cred?.payload.webhook_secret, CLIENT_SECRET);
    const gc = await graphConnector();
    assert.equal(gc.authRef, connectionId);
    assert.equal(gc.webhookSecretRef, connectionId);
    assert.equal(gc.status, "connected");
  });

  it("the adapter uses the stored token unchanged", async () => {
    const live = await loadLiveCredential(connectionId, deps);
    const res = await new ShopifyAdapter(deps).invoke("list_locations", {}, live.credential, { workspaceId: WS, userId: USER, refreshCredential: live.refreshCredential });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.mock, false);
    assert.deepEqual(res.data, [{ id: "gid://shopify/Location/9", name: "Main store", active: true, opsLocationId: null }]);
  });

  it("webhooks verify with the connection's own secret, never the hosted app's", async () => {
    const s = await resolveWebhookSecret(await graphConnector());
    assert.deepEqual(s, { secret: CLIENT_SECRET, mode: "vault" });
    assert.deepEqual(await verify(CLIENT_SECRET, "ok"), { ok: true });
    const wrong = await verify(HOSTED_APP_SECRET, "hosted");
    assert.equal(wrong.ok, false);
    assert.equal((wrong as { status: number }).status, 401);
  });

  it("an expired 24-hour token is renewed with the client credentials before use", async () => {
    await prisma.connectorCredential.update({ where: { connectionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const before = minted;
    const live = await loadLiveCredential(connectionId, deps);
    assert.equal(minted, before + 1);
    assert.equal(live.credential?.payload.access_token, `cc-token-${minted}`);
    const row = await prisma.connectorCredential.findUniqueOrThrow({ where: { connectionId } });
    assert.ok(row.expiresAt!.getTime() > Date.now() + 23 * 3600_000);
    const conn = await prisma.connectorConnection.findUniqueOrThrow({ where: { id: connectionId } });
    assert.equal(conn.status, "active");
    assert.ok(conn.lastRefreshAt);
  });

  it("another store's app/uninstalled changes nothing", async () => {
    const r = await handleShopifyAppUninstalled(WS, await graphConnector(), "other-shop.myshopify.com", { id: 2, name: "Other" });
    assert.equal(r.applied, false);
    assert.equal((await prisma.connectorConnection.findUniqueOrThrow({ where: { id: connectionId } })).status, "active");
  });

  it("app/uninstalled revokes the connection and stops ingest (410), once", async () => {
    // The documented sample body has myshopify_domain null; the header names the store.
    const r = await handleShopifyAppUninstalled(WS, await graphConnector(), SHOP, { id: 548380009, name: "Super Toys", myshopify_domain: null, domain: null });
    assert.equal(r.applied, true);
    assert.equal(r.revoked, 1);
    assert.equal((await prisma.connectorConnection.findUniqueOrThrow({ where: { id: connectionId } })).status, "revoked");
    assert.equal((await graphConnector()).status, "revoked");
    const after = await verify(CLIENT_SECRET, "after-uninstall");
    assert.deepEqual(after, { ok: false, status: 410, detail: "connector revoked — ingest stopped, history kept" });
    const again = await handleShopifyAppUninstalled(WS, await graphConnector(), SHOP, {});
    assert.equal(again.applied, false);
    const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
    const runs = await withWorkspaceScope(WS, (tx) => tx.bizSyncRun.findMany({ where: { workspaceId: WS, operation: "app_uninstalled" } }));
    assert.equal(runs.length, 1);
    // A revoked connection is not silently re-activated by the token refresher.
    const { refreshConnection } = await import("@/lib/vault/refresh");
    assert.equal(await refreshConnection(connectionId, deps), "needs_reauth");
    assert.equal((await prisma.connectorConnection.findUniqueOrThrow({ where: { id: connectionId } })).status, "revoked");
  });

  it("reconnecting with an existing app's token but no API secret key: webhooks fail honestly (503)", async () => {
    const r = await connectShopifySingleStore({ userId: USER, workspaceId: WS, mode: "admin_token", values: { shop: SHOP, access_token: "shpat_legacy" } }, deps);
    assert.equal(r.connection.id, connectionId, "same connection row is reused");
    assert.match(r.warnings.join(" "), /webhooks from this store will be refused/);
    const gc = await graphConnector();
    assert.equal(gc.status, "connected");
    assert.equal(gc.webhookSecretRef, connectionId);
    const res = await verify(HOSTED_APP_SECRET, "no-secret");
    assert.equal(res.ok, false);
    assert.equal((res as { status: number }).status, 503);
    const cred = await getDecryptedCredential(connectionId);
    assert.deepEqual(cred?.payload, { auth_mode: "admin_token", shop: SHOP, access_token: "shpat_legacy" });
  });
});
