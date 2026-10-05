// ShapesOS Phase 15.1 — a workspace's own keys (Settings → Providers):
//   - a model key is validated with one call before it is saved (an invalid
//     key is never stored), stored ENCRYPTED in the vault, NEVER returned by
//     the API (or any list), and used by the router for that workspace only;
//   - a sidecar instance is SSRF-checked (https on hosted), stored, and used
//     only inside that workspace's sidecar scope — another workspace on
//     hosted is still refused the shared instance;
//   - a Smartlead / Instantly account comes from the workspace's vault;
//     hosted never falls back to the host env keys.
// Real routes (session stubbed with node:test mock.module) against Postgres
// as the app role; the provider validation endpoint is a FAKE fetch (MOCK);
// DNS is a fake resolver. Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… MARKETR_CREDENTIALS_KEY=… npx tsx --test --experimental-test-module-mocks lib/providers/__tests__/workspace-keys-db.test.ts

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

const RUN = randomUUID().slice(0, 8);
const WS = `p15wk-${RUN}`;
const WS_OTHER = `p15wk-o-${RUN}`;
const ADMIN = `p15wk-admin-${RUN}`;
const VIEWER = `p15wk-viewer-${RUN}`;
const SECRET = `sk-ant-p15-${RUN}-DO-NOT-LEAK`;

let actor = ADMIN;
mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => ({ id: actor, email: `${actor}@x.test` }),
    getOrCreateWorkspace: async () => prisma.workspace.findUniqueOrThrow({ where: { id: WS } }),
  },
});

// MOCK provider endpoints: the key check answers 200 for SECRET, 401 otherwise.
const realFetch = globalThis.fetch;
const seen: Array<{ url: string; key: string | null }> = [];
function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const h = new Headers(init?.headers);
  const key = h.get("x-api-key") ?? h.get("authorization")?.replace(/^Bearer /, "") ?? null;
  seen.push({ url, key });
  return Promise.resolve(new Response(key === SECRET || key === "sk-openai-ok" ? "{}" : '{"error":"x"}', { status: key === SECRET || key === "sk-openai-ok" ? 200 : 401 }));
}

type KeysRoute = typeof import("@/app/api/settings/keys/route");
type TestRoute = typeof import("@/app/api/settings/keys/test/route");
let keysRoute: KeysRoute;
let testRoute: TestRoute;

