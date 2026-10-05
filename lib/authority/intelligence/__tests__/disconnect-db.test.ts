// ShapesOS Phase 15.1 — BUG B: POST /api/authority/intelligence/connect with
// { disconnect: true } called deleteConnection(workspaceId, vaultKey), but the
// signature is deleteConnection(connectionId, workspaceId) and a vault KEY is
// not a connection id — the call always threw "not found" (swallowed by a
// .catch), so the vault delete path never ran. The fix looks the workspace's
// connection(s) up by (workspaceId, connectorKey = vaultKey) and deletes each
// through deleteConnection(connection.id, workspaceId).
//
// The real route runs against Postgres as the app role; the session is
// stubbed with node:test mock.module, and deleteConnection is the REAL
// function wrapped in a recorder so the test sees the arguments it got.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… MARKETR_CREDENTIALS_KEY=… npx tsx --test --experimental-test-module-mocks lib/authority/intelligence/__tests__/disconnect-db.test.ts

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

const RUN = randomUUID().slice(0, 8);
const WS = `p15bugb-${RUN}`;
const WS_OTHER = `p15bugb-o-${RUN}`;
const USER = `p15bugb-user-${RUN}`;

let real: typeof import("@/lib/vault/apikey");
const deleteCalls: Array<{ args: [string, string]; ok: boolean }> = [];

mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => ({ id: USER, email: "bugb@x.test" }),
    getOrCreateWorkspace: async () => prisma.workspace.findUniqueOrThrow({ where: { id: WS } }),
  },
});
let route: typeof import("@/app/api/authority/intelligence/connect/route");

function post(body: unknown) {
  return route.POST(
    new Request("http://local.test/api/authority/intelligence/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

before(async () => {
  // The real vault module first; deleteConnection wrapped in a recorder.
  real = await import("@/lib/vault/apikey");
  mock.module("@/lib/vault/apikey", {
    namedExports: {
      ...real,
      deleteConnection: async (connectionId: string, workspaceId: string) => {
        try {
          await real.deleteConnection(connectionId, workspaceId);
          deleteCalls.push({ args: [connectionId, workspaceId], ok: true });
        } catch (e) {
          deleteCalls.push({ args: [connectionId, workspaceId], ok: false });
          throw e;
        }
      },
    },
  });
  route = await import("@/app/api/authority/intelligence/connect/route");
  for (const id of [WS, WS_OTHER]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: USER } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: USER, role: "editor" } });
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_OTHER] } } });
  await prisma.$disconnect();
});

describe("intelligence connector disconnect (BUG B)", () => {
  it("deletes this workspace's vault connection by its connection id, credential included", async () => {
    const res = await post({ connector: "email", mode: "api_key", apiKey: "listkey-p15-secret" });
    assert.equal(res.status, 200);
    const conn = await prisma.connectorConnection.findFirstOrThrow({ where: { workspaceId: WS, connectorKey: "email-platform" } });
    assert.ok(await prisma.connectorCredential.findUnique({ where: { connectionId: conn.id } }));
    // Same connector key in another workspace: must survive.
    const other = await real.storeApiKey(USER, WS_OTHER, "email-platform", "Other", "other-secret");

    const out = await post({ connector: "email", disconnect: true });
    assert.equal(out.status, 200);
    assert.deepEqual(deleteCalls, [{ args: [conn.id, WS], ok: true }], "deleteConnection(connectionId, workspaceId) for the real connection");
    assert.equal(await prisma.connectorConnection.count({ where: { workspaceId: WS, connectorKey: "email-platform" } }), 0);
    assert.equal(await prisma.connectorCredential.count({ where: { connectionId: conn.id } }), 0);
    assert.equal(await prisma.connectorConnection.count({ where: { id: other.id } }), 1, "another workspace's connection is untouched");
  });

  it("disconnecting a fixture connection goes through the same path", async () => {
    deleteCalls.length = 0;
    assert.equal((await post({ connector: "ga4" })).status, 200);
    const fx = await prisma.connectorConnection.findFirstOrThrow({ where: { workspaceId: WS, connectorKey: "ga4" } });
    assert.equal((await post({ connector: "ga4", disconnect: true })).status, 200);
    assert.deepEqual(deleteCalls, [{ args: [fx.id, WS], ok: true }]);
    assert.equal(await prisma.connectorConnection.count({ where: { workspaceId: WS, connectorKey: "ga4" } }), 0);
  });
});
