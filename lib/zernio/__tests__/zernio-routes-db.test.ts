// Phase 15.4 (zernio): the /api/zernio routes (session stubbed with
// node:test mock.module), against the labelled FAKE Zernio (NOT Zernio):
//   GET  /api/zernio            viewer+; never creates a profile on a read
//   POST /api/zernio/connect    admin+; creates the profile on first use and
//                               returns Zernio's hosted connect URL
//   GET  /api/zernio/callback   only for the user the state was signed for,
//                               an admin of that workspace; records only an
//                               account Zernio lists on that profile
//   POST /api/zernio/openai-ads admin+; the customer's key goes to Zernio
//   POST /api/zernio/projects   admin+; binds the connection to every project
//   POST /api/cron/zernio-accounts  no live key → skipped, nothing charged
// Run: DATABASE_URL=… npx tsx --test --experimental-test-module-mocks \
//        lib/zernio/__tests__/zernio-routes-db.test.ts

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { FakeZernio } from "../fake";
import { clientForFake, setZernioClientForTests } from "../config";

process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");
process.env.AUTH_SECRET ||= "zernio-routes-test-secret";

const RUN = randomUUID().slice(0, 8);
const WS = `p154r${RUN}`;
const WS2 = `p154r2${RUN}`;
const OWNER = `p154r-owner-${RUN}`;
const VIEWER = `p154r-viewer-${RUN}`;
const OUTSIDER = `p154r-out-${RUN}`;

let actor: { id: string; email: string } | null = { id: OWNER, email: "owner@zernio.test" };
let currentWs = WS;

mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => actor,
    getOrCreateWorkspace: async () => prisma.workspace.findUniqueOrThrow({ where: { id: currentWs } }),
  },
});

const fake = new FakeZernio();

type R = {
  status: typeof import("@/app/api/zernio/route");
  connect: typeof import("@/app/api/zernio/connect/route");
  callback: typeof import("@/app/api/zernio/callback/route");
  openai: typeof import("@/app/api/zernio/openai-ads/route");
  projects: typeof import("@/app/api/zernio/projects/route");
  cron: typeof import("@/app/api/cron/zernio-accounts/route");
};
let r: R;

const ORIGIN = "http://localhost:3000";
const json = (path: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const as = (id: string) => {
  actor = { id, email: `${id}@zernio.test` };
};

before(async () => {
  setZernioClientForTests(clientForFake(fake));
  r = {
    status: await import("@/app/api/zernio/route"),
    connect: await import("@/app/api/zernio/connect/route"),
    callback: await import("@/app/api/zernio/callback/route"),
    openai: await import("@/app/api/zernio/openai-ads/route"),
    projects: await import("@/app/api/zernio/projects/route"),
    cron: await import("@/app/api/cron/zernio-accounts/route"),
  };
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER, plan: "pro" } });
  await prisma.workspace.create({ data: { id: WS2, name: WS2, ownerUserId: OUTSIDER, plan: "pro" } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: OWNER, role: "owner" },
      { workspaceId: WS, userId: VIEWER, role: "viewer" },
      { workspaceId: WS2, userId: OUTSIDER, role: "owner" },
    ],
  });
  await prisma.project.create({ data: { workspaceId: WS, domain: `${RUN}.example` } });
});

