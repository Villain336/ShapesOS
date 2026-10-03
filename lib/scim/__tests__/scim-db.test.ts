// ShapesOS Phase 4a — DB test: SCIM 2.0 conformance basics + cross-workspace
// denial, through the real route handlers, as the least-privilege app role
// (scim_tokens / scim_groups / scim_group_members are FORCE RLS).
// Run: DATABASE_URL=… npx tsx --test lib/scim/__tests__/scim-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { mintScimToken } from "../auth";
import * as UsersRoute from "@/app/api/scim/v2/Users/route";
import * as UserRoute from "@/app/api/scim/v2/Users/[id]/route";
import * as GroupsRoute from "@/app/api/scim/v2/Groups/route";
import * as GroupRoute from "@/app/api/scim/v2/Groups/[id]/route";
import * as SpcRoute from "@/app/api/scim/v2/ServiceProviderConfig/route";
import * as RtRoute from "@/app/api/scim/v2/ResourceTypes/route";
import * as SchemasRoute from "@/app/api/scim/v2/Schemas/route";
import { linkScimMembersOnSsoLogin } from "../link";

const RUN = randomUUID().slice(0, 8);
const WA = `p4scimA${RUN}`;
const WB = `p4scimB${RUN}`;
const OWNER_A = `p4scim-owner-a-${RUN}`;
const OWNER_B = `p4scim-owner-b-${RUN}`;
const BASE = "http://localhost:3000/api/scim/v2";

let tokenA = "";
let tokenB = "";
let revokedA = "";
let bMemberId = "";
let ownerAMemberId = "";

async function addToken(ws: string, revoked = false): Promise<string> {
  const t = mintScimToken(ws);
  await withWorkspaceScope(ws, (tx) =>
    tx.scimToken.create({
      data: {
        workspaceId: ws,
        name: "idp",
        tokenHash: t.tokenHash,
        tokenPrefix: t.tokenPrefix,
        createdBy: "test",
        revokedAt: revoked ? new Date() : null,
      },
    }),
  );
  return t.raw;
}

function req(path: string, token: string | null, init: { method?: string; body?: unknown } = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/scim+json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

before(async () => {
  for (const [id, owner] of [
    [WA, OWNER_A],
    [WB, OWNER_B],
  ]) {
    await prisma.workspace.create({ data: { id, name: id, ownerUserId: owner } });
  }
  ownerAMemberId = (
    await prisma.workspaceMember.create({ data: { workspaceId: WA, userId: OWNER_A, email: "owner@a.example", role: "owner" } })
  ).id;
  bMemberId = (
    await prisma.workspaceMember.create({ data: { workspaceId: WB, userId: "b-user", email: "bob@b.example", role: "editor" } })
  ).id;
  tokenA = await addToken(WA);
  tokenB = await addToken(WB);
  revokedA = await addToken(WA, true);
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WA, WB] } } });
  await prisma.$disconnect();
});

describe("SCIM auth", () => {
  it("401 without, with a malformed, a revoked, or a forged-workspace token", async () => {
    for (const t of [null, "nope", revokedA]) {
      const res = await UsersRoute.GET(req("/Users", t));
      assert.equal(res.status, 401, String(t));
      assert.equal(res.headers.get("content-type"), "application/scim+json");
      assert.deepEqual((await json(res)).schemas, ["urn:ietf:params:scim:api:messages:2.0:Error"]);
    }
    // A's secret relabelled as B's workspace: the hash only exists in A's scope.
    const forged = tokenA.replace(`scim_${WA}_`, `scim_${WB}_`);
    assert.equal((await UsersRoute.GET(req("/Users", forged))).status, 401);
  });

  it("discovery endpoints", async () => {
    const spc = await json(await SpcRoute.GET(req("/ServiceProviderConfig", tokenA)));
    assert.equal(spc.patch.supported, true);
    assert.equal(spc.filter.supported, true);
    assert.equal(spc.authenticationSchemes[0].type, "oauthbearertoken");
    const rt = await json(await RtRoute.GET(req("/ResourceTypes", tokenA)));
    assert.deepEqual(rt.Resources.map((r: { id: string }) => r.id).sort(), ["Group", "User"]);
    const sc = await json(await SchemasRoute.GET(req("/Schemas", tokenA)));
    assert.equal(sc.totalResults, 2);
  });
});

