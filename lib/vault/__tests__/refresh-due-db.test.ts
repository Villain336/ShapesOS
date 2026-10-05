// Phase 14: the connector refresh sweep (cron /api/cron/connector-refresh) on
// real Postgres. Regression for the bug where every API-key connection and
// every non-expiring OAuth token without a refresh token matched the "stale"
// branch and was flipped to needs_reauth on the first tick after connecting.
//   1. API key, no expiry           → skipped, stays active, credential untouched;
//   2. OAuth token, no expiry, no refresh token → skipped, stays active;
//   3. OAuth token, no expiry, WITH a refresh token → refreshed (FAKE token endpoint);
//   4. expiring token without a refresh token → needs_reauth (unchanged: it really expires).
// The sweep is limited to this test's workspace so other suites' rows are never touched.
// Listed in scripts/test/db-tests.txt.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import { getDecryptedCredential } from "../refresh";
import { refreshDueConnections } from "../refresh-due";

process.env.MARKETR_CREDENTIALS_KEY ??= "b".repeat(64);
const RUN = `p14rd-${Date.now().toString(36)}`;
const WS = `${RUN}-a`;
const USER = `${RUN}-user`;

let tokenCalls = 0;
/** FAKE HubSpot token endpoint (tests only). */
const fakeToken = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  assert.equal(url, "https://api.hubapi.com/oauth/v1/token");
  const form = new URLSearchParams(String(init?.body));
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "hub-refresh");
  tokenCalls += 1;
  return new Response(JSON.stringify({ access_token: "hub-access-2", refresh_token: "hub-refresh", expires_in: 1800 }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

async function connection(connectorKey: string, payload: Record<string, unknown>, expiresAt: Date | null) {
  const conn = await prisma.connectorConnection.create({ data: { workspaceId: WS, userId: USER, connectorKey, status: "active", scopes: [], meta: {} } });
  await prisma.connectorCredential.create({ data: { connectionId: conn.id, encryptedBlob: secrets().encrypt(JSON.stringify(payload)), keyVersion: "env-v1", expiresAt } });
  return conn.id;
}
const statusOf = async (id: string) => (await prisma.connectorConnection.findUniqueOrThrow({ where: { id } })).status;

let apiKeyConn = "";
let staticOauthConn = "";
let refreshableConn = "";
let expiringConn = "";

before(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${WS}, ${WS}, ${USER}, now())`;
  apiKeyConn = await connection("resend", { apiKey: "re_test_key" }, null);
  staticOauthConn = await connection("notion", { access_token: "notion-forever" }, null);
  refreshableConn = await connection("hubspot", { access_token: "hub-access-1", refresh_token: "hub-refresh", client_id: "cid", client_secret: "csecret" }, null);
  expiringConn = await connection("linear", { access_token: "linear-short" }, new Date(Date.now() + 60_000));
});

after(async () => {
  await prisma.connectorConnection.deleteMany({ where: { workspaceId: WS } });
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$disconnect();
});

describe("connector refresh sweep", () => {
  it("leaves API keys and non-expiring tokens alone, refreshes what can be renewed", async () => {
    const r = await refreshDueConnections({ workspaceId: WS, deps: { fetchImpl: fakeToken } });
    assert.deepEqual(r.errors, []);
    assert.equal(r.checked, 4);
    assert.equal(r.skipped, 2, "the API key and the non-expiring token are skipped");
    assert.equal(r.refreshed, 1);
    assert.equal(r.needsReauth, 1);

    assert.equal(await statusOf(apiKeyConn), "active", "an API-key connection is never marked needs_reauth by the sweep");
    assert.equal((await getDecryptedCredential(apiKeyConn))?.payload.apiKey, "re_test_key");
    assert.equal(await statusOf(staticOauthConn), "active", "a non-expiring OAuth token stays active");

    assert.equal(tokenCalls, 1);
    assert.equal(await statusOf(refreshableConn), "active");
    assert.equal((await getDecryptedCredential(refreshableConn))?.payload.access_token, "hub-access-2");

    assert.equal(await statusOf(expiringConn), "needs_reauth", "an expiring token with no refresh token still asks to reconnect");
  });

  it("a second sweep is a no-op for the skipped connections", async () => {
    const r = await refreshDueConnections({ workspaceId: WS, deps: { fetchImpl: fakeToken } });
    assert.equal(r.skipped, 2);
    assert.equal(r.refreshed, 0, "the refreshed token now has an expiry well outside the window");
    assert.equal(await statusOf(apiKeyConn), "active");
    assert.equal(await statusOf(staticOauthConn), "active");
  });
});
