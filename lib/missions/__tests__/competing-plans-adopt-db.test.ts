// Candidate record/adopt against real Postgres as the app role (FORCE RLS, real pool):
//   1. Two parallel adoptions of the same candidate from one revision: exactly one wins (409 for the other).
//   2. Adoption racing approval (x20): never active on a plan nobody approved.
//   3. Tenant isolation: another workspace cannot load or adopt this workspace's candidate.
//   4. Durability: a recorded candidate is still found after more than 500 later events (no list cap).
// No route and no model call exist for this feature; this exercises the groundwork only.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=... npx tsx --test lib/missions/__tests__/competing-plans-adopt-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { approveMissionPlan, planRevision, startMission, type EngineDeps } from "../engine";
import { createPrismaMissionStore } from "../prisma-store";
import { isWorkspaceFrozen } from "@/lib/orchestrator/killswitch";
import { adoptCandidate, loadStoredCandidate, recordCandidates } from "../competing-plans-adopt";

const RUN = randomUUID().slice(0, 8);
const WS = `cpa-${RUN}`;
const WS2 = `cpa2-${RUN}`;
const OWNER = `cpa-owner-${RUN}`;
const OWNER2 = `cpa-owner2-${RUN}`;
const GOAL = { metric: "booked_jobs", targetValue: 40, unit: "jobs", timeframeDays: 90, baseline: 22 };
const TPL = "home-services.booked-job-growth";
const cand = { summary: "s", steps: [{ key: "a", title: "A", kind: "research", executor: "researcher", description: "d" }] };
const status = (e: unknown) => (e as { status?: number }).status;

const deps = (): EngineDeps => {
  const store = createPrismaMissionStore();
  return { store, isWorkspaceFrozen, isMissionPaused: async (id, ws) => (await store.getMission(id, ws))?.status === "paused" };
};
async function draftWithCandidate(d: EngineDeps, ws = WS, user = OWNER) {
  const m = await startMission(d, { workspaceId: ws, userId: user, templateId: TPL, goal: GOAL });
  const rev = planRevision(m.planSnapshot);
  const rec = await recordCandidates(d, { missionId: m.id, workspaceId: ws, userId: user, baseRevision: rev, candidates: [{ lensId: "y", candidate: cand }] });
  return { m, rev, stored: rec.stored[0] };
}

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS2] } } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER } });
  await prisma.workspace.create({ data: { id: WS2, name: WS2, ownerUserId: OWNER2 } });
});
after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS2] } } });
  await prisma.$disconnect();
});

describe("candidate adoption (Postgres)", () => {
  it("two parallel adoptions from one revision: exactly one wins", async () => {
    const d = deps();
    const { m, rev, stored } = await draftWithCandidate(d);
    const res = await Promise.allSettled([
      adoptCandidate(d, { stored, missionId: m.id, workspaceId: WS, userId: OWNER, expectedRevision: rev }),
      adoptCandidate(d, { stored, missionId: m.id, workspaceId: WS, userId: OWNER, expectedRevision: rev }),
    ]);
    const won = res.filter((r) => r.status === "fulfilled");
    assert.equal(won.length, 1, JSON.stringify(res.map((r) => r.status)));
    assert.equal(status((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), 409);
    const events = (await d.store.listEvents(m.id, WS)).filter((e) => e.step === "mission.plan_candidate_adopted");
    assert.equal(events.length, 1);
  });

  it("adoption racing approval (x20): never active on a plan nobody approved", async () => {
    const d = deps();
    let active = 0, planned = 0;
    for (let i = 0; i < 20; i++) {
      const { m, rev, stored } = await draftWithCandidate(d);
      await Promise.allSettled([
        adoptCandidate(d, { stored, missionId: m.id, workspaceId: WS, userId: OWNER, expectedRevision: rev }),
        approveMissionPlan(d, m.id, WS, OWNER, { expectedRevision: rev }),
      ]);
      const final = (await d.store.getMission(m.id, WS))!;
      const events = await d.store.listEvents(m.id, WS);
      const approved = (events.find((e) => e.step === "mission.plan_approved")?.observation as { planRevision?: string } | undefined)?.planRevision;
      if (final.status === "active") {
        active++;
        assert.equal(approved, planRevision(final.planSnapshot), `run ${i}: active plan must be the approved revision`);
      } else {
        planned++;
        assert.equal(approved, undefined, `run ${i}: planned mission must have no approval record`);
      }
    }
    assert.equal(active + planned, 20);
  });

  it("another workspace cannot load or adopt this workspace's candidate", async () => {
    const d = deps();
    const { m, rev, stored } = await draftWithCandidate(d);
    assert.equal(await loadStoredCandidate(d, m.id, WS2, stored.id), null);
    await assert.rejects(adoptCandidate(d, { stored, missionId: m.id, workspaceId: WS2, userId: OWNER2, expectedRevision: rev }), (e) => status(e) === 404);
    const own = await d.store.getMission(m.id, WS);
    assert.equal(planRevision(own!.planSnapshot), rev, "nothing changed");
  });

  it("a recorded candidate is still found after more than 500 later events", async () => {
    const d = deps();
    const { m, stored } = await draftWithCandidate(d);
    for (let i = 0; i < 505; i++) await d.store.appendEvent(m.id, WS, { actor: OWNER, step: "test.filler", observation: { i } });
    assert.equal((await d.store.listEvents(m.id, WS)).length, 500, "list is capped");
    const loaded = await loadStoredCandidate(d, m.id, WS, stored.id);
    assert.ok(loaded, "direct lookup is not subject to the cap");
    assert.equal(loaded!.baseRevision, stored.baseRevision);
  });
});
