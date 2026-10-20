// ShapesOS — public status page (WS=legal) against Postgres as the app role:
//   - the public snapshot derives the four components live and lists no
//     incidents on a fresh install; it is readable with NO tenant GUC
//     (status_components / status_incidents are platform-wide, not tenant data);
//   - an operator's manual component state overrides the derived one and
//     clears back to it;
//   - incidents: create → open; updates append with their status; resolve
//     moves it to the recent history (newest first);
//   - routes: GET /api/status is public and cached; the write routes are
//     platform-operator only (401 signed out, 403 member, 2xx operator) and
//     validate their bodies (400). The session is stubbed with mock.module.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=<app role> MARKETR_CREDENTIALS_KEY=<hex> npx tsx --test --experimental-test-module-mocks lib/status/__tests__/status-db.test.ts

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const RUN = randomUUID().slice(0, 8);
const OPERATOR = { id: `status-op-${RUN}`, email: `status-op-${RUN}@example.test` };
const MEMBER = { id: `status-member-${RUN}`, email: `status-member-${RUN}@example.test` };
let actor: { id: string; email: string } | null = null;
mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => actor,
  },
});

type Store = typeof import("../store");
type Pub = typeof import("../public");
type StatusRoute = typeof import("@/app/api/status/route");
type IncidentsRoute = typeof import("@/app/api/status/incidents/route");
type IncidentRoute = typeof import("@/app/api/status/incidents/[id]/route");
type ComponentRoute = typeof import("@/app/api/status/components/[key]/route");
let prisma: typeof import("@/lib/prisma").prisma;
let store: Store;
let pub: Pub;
let statusRoute: StatusRoute;
let incidentsRoute: IncidentsRoute;
let incidentRoute: IncidentRoute;
let componentRoute: ComponentRoute;
const savedOps = process.env.MARKETR_PLATFORM_OPERATORS;
const created: string[] = [];

const json = (method: string, path: string, body?: unknown) =>
  new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });

before(async () => {
  process.env.MARKETR_PLATFORM_OPERATORS = OPERATOR.email;
  ({ prisma } = await import("@/lib/prisma"));
  store = await import("../store");
  pub = await import("../public");
  statusRoute = await import("@/app/api/status/route");
  incidentsRoute = await import("@/app/api/status/incidents/route");
  incidentRoute = await import("@/app/api/status/incidents/[id]/route");
  componentRoute = await import("@/app/api/status/components/[key]/route");
  // A clean slate for this run (platform-wide tables; other runs' rows are cleaned by their own after()).
  await store.setComponentOverride("database", null, OPERATOR.id);
});

after(async () => {
  await store.setComponentOverride("database", null, OPERATOR.id);
  if (created.length) await prisma.statusIncident.deleteMany({ where: { id: { in: created } } });
  if (savedOps === undefined) delete process.env.MARKETR_PLATFORM_OPERATORS;
  else process.env.MARKETR_PLATFORM_OPERATORS = savedOps;
  await prisma.$disconnect();
});

describe("status store (DB)", () => {
  it("the public snapshot derives the four components live, without any tenant GUC", async () => {
    const snap = await pub.statusSnapshot({ fresh: true });
    assert.deepEqual(snap.components.map((c) => c.key), ["web", "database", "worker", "queue"]);
    assert.equal(snap.components.find((c) => c.key === "database")!.state, "operational", "the scratch DB is migrated and answering");
    assert.equal(snap.components.find((c) => c.key === "web")!.state, "operational");
    assert.ok(["operational", "maintenance"].includes(snap.components.find((c) => c.key === "worker")!.state), "idle worker (or off in tests)");
    assert.equal(typeof snap.generatedAt, "string");
    assert.equal(snap.cacheSeconds, 15);
  });

  it("an operator's manual state overrides a component and clears back", async () => {
    await store.setComponentOverride("database", { state: "maintenance", note: "Planned failover" }, OPERATOR.id);
    let snap = await pub.statusSnapshot({ fresh: true });
    const db = snap.components.find((c) => c.key === "database")!;
    assert.equal(db.state, "maintenance");
    assert.equal(db.note, "Planned failover");
    assert.equal(db.manual, true);
    assert.equal(snap.overall, "maintenance");
    await store.setComponentOverride("database", null, OPERATOR.id);
    snap = await pub.statusSnapshot({ fresh: true });
    assert.equal(snap.components.find((c) => c.key === "database")!.state, "operational");
    assert.equal(snap.components.find((c) => c.key === "database")!.manual, false);
  });

  it("incidents: create is open, updates append, resolve moves it to recent history", async () => {
    const inc = await store.createIncident(
      { title: `Slow job pickup ${RUN}`, status: "investigating", impact: "minor", componentKeys: ["queue"], message: "Jobs are waiting longer than usual." },
      OPERATOR.id,
    );
    created.push(inc.id);
    assert.equal(inc.status, "investigating");
    assert.equal(inc.resolvedAt, null);
    assert.equal(inc.updates.length, 1);
    assert.equal(inc.updates[0].status, "investigating");
    let listed = await store.listIncidents();
    assert.ok(listed.open.some((i) => i.id === inc.id), "open");
    assert.ok(!listed.recent.some((i) => i.id === inc.id));

    const mon = await store.updateIncident(inc.id, { status: "monitoring", message: "A fix is deployed; watching." }, OPERATOR.id);
    assert.equal(mon!.status, "monitoring");
    assert.deepEqual(mon!.updates.map((u) => u.status), ["investigating", "monitoring"]);
    assert.equal(mon!.updates[1].by, OPERATOR.id);

    const done = await store.updateIncident(inc.id, { status: "resolved", message: "Pickup times are back to normal." }, OPERATOR.id);
    assert.ok(done!.resolvedAt);
    listed = await store.listIncidents();
    assert.ok(!listed.open.some((i) => i.id === inc.id));
    assert.equal(listed.recent[0]?.id, inc.id, "newest resolved first");
    assert.equal(await store.updateIncident("missing-id", { status: "resolved", message: "x" }, OPERATOR.id), null);
    // The public snapshot carries the same lists.
    const snap = await pub.statusSnapshot({ fresh: true });
    assert.ok(snap.incidents.recent.some((i) => i.id === inc.id));
  });
});

