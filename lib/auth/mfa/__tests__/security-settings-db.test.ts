// ShapesOS Phase 4a — DB test: workspace security settings routes.
//   - require-2FA policy: owners only; turning it on needs the owner's own
//     session to have passed a second factor; audited
//   - SCIM tokens: owners only; raw token returned once, only the hash stored;
//     revoke; another workspace's token id is 404
// The session is stubbed with node:test mock.module.
// Run: DATABASE_URL=… npx tsx --test --experimental-test-module-mocks \
//        lib/auth/mfa/__tests__/security-settings-db.test.ts

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { hashScimToken } from "@/lib/scim/auth";
import { __setSessionMfaStateForTests } from "../policy";

const RUN = randomUUID().slice(0, 8);
const WS = `p4sec${RUN}`;
const WS2 = `p4sec2${RUN}`;
const OWNER = `p4sec-owner-${RUN}`;
const ADMIN = `p4sec-admin-${RUN}`;

let actor: { id: string; email: string; twoFactor?: boolean } = { id: OWNER, email: "owner@sec.test" };
let currentWs = WS;

mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => actor,
    getOrCreateWorkspace: async () => prisma.workspace.findUniqueOrThrow({ where: { id: currentWs } }),
  },
});

type PolicyRoute = typeof import("@/app/api/settings/security/policy/route");
type TokensRoute = typeof import("@/app/api/settings/security/scim-tokens/route");
type TokenRoute = typeof import("@/app/api/settings/security/scim-tokens/[id]/route");
let policy: PolicyRoute;
let tokens: TokensRoute;
let token: TokenRoute;

const body = (method: string, b?: unknown) =>
  new Request("http://localhost:3000/api/x", {
    method,
    headers: { "content-type": "application/json" },
    body: b === undefined ? undefined : JSON.stringify(b),
  });

before(async () => {
  policy = await import("@/app/api/settings/security/policy/route");
  tokens = await import("@/app/api/settings/security/scim-tokens/route");
  token = await import("@/app/api/settings/security/scim-tokens/[id]/route");
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER } });
  await prisma.workspace.create({ data: { id: WS2, name: WS2, ownerUserId: OWNER } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: OWNER, role: "owner" },
      { workspaceId: WS, userId: ADMIN, role: "admin" },
      { workspaceId: WS2, userId: OWNER, role: "owner" },
    ],
  });
});

after(async () => {
  __setSessionMfaStateForTests(undefined);
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS2] } } });
  await prisma.$disconnect();
});

describe("require-2FA policy route", () => {
  it("admins can read but not change it", async () => {
    actor = { id: ADMIN, email: "admin@sec.test", twoFactor: true };
    __setSessionMfaStateForTests({ userId: ADMIN, twoFactor: true });
    const get = await policy.GET();
    assert.equal(get.status, 200);
    const data = await get.json();
    assert.equal(data.requireTwoFactor, false);
    assert.equal(data.canEdit, false);
    assert.deepEqual(data.members, { total: 2, withoutTwoFactor: 2 });
    assert.equal((await policy.PUT(body("PUT", { requireTwoFactor: true }))).status, 403);
  });

  it("an owner without a second factor this session can't turn it on", async () => {
    actor = { id: OWNER, email: "owner@sec.test", twoFactor: false };
    __setSessionMfaStateForTests({ userId: OWNER, twoFactor: false });
    const res = await policy.PUT(body("PUT", { requireTwoFactor: true }));
    assert.equal(res.status, 409);
    assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: WS } })).requireTwoFactor, false);
  });

  it("an owner with a second factor turns it on (audited) and off", async () => {
    actor = { id: OWNER, email: "owner@sec.test", twoFactor: true };
    __setSessionMfaStateForTests({ userId: OWNER, twoFactor: true });
    assert.equal((await policy.PUT(body("PUT", { requireTwoFactor: true }))).status, 200);
    assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: WS } })).requireTwoFactor, true);
    const audit = await prisma.fileChangeLog.findFirst({ where: { workspaceId: WS, action: "security_policy_updated" } });
    assert.match(audit?.summary ?? "", /turned on/);
    // With the policy on, the admin's session without 2FA loses access.
    actor = { id: ADMIN, email: "admin@sec.test", twoFactor: false };
    __setSessionMfaStateForTests({ userId: ADMIN, twoFactor: false });
    assert.equal((await policy.GET()).status, 403);
    actor = { id: OWNER, email: "owner@sec.test", twoFactor: true };
    __setSessionMfaStateForTests({ userId: OWNER, twoFactor: true });
    assert.equal((await policy.PUT(body("PUT", { requireTwoFactor: false }))).status, 200);
    assert.equal((await policy.PUT(body("PUT", { requireTwoFactor: "yes" }))).status, 400);
  });
});

describe("SCIM token routes", () => {
  it("admins can't manage tokens", async () => {
    actor = { id: ADMIN, email: "admin@sec.test", twoFactor: true };
    __setSessionMfaStateForTests({ userId: ADMIN, twoFactor: true });
    assert.equal((await tokens.GET(body("GET"))).status, 403);
    assert.equal((await tokens.POST(body("POST", { name: "Okta" }))).status, 403);
  });

  it("owner creates (raw once, hash stored), lists, and revokes", async () => {
    actor = { id: OWNER, email: "owner@sec.test", twoFactor: true };
    __setSessionMfaStateForTests({ userId: OWNER, twoFactor: true });
    const created = await tokens.POST(body("POST", { name: "Okta" }));
    assert.equal(created.status, 201);
    const { token: t, raw } = await created.json();
    assert.match(raw, new RegExp(`^scim_${WS}_[0-9a-f]{48}$`));
    const row = await withWorkspaceScope(WS, (tx) => tx.scimToken.findUniqueOrThrow({ where: { id: t.id } }));
    assert.equal(row.tokenHash, hashScimToken(raw));
    assert.ok(!JSON.stringify(row).includes(raw.slice(-48)), "raw secret never stored");

    const list = await (await tokens.GET(body("GET"))).json();
    assert.equal(list.tokens.length, 1);
    assert.equal(list.tokens[0].revokedAt, null);
    assert.ok(!JSON.stringify(list).includes(raw.slice(-48)), "listing never returns the secret");
    assert.match(list.endpoint, /\/api\/scim\/v2$/);

    // Another workspace (same owner) can't revoke it by id.
    currentWs = WS2;
    assert.equal((await token.DELETE(body("DELETE"), { params: Promise.resolve({ id: t.id }) })).status, 404);
    currentWs = WS;
    assert.equal((await token.DELETE(body("DELETE"), { params: Promise.resolve({ id: t.id }) })).status, 200);
    const revoked = await withWorkspaceScope(WS, (tx) => tx.scimToken.findUniqueOrThrow({ where: { id: t.id } }));
    assert.ok(revoked.revokedAt);
  });
});