const req = (method: string, body?: unknown, qs = "") =>
  new NextRequest(`http://local.test/api/settings/keys${qs}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) as never;

before(async () => {
  globalThis.fetch = fakeFetch as typeof fetch;
  keysRoute = await import("@/app/api/settings/keys/route");
  testRoute = await import("@/app/api/settings/keys/test/route");
  for (const id of [WS, WS_OTHER]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: ADMIN, plan: "starter" } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: ADMIN, role: "admin" } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: VIEWER, role: "viewer" } });
});

after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.DEPLOYMENT_MODE;
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_OTHER] } } });
  await prisma.$disconnect();
});

describe("workspace model keys (BYOK)", () => {
  it("an invalid key is checked with one call and never saved", async () => {
    actor = ADMIN;
    const res = await keysRoute.POST(req("POST", { id: "model:anthropic", values: { apiKey: "sk-ant-wrong" } }));
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /rejected the key/);
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /^https:\/\/api\.anthropic\.com\/v1\/models/);
    assert.equal(await prisma.connectorConnection.count({ where: { workspaceId: WS, connectorKey: "byok-anthropic" } }), 0);
  });

  it("a valid key is stored encrypted and never returned by the API", async () => {
    const res = await keysRoute.POST(req("POST", { id: "model:anthropic", values: { apiKey: SECRET } }));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(SECRET), "POST response never echoes the key");
    const conn = await prisma.connectorConnection.findFirstOrThrow({ where: { workspaceId: WS, connectorKey: "byok-anthropic" } });
    const cred = await prisma.connectorCredential.findUniqueOrThrow({ where: { connectionId: conn.id } });
    assert.ok(!cred.encryptedBlob.includes(SECRET) && !cred.encryptedBlob.includes(`p15-${RUN}`), "stored encrypted, not plaintext");
    const get = await keysRoute.GET();
    const body = await get.text();
    assert.ok(!body.includes(SECRET), "GET never returns the key");
    const parsed = JSON.parse(body) as { credentials: Array<{ id: string; connected: boolean; fields: Array<{ secret: boolean; value: string | null }> }> };
    const view = parsed.credentials.find((c) => c.id === "model:anthropic")!;
    assert.equal(view.connected, true);
    assert.ok(view.fields.filter((f) => f.secret).every((f) => f.value === null));
    const audit = await prisma.fileChangeLog.count({ where: { workspaceId: WS, action: "credential_created" } });
    assert.ok(audit >= 1, "audited");
  });

  it("the router uses it for this workspace only (keySource workspace → 0 credits)", async () => {
    const { __clearWorkspaceModelKeyCache, loadWorkspaceModelKeys } = await import("@/lib/llm/workspace-keys");
    __clearWorkspaceModelKeyCache();
    assert.equal((await loadWorkspaceModelKeys(WS)).anthropic, SECRET);
    assert.deepEqual(await loadWorkspaceModelKeys(WS_OTHER), {});
    const { getLlmProviderForWorkspace } = await import("@/lib/llm/workspace");
    const mine = await getLlmProviderForWorkspace("lead", { workspaceId: WS });
    assert.equal(mine.isLive, true);
    assert.equal(mine.keySource, "workspace");
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const theirs = await getLlmProviderForWorkspace("lead", { workspaceId: WS_OTHER });
      assert.notEqual(theirs.keySource, "workspace", "another workspace never gets this key");
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("Test re-checks the stored key server-side; viewers are refused", async () => {
    const t = await testRoute.POST(new Request("http://local.test/api/settings/keys/test", { method: "POST", body: JSON.stringify({ id: "model:anthropic" }) }) as never);
    const tj = await t.json();
    assert.equal(tj.ok, true);
    assert.equal(seen[seen.length - 1].key, SECRET, "the stored key went only to the provider check");
    actor = VIEWER;
    assert.equal((await keysRoute.GET()).status, 403);
    assert.equal((await keysRoute.POST(req("POST", { id: "model:openai", values: { apiKey: "sk-openai-ok" } }))).status, 403);
    actor = ADMIN;
  });

  it("remove deletes it and the router stops using it at once", async () => {
    const res = await keysRoute.DELETE(req("DELETE", undefined, "?id=model:anthropic") as never);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).removed, 1);
    const { loadWorkspaceModelKeys } = await import("@/lib/llm/workspace-keys");
    assert.deepEqual(await loadWorkspaceModelKeys(WS), {});
    assert.equal(await prisma.connectorConnection.count({ where: { workspaceId: WS, connectorKey: "byok-anthropic" } }), 0);
  });
});

describe("a workspace's own sidecar instance", () => {
  const publicDns = async () => ["93.184.216.34"];
  const privateDns = async () => ["10.0.0.7"];

  it("is SSRF-checked before it is saved, and https is required on hosted", async () => {
    const { saveWorkspaceCredential } = await import("../workspace-credentials-server");
    await assert.rejects(
      saveWorkspaceCredential({ workspaceId: WS, userId: ADMIN, id: "sidecar:postiz", values: { url: "https://postiz.internal.example", apiKey: "pk" } }, { resolve: privateDns }),
      /disallowed address|not allowed/,
    );
    process.env.DEPLOYMENT_MODE = "hosted";
    await assert.rejects(
      saveWorkspaceCredential({ workspaceId: WS, userId: ADMIN, id: "sidecar:postiz", values: { url: "http://postiz.acme.example", apiKey: "pk" } }, { resolve: publicDns }),
      /https/,
    );
    await saveWorkspaceCredential(
      { workspaceId: WS, userId: ADMIN, id: "sidecar:postiz", values: { url: "https://postiz.acme.example/", apiKey: "acme-postiz-key" } },
      { resolve: publicDns },
    );
  });

  it("is used inside that workspace's scope only; another workspace is refused the shared instance on hosted", async () => {
    process.env.DEPLOYMENT_MODE = "hosted";
    const prevUrl = process.env.POSTIZ_URL;
    const prevKey = process.env.POSTIZ_API_KEY;
    process.env.POSTIZ_URL = "https://shared-postiz.example";
    process.env.POSTIZ_API_KEY = "shared-key";
    try {
      const { withWorkspaceSidecars } = await import("@/lib/integrations/sidecar-tenancy");
      const { getPostizConfig, postizStatus } = await import("@/lib/integrations/postiz");
      const mine = await withWorkspaceSidecars(WS, () => getPostizConfig());
      assert.deepEqual(mine, { url: "https://postiz.acme.example", apiKey: "acme-postiz-key" });
      const theirs = await withWorkspaceSidecars(WS_OTHER, () => postizStatus());
      assert.equal(theirs.configured, false, "hosted: the shared Postiz is refused");
      delete process.env.DEPLOYMENT_MODE;
      const selfHosted = await withWorkspaceSidecars(WS_OTHER, () => getPostizConfig());
      assert.equal(selfHosted.url, "https://shared-postiz.example", "self-hosted keeps env");
    } finally {
      if (prevUrl === undefined) delete process.env.POSTIZ_URL;
      else process.env.POSTIZ_URL = prevUrl;
      if (prevKey === undefined) delete process.env.POSTIZ_API_KEY;
      else process.env.POSTIZ_API_KEY = prevKey;
    }
    const get = await (await keysRoute.GET()).text();
    assert.ok(get.includes("https://postiz.acme.example"), "the (non-secret) URL is shown");
    assert.ok(!get.includes("acme-postiz-key"), "the key is not");
  });
});

describe("Smartlead / Instantly from the workspace's vault", () => {
  it("the workspace's own account is used; hosted never falls back to the host env keys", async () => {
    const res = await keysRoute.POST(req("POST", { id: "outreach:smartlead", values: { apiKey: "ws-smartlead-key", relayCampaignIds: "11, 12 ,13" } }));
    assert.equal(res.status, 200);
    const { loadOutreachAccounts, outreachPartnerConfig } = await import("@/lib/authority/outreach/partner-config");
    const env = { SMARTLEAD_API_KEY: "host-key", SMARTLEAD_RELAY_CAMPAIGN_IDS: "9" };
    const mine = outreachPartnerConfig({ workspace: await loadOutreachAccounts(WS), env, mode: "hosted" });
    assert.deepEqual(mine, { provider: "smartlead", apiKey: "ws-smartlead-key", relayCampaignIds: "11,12,13", source: "workspace" });
    const other = outreachPartnerConfig({ workspace: await loadOutreachAccounts(WS_OTHER), env, mode: "hosted" });
    assert.equal(other.source, "none");
    assert.equal(other.apiKey, null);
    const { sendingPartner } = await import("@/app/api/authority/outreach/_stores");
    const partner = await sendingPartner(WS);
    assert.equal(partner.name, "smartlead", "the live adapter, on the workspace's key");
  });
});