describe("status routes (DB)", () => {
  it("GET /api/status is public (no session) and cached", async () => {
    actor = null;
    const res = await statusRoute.GET();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") ?? "", /public/);
    assert.match(res.headers.get("cache-control") ?? "", /s-maxage=30/);
    const body = (await res.json()) as { overall: string; components: Array<{ key: string }>; incidents: { open: unknown[]; recent: unknown[] } };
    assert.equal(body.components.length, 4);
    assert.ok(Array.isArray(body.incidents.open));
    assert.ok(!JSON.stringify(body).includes(OPERATOR.id), "no operator ids in the public body");
  });

  it("the write routes are platform-operator only and validate their bodies", async () => {
    const body = { title: `Route incident ${RUN}`, status: "identified", impact: "major", componentKeys: ["web", "database"], message: "Elevated errors on the API." };
    actor = null;
    assert.equal((await incidentsRoute.POST(json("POST", "/api/status/incidents", body))).status, 401);
    actor = MEMBER;
    assert.equal((await incidentsRoute.POST(json("POST", "/api/status/incidents", body))).status, 403);
    assert.equal((await componentRoute.PUT(json("PUT", "/api/status/components/web", { state: "degraded", note: "x" }), params({ key: "web" }))).status, 403);
    actor = OPERATOR;
    assert.equal((await incidentsRoute.POST(json("POST", "/api/status/incidents", { ...body, status: "exploded" }))).status, 400);
    assert.equal((await incidentsRoute.POST(json("POST", "/api/status/incidents", { ...body, componentKeys: ["mainframe"] }))).status, 400);
    assert.equal((await incidentsRoute.POST(json("POST", "/api/status/incidents", { ...body, title: "" }))).status, 400);
    const createdRes = await incidentsRoute.POST(json("POST", "/api/status/incidents", body));
    assert.equal(createdRes.status, 201);
    const inc = (await createdRes.json()) as { id: string; status: string; componentKeys: string[] };
    created.push(inc.id);
    assert.deepEqual(inc.componentKeys, ["web", "database"]);

    actor = MEMBER;
    assert.equal((await incidentRoute.PATCH(json("PATCH", `/api/status/incidents/${inc.id}`, { status: "resolved", message: "done" }), params({ id: inc.id }))).status, 403);
    actor = OPERATOR;
    assert.equal((await incidentRoute.PATCH(json("PATCH", `/api/status/incidents/${inc.id}`, { status: "resolved" }), params({ id: inc.id }))).status, 400, "message required");
    assert.equal((await incidentRoute.PATCH(json("PATCH", `/api/status/incidents/nope`, { status: "resolved", message: "done" }), params({ id: "nope" }))).status, 404);
    const patched = await incidentRoute.PATCH(json("PATCH", `/api/status/incidents/${inc.id}`, { status: "resolved", message: "Errors are back to baseline." }), params({ id: inc.id }));
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as { status: string }).status, "resolved");

    assert.equal((await componentRoute.PUT(json("PUT", "/api/status/components/web", { state: "nonsense" }), params({ key: "web" }))).status, 400);
    assert.equal((await componentRoute.PUT(json("PUT", "/api/status/components/mainframe", { state: "degraded" }), params({ key: "mainframe" }))).status, 404);
    const put = await componentRoute.PUT(json("PUT", "/api/status/components/database", { state: "degraded", note: "Vacuum running" }), params({ key: "database" }));
    assert.equal(put.status, 200);
    let snap = await pub.statusSnapshot({ fresh: true });
    assert.equal(snap.components.find((c) => c.key === "database")!.state, "degraded");
    const clear = await componentRoute.PUT(json("PUT", "/api/status/components/database", { state: null }), params({ key: "database" }));
    assert.equal(clear.status, 200);
    snap = await pub.statusSnapshot({ fresh: true });
    assert.equal(snap.components.find((c) => c.key === "database")!.manual, false);
  });
});