after(async () => {
  setZernioClientForTests(null);
  for (const id of [WS, WS2]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("/api/zernio routes", () => {
  let authUrl = "";

  it("GET: a viewer sees the card data; a read never creates a profile", async () => {
    as(VIEWER);
    const res = await r.status.GET(new NextRequest(`${ORIGIN}/api/zernio?workspaceId=${WS}`));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, "mock");
    assert.equal(body.profileId, null);
    assert.equal(body.platforms.length, 16);
    assert.equal(body.adNetworks.length, 7);
    assert.equal(fake.callsOf("createProfile").length, 0);
    as(OUTSIDER);
    assert.equal((await r.status.GET(new NextRequest(`${ORIGIN}/api/zernio?workspaceId=${WS}`))).status, 404, "another workspace's user");
  });

  it("connect: viewers are refused; an admin gets Zernio's connect URL for this workspace's profile", async () => {
    as(VIEWER);
    assert.equal((await r.connect.POST(json("/api/zernio/connect", { workspaceId: WS, kind: "social", platform: "linkedin" }))).status, 403);
    as(OWNER);
    const bad = await r.connect.POST(json("/api/zernio/connect", { workspaceId: WS, kind: "social", platform: "myspace" }));
    assert.equal(bad.status, 400);
    const res = await r.connect.POST(json("/api/zernio/connect", { workspaceId: WS, kind: "social", platform: "linkedin" }));
    assert.equal(res.status, 200);
    authUrl = (await res.json()).authUrl;
    const u = new URL(authUrl);
    assert.equal(u.origin + u.pathname, `${ORIGIN}/api/zernio/callback`);
    assert.ok(u.searchParams.get("s"));
    assert.equal(fake.callsOf("createProfile").length, 1);
    const xNoAccount = await r.connect.POST(json("/api/zernio/connect", { workspaceId: WS, kind: "ads", platform: "x" }));
    assert.equal(xNoAccount.status, 400, "X Ads needs one of this workspace's X accounts");
  });

  it("callback: another user with the same link is refused and nothing is recorded", async () => {
    as(OUTSIDER);
    const res = await r.callback.GET(new NextRequest(authUrl));
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /zernio_error=/);
    const count = await withWorkspaceScope(WS, (tx) => tx.zernioAccount.count({ where: { workspaceId: WS } }));
    assert.equal(count, 0);
  });

  it("callback: the user who started it records the account; a crafted accountId from another profile is refused", async () => {
    as(OWNER);
    const res = await r.callback.GET(new NextRequest(authUrl));
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("location")!);
    assert.equal(loc.pathname, "/dashboard/settings/connectors");
    assert.match(loc.searchParams.get("zernio") ?? "", /Connected LinkedIn/);
    const rows = await withWorkspaceScope(WS, (tx) => tx.zernioAccount.findMany({ where: { workspaceId: WS } }));
    assert.equal(rows.length, 1);
    // Someone else's account on another profile, pasted into a valid link.
    const other = await fake.fetch("https://zernio.com/api/v1/profiles", {
      method: "POST", headers: { Authorization: "Bearer x", "content-type": "application/json" }, body: JSON.stringify({ name: `other-${RUN}` }),
    });
    const otherProfile = (await other.json()).profile._id as string;
    const foreign = fake.connectAccount(otherProfile, "tiktok");
    const crafted = new URL(authUrl);
    crafted.searchParams.set("accountId", foreign._id);
    crafted.searchParams.delete("profileId");
    const res2 = await r.callback.GET(new NextRequest(crafted.toString()));
    assert.match(res2.headers.get("location") ?? "", /zernio_error=/);
    assert.equal(await withWorkspaceScope(WS, (tx) => tx.zernioAccount.count({ where: { workspaceId: WS } })), 1);
    const audit = await prisma.fileChangeLog.count({ where: { workspaceId: WS, action: "zernio_account_connected" } });
    assert.equal(audit, 1);
  });

  it("OpenAI Ads: the key is passed to Zernio for this profile and never stored", async () => {
    as(OWNER);
    const ok = await r.openai.POST(json("/api/zernio/openai-ads", { workspaceId: WS, apiKey: "sk-ads-test-123456" }));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).account.platform, "openaiads");
    const stored = await prisma.connectorCredential.count({ where: { connection: { workspaceId: WS } } });
    assert.equal(stored, 0);
    const rejected = await r.openai.POST(json("/api/zernio/openai-ads", { workspaceId: WS, apiKey: "not-a-valid-key" }));
    assert.equal(rejected.status, 502);
    assert.doesNotMatch(JSON.stringify(await rejected.json()), /not-a-valid-key/);
  });

  it("projects: an admin turns Zernio on for every project (idempotent); viewers cannot", async () => {
    as(VIEWER);
    assert.equal((await r.projects.POST(json("/api/zernio/projects", { workspaceId: WS }))).status, 403);
    as(OWNER);
    const res = await r.projects.POST(json("/api/zernio/projects", { workspaceId: WS }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).bound, 1);
    await r.projects.POST(json("/api/zernio/projects", { workspaceId: WS }));
    assert.equal(await prisma.projectDataSource.count({ where: { connectorKey: "zernio", project: { workspaceId: WS } } }), 1);
  });

  it("GET after connecting lists the workspace's accounts with health", async () => {
    as(VIEWER);
    const body = await (await r.status.GET(new NextRequest(`${ORIGIN}/api/zernio?workspaceId=${WS}`))).json();
    assert.ok(body.profileId);
    assert.deepEqual(body.accounts.map((a: { platform: string }) => a.platform).sort(), ["linkedin", "openaiads"]);
    assert.ok(body.accounts.every((a: { health: string }) => a.health === "healthy"));
  });

  it("the monthly metering cron does nothing without a live key (the fake is never billed)", async () => {
    as(OWNER);
    currentWs = WS;
    const res = await r.cron.POST(new NextRequest(`${ORIGIN}/api/cron/zernio-accounts`, { method: "POST" }));
    assert.equal(res.status, 200);
    assert.match((await res.json()).skipped ?? "", /ZERNIO_API_KEY/);
    assert.equal(await prisma.usageEvent.count({ where: { workspaceId: WS, action: "zernio_account_month" } }), 0);
  });
});