let adaId = "";

describe("SCIM Users", () => {
  it("creates a user (201, pending viewer), and 409s a duplicate userName", async () => {
    const res = await UsersRoute.POST(
      req("/Users", tokenA, {
        method: "POST",
        body: {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "Ada@Example.com",
          name: { givenName: "Ada", familyName: "Lovelace" },
          externalId: "okta-1",
          active: true,
        },
      }),
    );
    assert.equal(res.status, 201);
    const u = await json(res);
    adaId = u.id;
    assert.equal(u.userName, "ada@example.com");
    assert.equal(u.active, true);
    assert.equal(u.name.givenName, "Ada");
    assert.equal(u.displayName, "Ada Lovelace");
    assert.match(res.headers.get("location") ?? "", new RegExp(`/api/scim/v2/Users/${adaId}$`));
    const row = await prisma.workspaceMember.findUniqueOrThrow({ where: { id: adaId } });
    assert.equal(row.workspaceId, WA);
    assert.equal(row.userId, null);
    assert.equal(row.role, "viewer");
    assert.equal(row.scimManaged, true);

    const dup = await UsersRoute.POST(req("/Users", tokenA, { method: "POST", body: { userName: "ada@example.com" } }));
    assert.equal(dup.status, 409);
    assert.equal((await json(dup)).scimType, "uniqueness");
  });

  it("lists with filter userName eq, and paginates", async () => {
    const hit = await json(await UsersRoute.GET(req(`/Users?filter=${encodeURIComponent('userName eq "ADA@example.com"')}`, tokenA)));
    assert.equal(hit.totalResults, 1);
    assert.equal(hit.Resources[0].id, adaId);
    const miss = await json(await UsersRoute.GET(req(`/Users?filter=${encodeURIComponent('userName eq "nobody@example.com"')}`, tokenA)));
    assert.equal(miss.totalResults, 0);
    assert.deepEqual(miss.Resources, []);
    const all = await json(await UsersRoute.GET(req("/Users?startIndex=1&count=1", tokenA)));
    assert.equal(all.totalResults, 2); // owner + ada
    assert.equal(all.itemsPerPage, 1);
    const bad = await UsersRoute.GET(req(`/Users?filter=${encodeURIComponent('userName co "a"')}`, tokenA));
    assert.equal(bad.status, 400);
    assert.equal((await json(bad)).scimType, "invalidFilter");
  });

  it("gets, replaces (PUT) and patches", async () => {
    assert.equal((await json(await UserRoute.GET(req(`/Users/${adaId}`, tokenA), params(adaId)))).userName, "ada@example.com");
    const put = await json(
      await UserRoute.PUT(
        req(`/Users/${adaId}`, tokenA, { method: "PUT", body: { userName: "ada@example.com", displayName: "Countess", active: true } }),
        params(adaId),
      ),
    );
    assert.equal(put.displayName, "Countess");
    assert.equal(put.externalId, undefined, "PUT clears omitted attributes");
    const patched = await json(
      await UserRoute.PATCH(
        req(`/Users/${adaId}`, tokenA, {
          method: "PATCH",
          body: {
            schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
            Operations: [{ op: "replace", path: "externalId", value: "okta-2" }],
          },
        }),
        params(adaId),
      ),
    );
    assert.equal(patched.externalId, "okta-2");
  });

  it("an SSO sign-in with the verified email links the SCIM user", async () => {
    assert.equal(await linkScimMembersOnSsoLogin("oidc:ada", "ada@example.com", false), 0, "unverified email never links");
    assert.equal(await linkScimMembersOnSsoLogin("oidc:ada", "ADA@example.com", true), 1);
    assert.equal((await prisma.workspaceMember.findUniqueOrThrow({ where: { id: adaId } })).userId, "oidc:ada");
  });

  it("PATCH active=false deprovisions (access ends), active=true restores", async () => {
    const off = await UserRoute.PATCH(
      req(`/Users/${adaId}`, tokenA, { method: "PATCH", body: { Operations: [{ op: "replace", value: { active: false } }] } }),
      params(adaId),
    );
    assert.equal(off.status, 200);
    assert.equal((await json(off)).active, false);
    let row = await prisma.workspaceMember.findUniqueOrThrow({ where: { id: adaId } });
    assert.equal(row.userId, null, "no userId → every access path denies");
    assert.equal(row.scimSuspendedUserId, "oidc:ada");
    assert.ok(row.scimDeactivatedAt);
    assert.equal(await prisma.workspaceMember.count({ where: { workspaceId: WA, userId: "oidc:ada" } }), 0);
    // A deactivated row is never re-linked by an SSO sign-in.
    assert.equal(await linkScimMembersOnSsoLogin("oidc:ada", "ada@example.com", true), 0);

    // Entra ID shape: string boolean with a path.
    const on = await UserRoute.PATCH(
      req(`/Users/${adaId}`, tokenA, { method: "PATCH", body: { Operations: [{ op: "Replace", path: "active", value: "True" }] } }),
      params(adaId),
    );
    assert.equal((await json(on)).active, true);
    row = await prisma.workspaceMember.findUniqueOrThrow({ where: { id: adaId } });
    assert.equal(row.userId, "oidc:ada");
    assert.equal(row.scimDeactivatedAt, null);
  });

  it("owners can't be changed, deprovisioned or deleted over SCIM", async () => {
    const off = await UserRoute.PATCH(
      req(`/Users/${ownerAMemberId}`, tokenA, { method: "PATCH", body: { Operations: [{ op: "replace", path: "active", value: false }] } }),
      params(ownerAMemberId),
    );
    assert.equal(off.status, 403);
    assert.equal((await json(off)).scimType, "mutability");
    assert.equal((await UserRoute.DELETE(req(`/Users/${ownerAMemberId}`, tokenA, { method: "DELETE" }), params(ownerAMemberId))).status, 403);
    assert.equal((await prisma.workspaceMember.findUniqueOrThrow({ where: { id: ownerAMemberId } })).userId, OWNER_A);
  });
});

