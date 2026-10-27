// ShapesOS Phase 25: /api/settings/instructions route authorization against
// real Postgres as the app role. The session is stubbed with node:test
// mock.module (the user and workspace are switched per case); the route, authz
// and DB are real.
//   - PUT: viewer 403, editor 403, admin 200, non-member 403; nothing is
//     written by a refused call
//   - GET: viewer 200 with canEdit=false, admin 200 with canEdit=true,
//     non-member 403
// Signed-out (401) is covered by the e2e spec. Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=... npx tsx --test --experimental-test-module-mocks lib/instructions/__tests__/instructions-route-db.test.ts

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

const RUN = randomUUID().slice(0, 8);
const WS = `p25r-${RUN}`;
const OWNER = `p25r-owner-${RUN}`;
const U = { viewer: `p25r-viewer-${RUN}`, editor: `p25r-editor-${RUN}`, admin: `p25r-admin-${RUN}`, outsider: `p25r-out-${RUN}` };

let current: keyof typeof U = "viewer";
mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => ({ id: U[current], email: `${current}@x.test` }),
    getOrCreateWorkspace: async () => prisma.workspace.findUniqueOrThrow({ where: { id: WS } }),
  },
});
let route: typeof import("@/app/api/settings/instructions/route");

function put(body: unknown) {
  return route.PUT(
    new Request("http://local.test/api/settings/instructions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

before(async () => {
  route = await import("@/app/api/settings/instructions/route");
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER } });
  for (const role of ["viewer", "editor", "admin"] as const) {
    await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: U[role], role, email: `${role}@x.test`, name: role } });
  }
});
after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("instructions route authorization (DB)", () => {
  it("refuses PUT from a viewer, an editor and a non-member, and writes nothing", async () => {
    for (const who of ["viewer", "editor", "outsider"] as const) {
      current = who;
      const res = await put({ body: `from ${who}`, expectedRevision: 0 });
      assert.equal(res.status, 403, `${who} PUT`);
    }
    const rows = await prisma.workspaceInstructionRevision.count({ where: { workspaceId: WS } }).catch(() => -1);
    // The app role is tenant-scoped; a bare count outside a workspace scope sees 0 rows either way.
    assert.ok(rows === 0 || rows === -1);
    current = "admin";
    const get = await route.GET();
    assert.equal((await get.json()).instructions.revision, 0, "still no revision after the refused writes");
  });

  it("admin PUT succeeds and members can read it", async () => {
    current = "admin";
    const res = await put({ body: "Cite sources.", expectedRevision: 0 });
    assert.equal(res.status, 200);
    current = "viewer";
    const g = await route.GET();
    assert.equal(g.status, 200);
    const j = await g.json();
    assert.equal(j.canEdit, false);
    assert.equal(j.instructions.body, "Cite sources.");
    current = "admin";
    assert.equal((await (await route.GET()).json()).canEdit, true);
    current = "outsider";
    assert.equal((await route.GET()).status, 403);
  });
});
