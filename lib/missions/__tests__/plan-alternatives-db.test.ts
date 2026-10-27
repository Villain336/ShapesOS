// Plan variants against real Postgres as the app role (FORCE RLS, real pool):
//   1. Concurrent selects from the same revision: exactly one wins, the other 409s,
//      one audit event, and the stored plan is the winner's.
//   2. Selection vs approval, run many times with true parallelism: the mission
//      either ends active on EXACTLY the approved revision, or stays planned on
//      the chosen variant. Never active on a plan nobody approved.
//   3. Route authorization (session stubbed with mock.module; route, authz, DB real):
//      GET viewer 200; POST viewer 403, non-member 403, editor 200; a refused
//      POST changes nothing. Signed-out 401 is covered by the e2e spec.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=... npx tsx --test --experimental-test-module-mocks lib/missions/__tests__/plan-alternatives-db.test.ts

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { approveMissionPlan, planRevision, selectPlanAlternative, startMission, type EngineDeps } from "../engine";
import { createPrismaMissionStore } from "../prisma-store";
import { isWorkspaceFrozen } from "@/lib/orchestrator/killswitch";

const RUN = randomUUID().slice(0, 8);
const WS = `p26a-${RUN}`;
const OWNER = `p26a-owner-${RUN}`;
const U = { viewer: `p26a-viewer-${RUN}`, editor: `p26a-editor-${RUN}`, outsider: `p26a-out-${RUN}` };
const GOAL = { metric: "booked_jobs", targetValue: 40, unit: "jobs", timeframeDays: 90, baseline: 22 };
const TPL = "home-services.booked-job-growth";

let current: keyof typeof U = "viewer";
mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => ({ id: U[current], email: `${current}@x.test` }),
    getOrCreateWorkspace: async () => prisma.workspace.findUniqueOrThrow({ where: { id: WS } }),
  },
});
let route: typeof import("@/app/api/missions/[id]/plan-alternatives/route");

const deps = (): EngineDeps => {
  const store = createPrismaMissionStore();
  return {
    store,
    isWorkspaceFrozen,
    isMissionPaused: async (id, ws) => (await store.getMission(id, ws))?.status === "paused",
  };
};
const draft = () => startMission(deps(), { workspaceId: WS, userId: OWNER, templateId: TPL, goal: GOAL });

before(async () => {
  route = await import("@/app/api/missions/[id]/plan-alternatives/route");
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER } });
  for (const role of ["viewer", "editor"] as const) {
    await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: U[role], role, email: `${role}@x.test`, name: role } });
  }
});
after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("plan variant selection (Postgres)", () => {
  it("two parallel selects from one revision: exactly one wins", async () => {
    const d = deps();
    const m = await draft();
    const rev = planRevision(m.planSnapshot);
    const res = await Promise.allSettled([
      selectPlanAlternative(d, m.id, WS, OWNER, { alternativeId: "drafts-only", expectedRevision: rev }),
      selectPlanAlternative(d, m.id, WS, OWNER, { alternativeId: "drafts-only", expectedRevision: rev }),
    ]);
    const won = res.filter((r) => r.status === "fulfilled");
    assert.equal(won.length, 1, JSON.stringify(res.map((r) => r.status)));
    const lost = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal((lost.reason as { status?: number }).status, 409);
    const after = (await d.store.getMission(m.id, WS))!;
    const winner = (won[0] as PromiseFulfilledResult<{ planRevision: string }>).value.planRevision;
    assert.equal(planRevision(after.planSnapshot), winner);
    const ev = (await d.store.listEvents(m.id, WS)).filter((e) => e.step === "mission.plan_alternative_selected");
    assert.equal(ev.length, 1);
  });

  it("selection racing approval (x20): never active on a plan nobody approved", async () => {
    const d = deps();
    let activeCount = 0, plannedCount = 0;
    for (let i = 0; i < 20; i++) {
      const m = await draft();
      const rev = planRevision(m.planSnapshot);
      await Promise.allSettled([
        selectPlanAlternative(d, m.id, WS, OWNER, { alternativeId: "drafts-only", expectedRevision: rev }),
        approveMissionPlan(d, m.id, WS, OWNER, { expectedRevision: rev }),
      ]);
      const final = (await d.store.getMission(m.id, WS))!;
      const events = await d.store.listEvents(m.id, WS);
      const approved = (events.find((e) => e.step === "mission.plan_approved")?.observation as { planRevision?: string } | undefined)?.planRevision;
      if (final.status === "active") {
        activeCount++;
        assert.equal(approved, planRevision(final.planSnapshot), `run ${i}: active plan must be the approved revision`);
      } else {
        plannedCount++;
        assert.equal(final.status, "planned");
        assert.equal(approved, undefined, `run ${i}: planned mission must have no approval record`);
      }
    }
    assert.equal(activeCount + plannedCount, 20);
  });

  it("selecting from a revision that was already swapped is refused", async () => {
    const d = deps();
    const m = await draft();
    const rev = planRevision(m.planSnapshot);
    await selectPlanAlternative(d, m.id, WS, OWNER, { alternativeId: "drafts-only", expectedRevision: rev });
    await assert.rejects(selectPlanAlternative(d, m.id, WS, OWNER, { alternativeId: "as-templated", expectedRevision: rev }), (e: { status?: number }) => e.status === 409);
  });
});

describe("plan variants route authorization (Postgres)", () => {
  const post = (id: string, body: unknown) =>
    route.POST(new Request("http://local.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  const get = (id: string) => route.GET(new Request("http://local.test/x"), { params: Promise.resolve({ id }) });

  it("viewer can read but not choose; non-member refused; editor can choose; refused calls change nothing", async () => {
    const m = await draft();
    const rev = planRevision(m.planSnapshot);
    current = "viewer";
    const g = await get(m.id);
    assert.equal(g.status, 200);
    assert.equal((await g.json()).currentRevision, rev);
    assert.equal((await post(m.id, { alternativeId: "drafts-only", planRevision: rev })).status, 403);
    current = "outsider";
    assert.equal((await post(m.id, { alternativeId: "drafts-only", planRevision: rev })).status, 403);
    const unchanged = (await createPrismaMissionStore().getMission(m.id, WS))!;
    assert.equal(planRevision(unchanged.planSnapshot), rev, "refused calls changed nothing");
    current = "editor";
    const ok = await post(m.id, { alternativeId: "drafts-only", planRevision: rev });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).status, "planned", "choosing does not activate");
  });
});
