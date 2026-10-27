// Store bundle ROUTES against real Postgres as the app role (session stubbed with
// mock.module; routes, authz and the install paths are real):
//   - GET /api/store/bundles: viewer 200, non-member 403, signed-out 401
//   - POST install: viewer 403, non-member 403, signed-out 401; each refused call changes nothing
//   - POST install: unconfirmed 400, empty selection 400, member outside the bundle 400, unknown bundle 404
//   - POST install as an editor: the route accepts it (editor+), but every member still goes through its
//     OWN gate and fails with its own reason (a bundle never grants more than installing one by one)
//   - POST install as an admin: only selected members install, the connector is skipped, a re-run is a no-op
// Partial success per member is the documented contract (see bundles-service.ts), not a transaction.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=... npx tsx --test --experimental-test-module-mocks lib/store/__tests__/bundles-route-db.test.ts

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { loadStoreCatalogue, removeStoreItem, type StoreActor } from "../service";

const RUN = randomUUID().slice(0, 8);
const WS = `p24r-${RUN}`;
const U = { admin: `p24r-adm-${RUN}`, editor: `p24r-ed-${RUN}`, viewer: `p24r-vic-${RUN}`, outsider: `p24r-out-${RUN}` };
const adm: StoreActor = { workspaceId: WS, userId: U.admin, role: "admin" };
const TPL = "local-services.gbp-visibility";

let current: keyof typeof U | null = "viewer";
mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => (current ? { id: U[current], email: `${current}@x.test` } : null),
    getOrCreateWorkspace: async () => prisma.workspace.findUniqueOrThrow({ where: { id: WS } }),
  },
});
let listRoute: typeof import("@/app/api/store/bundles/route");
let installRoute: typeof import("@/app/api/store/bundles/[key]/install/route");

const post = (key: string, body: unknown) =>
  installRoute.POST(new Request("http://local.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ key }) });
const installed = async (kind: string, key: string) => (await loadStoreCatalogue(adm)).items.find((i) => i.kind === kind && i.key === key)?.installed;

before(async () => {
  listRoute = await import("@/app/api/store/bundles/route");
  installRoute = await import("@/app/api/store/bundles/[key]/install/route");
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: U.admin } });
  for (const role of ["admin", "editor", "viewer"] as const) {
    await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: U[role], role, email: `${role}-${RUN}@example.test` } });
  }
  // Built-in templates start installed: hide one so the bundle has something to add.
  await removeStoreItem(adm, "mission_template", TPL);
});
after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("bundle routes (Postgres)", () => {
  it("GET: viewer 200, non-member 403, signed-out 401", async () => {
    current = "viewer";
    assert.equal((await listRoute.GET()).status, 200);
    current = "outsider";
    assert.equal((await listRoute.GET()).status, 403);
    current = null;
    assert.equal((await listRoute.GET()).status, 401);
  });

  it("POST: viewer, non-member and signed-out are refused and nothing installs", async () => {
    const body = { confirmed: true, members: [`mission_template:${TPL}`, "skill:rank-report"] };
    current = "viewer";
    assert.equal((await post("local-visibility", body)).status, 403);
    current = "outsider";
    assert.equal((await post("local-visibility", body)).status, 403);
    current = null;
    assert.equal((await post("local-visibility", body)).status, 401);
    assert.equal(await installed("mission_template", TPL), false);
    assert.equal(await installed("skill", "rank-report"), false);
  });

  it("POST: bad input is refused before any install", async () => {
    current = "admin";
    assert.equal((await post("local-visibility", { members: [`mission_template:${TPL}`] })).status, 400, "unconfirmed");
    assert.equal((await post("local-visibility", { confirmed: false, members: [`mission_template:${TPL}`] })).status, 400, "confirmed false");
    assert.equal((await post("local-visibility", { confirmed: true, members: [] })).status, 400, "empty selection");
    assert.equal((await post("local-visibility", { confirmed: true, members: ["skill:seo-audit"] })).status, 400, "member outside the bundle");
    assert.equal((await post("nope", { confirmed: true, members: ["skill:rank-report"] })).status, 404, "unknown bundle");
    assert.equal(await installed("mission_template", TPL), false);
  });

  it("POST as editor: accepted, but each member fails on its own gate and nothing installs", async () => {
    current = "editor";
    const res = await post("local-visibility", { confirmed: true, members: [`mission_template:${TPL}`, "skill:rank-report", "connector:google-business-profile"] });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { results: { id: string; outcome: string; reason?: string }[] };
    const by = (id: string) => out.results.find((r) => r.id === id)!;
    assert.equal(by(`mission_template:${TPL}`).outcome, "failed");
    assert.match(by(`mission_template:${TPL}`).reason ?? "", /admin role/);
    assert.equal(by("skill:rank-report").outcome, "failed");
    assert.equal(by("connector:google-business-profile").outcome, "skipped");
    assert.equal(await installed("mission_template", TPL), false);
    assert.equal(await installed("skill", "rank-report"), false);
  });

  it("POST as admin: only selected members install, the connector is skipped, a re-run is a no-op", async () => {
    current = "admin";
    const res = await post("local-visibility", { confirmed: true, members: [`mission_template:${TPL}`, "connector:google-business-profile"] });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { results: { id: string; outcome: string }[] };
    assert.deepEqual(out.results.map((r) => [r.id, r.outcome]).sort(), [["connector:google-business-profile", "skipped"], [`mission_template:${TPL}`, "installed"]]);
    assert.equal(await installed("mission_template", TPL), true);
    assert.equal(await installed("skill", "rank-report"), false, "unselected member untouched");
    const again = (await (await post("local-visibility", { confirmed: true, members: [`mission_template:${TPL}`] })).json()) as { results: { outcome: string }[] };
    assert.equal(again.results[0].outcome, "skipped");
  });
});
