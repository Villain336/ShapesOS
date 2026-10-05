// ShapesOS — Phase 1: member role rules, through the real route handlers.
//   - nobody grants a role above their own (admin → owner self-promotion);
//   - only owners touch owner rows / invite owners / reissue owner invites;
//   - pending owner invites don't count toward "last owner".
// DB-backed (listed in scripts/test/db-tests.txt). The session is stubbed with
// node:test mock.module (needs --experimental-test-module-mocks, which
// scripts/test/run.mjs passes).
// Run: DATABASE_URL=… npx tsx --test --experimental-test-module-mocks \
//        lib/auth/__tests__/member-roles.test.ts

import "dotenv/config";
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { memberChangeError } from "@/lib/authz";

const WS = "p1-roles-ws";
let actor = { id: "p1-roles-owner", email: "owner@roles.test" };

mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => actor,
    getOrCreateWorkspace: async () => ({ id: WS, name: WS }),
  },
});

type Route = typeof import("@/app/api/workspace/members/[id]/route");
type ListRoute = typeof import("@/app/api/workspace/members/route");
type LinkRoute = typeof import("@/app/api/workspace/members/[id]/invite-link/route");
let byId: Route;
let list: ListRoute;
let link: LinkRoute;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (body: unknown) =>
  new Request("http://x/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;

async function member(userId: string | null, role: WorkspaceRole, email: string) {
  return prisma.workspaceMember.create({ data: { workspaceId: WS, userId, role, email } });
}

describe("memberChangeError (pure)", () => {
  it("rank cap and owner-row rule", () => {
    assert.equal(memberChangeError("owner", { currentRole: "owner", nextRole: "viewer" }), null);
    assert.equal(memberChangeError("owner", { nextRole: "owner" }), null);
    assert.equal(memberChangeError("admin", { nextRole: "admin" }), null);
    assert.equal(memberChangeError("admin", { currentRole: "editor", nextRole: "admin" }), null);
    assert.match(memberChangeError("admin", { nextRole: "owner" }) ?? "", /above your own/);
    assert.match(memberChangeError("admin", { currentRole: "admin", nextRole: "owner" }) ?? "", /above your own/);
    assert.match(memberChangeError("admin", { currentRole: "owner" }) ?? "", /Only an owner/);
    assert.match(memberChangeError("admin", { currentRole: "owner", nextRole: "viewer" }) ?? "", /Only an owner/);
  });
});

describe("member routes (DB)", () => {
  before(async () => {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
    await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at)
      VALUES (${WS}, ${WS}, ${"p1-roles-owner"}, now())`;
    byId = await import("@/app/api/workspace/members/[id]/route");
    list = await import("@/app/api/workspace/members/route");
    link = await import("@/app/api/workspace/members/[id]/invite-link/route");
  });
  beforeEach(async () => {
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: WS } });
  });
  after(async () => {
    await prisma.$executeRaw`DELETE FROM file_change_log WHERE workspace_id = ${WS}`.catch(() => {});
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
    await prisma.$disconnect();
  });

  it("admin cannot promote themselves to owner, nor demote/remove the owner", async () => {
    const owner = await member("p1-roles-owner", "owner", "owner@roles.test");
    const admin = await member("p1-roles-admin", "admin", "admin@roles.test");
    actor = { id: "p1-roles-admin", email: "admin@roles.test" };

    let res = await byId.PATCH(json({ role: "owner" }), ctx(admin.id));
    assert.equal(res.status, 403);
    res = await byId.PATCH(json({ role: "viewer" }), ctx(owner.id));
    assert.equal(res.status, 403);
    res = await byId.DELETE(json({}), ctx(owner.id));
    assert.equal(res.status, 403);

    const rows = await prisma.workspaceMember.findMany({ where: { workspaceId: WS } });
    assert.equal(rows.find((r) => r.id === admin.id)?.role, "admin");
    assert.equal(rows.find((r) => r.id === owner.id)?.role, "owner");
  });

  it("admin cannot invite an owner or reissue an owner invite link; can invite up to admin", async () => {
    await member("p1-roles-owner", "owner", "owner@roles.test");
    await member("p1-roles-admin", "admin", "admin@roles.test");
    actor = { id: "p1-roles-admin", email: "admin@roles.test" };

    let res = await list.POST(json({ email: "evil@roles.test", role: "owner" }));
    assert.equal(res.status, 403);
    res = await list.POST(json({ email: "peer@roles.test", role: "admin" }));
    assert.equal(res.status, 200);

    const pendingOwner = await member(null, "owner", "co-owner@roles.test");
    res = await link.POST(json({}), ctx(pendingOwner.id));
    assert.equal(res.status, 403);
    res = await byId.DELETE(json({}), ctx(pendingOwner.id));
    assert.equal(res.status, 403);
  });

  it("owner can invite an owner and manage admins", async () => {
    await member("p1-roles-owner", "owner", "owner@roles.test");
    const admin = await member("p1-roles-admin", "admin", "admin@roles.test");
    actor = { id: "p1-roles-owner", email: "owner@roles.test" };

    let res = await list.POST(json({ email: "co-owner@roles.test", role: "owner" }));
    assert.equal(res.status, 200);
    res = await byId.PATCH(json({ role: "editor" }), ctx(admin.id));
    assert.equal(res.status, 200);
  });

  it("a pending owner invite doesn't count: the last active owner can't step down", async () => {
    const owner = await member("p1-roles-owner", "owner", "owner@roles.test");
    const pending = await member(null, "owner", "invitee@roles.test");
    actor = { id: "p1-roles-owner", email: "owner@roles.test" };

    let res = await byId.PATCH(json({ role: "admin" }), ctx(owner.id));
    assert.equal(res.status, 400);
    res = await byId.DELETE(json({}), ctx(owner.id));
    assert.equal(res.status, 400);
    // The pending owner invite itself can still be withdrawn.
    res = await byId.DELETE(json({}), ctx(pending.id));
    assert.equal(res.status, 200);

    // With a second ACTIVE owner, stepping down works.
    await member("p1-roles-owner2", "owner", "owner2@roles.test");
    res = await byId.PATCH(json({ role: "admin" }), ctx(owner.id));
    assert.equal(res.status, 200);
  });
});