let groupId = "";

describe("SCIM Groups → roles", () => {
  it("rejects a group name that doesn't name a role", async () => {
    const res = await GroupsRoute.POST(req("/Groups", tokenA, { method: "POST", body: { displayName: "Everyone" } }));
    assert.equal(res.status, 400);
  });

  it("creating 'ShapesOS Admins' with a member makes them admin; removing them re-ranks", async () => {
    const res = await GroupsRoute.POST(
      req("/Groups", tokenA, { method: "POST", body: { displayName: "ShapesOS Admins", members: [{ value: adaId }] } }),
    );
    assert.equal(res.status, 201);
    const g = await json(res);
    groupId = g.id;
    assert.deepEqual(g.members.map((m: { value: string }) => m.value), [adaId]);
    assert.equal((await prisma.workspaceMember.findUniqueOrThrow({ where: { id: adaId } })).role, "admin");
    const u = await json(await UserRoute.GET(req(`/Users/${adaId}`, tokenA), params(adaId)));
    assert.equal(u.groups[0].value, groupId);

    const listed = await json(await GroupsRoute.GET(req(`/Groups?filter=${encodeURIComponent('displayName eq "shapesos admins"')}`, tokenA)));
    assert.equal(listed.totalResults, 1);

    const removed = await GroupRoute.PATCH(
      req(`/Groups/${groupId}`, tokenA, {
        method: "PATCH",
        body: { Operations: [{ op: "remove", path: `members[value eq "${adaId}"]` }] },
      }),
      params(groupId),
    );
    assert.equal(removed.status, 200);
    assert.equal((await prisma.workspaceMember.findUniqueOrThrow({ where: { id: adaId } })).role, "viewer");

    // Owners in a group keep owner.
    await GroupRoute.PATCH(
      req(`/Groups/${groupId}`, tokenA, {
        method: "PATCH",
        body: { Operations: [{ op: "add", path: "members", value: [{ value: ownerAMemberId }, { value: adaId }] }] },
      }),
      params(groupId),
    );
    assert.equal((await prisma.workspaceMember.findUniqueOrThrow({ where: { id: ownerAMemberId } })).role, "owner");
    assert.equal((await prisma.workspaceMember.findUniqueOrThrow({ where: { id: adaId } })).role, "admin");
  });

  it("deleting the group re-ranks its members", async () => {
    assert.equal((await GroupRoute.DELETE(req(`/Groups/${groupId}`, tokenA, { method: "DELETE" }), params(groupId))).status, 204);
    assert.equal((await prisma.workspaceMember.findUniqueOrThrow({ where: { id: adaId } })).role, "viewer");
    assert.equal((await GroupRoute.GET(req(`/Groups/${groupId}`, tokenA), params(groupId))).status, 404);
  });
});

describe("cross-workspace denial", () => {
  it("A's token never sees, reads, changes or groups B's users", async () => {
    const list = await json(await UsersRoute.GET(req("/Users", tokenA)));
    assert.ok(!list.Resources.some((r: { id: string }) => r.id === bMemberId));
    assert.equal((await UserRoute.GET(req(`/Users/${bMemberId}`, tokenA), params(bMemberId))).status, 404);
    const patch = await UserRoute.PATCH(
      req(`/Users/${bMemberId}`, tokenA, { method: "PATCH", body: { Operations: [{ op: "replace", path: "active", value: false }] } }),
      params(bMemberId),
    );
    assert.equal(patch.status, 404);
    assert.equal((await UserRoute.DELETE(req(`/Users/${bMemberId}`, tokenA, { method: "DELETE" }), params(bMemberId))).status, 404);
    const filtered = await json(await UsersRoute.GET(req(`/Users?filter=${encodeURIComponent('userName eq "bob@b.example"')}`, tokenA)));
    assert.equal(filtered.totalResults, 0);

    const g = await GroupsRoute.POST(
      req("/Groups", tokenA, { method: "POST", body: { displayName: "Editors", members: [{ value: bMemberId }] } }),
    );
    assert.equal(g.status, 400, "another workspace's member id is rejected");

    const bRow = await prisma.workspaceMember.findUniqueOrThrow({ where: { id: bMemberId } });
    assert.equal(bRow.userId, "b-user");
    assert.equal(bRow.role, "editor");
  });

  it("B's token sees only B; B can't read A's groups", async () => {
    const created = await json(
      await GroupsRoute.POST(req("/Groups", tokenA, { method: "POST", body: { displayName: "Viewers" } })),
    );
    const list = await json(await UsersRoute.GET(req("/Users", tokenB)));
    assert.deepEqual(list.Resources.map((r: { id: string }) => r.id), [bMemberId]);
    assert.equal((await GroupRoute.GET(req(`/Groups/${created.id}`, tokenB), params(created.id))).status, 404);
    assert.equal((await json(await GroupsRoute.GET(req("/Groups", tokenB)))).totalResults, 0);
  });

  it("DELETE removes the membership (204), then 404", async () => {
    assert.equal((await UserRoute.DELETE(req(`/Users/${adaId}`, tokenA, { method: "DELETE" }), params(adaId))).status, 204);
    assert.equal((await UserRoute.GET(req(`/Users/${adaId}`, tokenA), params(adaId))).status, 404);
  });
});
