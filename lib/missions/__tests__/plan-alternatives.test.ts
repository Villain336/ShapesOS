// Plan alternatives: declared, deterministic, never activates, race-safe.
// Run: npx tsx --test lib/missions/__tests__/plan-alternatives.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMissionStore } from "../store";
import { approveMissionPlan, loadMission, planRevision, selectPlanAlternative, startMission, MissionError, type EngineDeps } from "../engine";
import { buildPlanAlternatives } from "../plan-alternatives";
import { getTemplate, MISSION_TEMPLATES } from "../templates";

const WS = "ws_alt";
const USER = "u1";
const TPL = "home-services.booked-job-growth";
const GOAL = { metric: "booked_jobs", targetValue: 40, unit: "jobs", timeframeDays: 90, baseline: 22 };
const deps = (o: Partial<EngineDeps> = {}): EngineDeps => ({ store: createMemoryMissionStore(), isWorkspaceFrozen: async () => false, isMissionPaused: async () => false, ...o });

describe("buildPlanAlternatives", () => {
  it("full plan matches the snapshot a fresh draft already has", async () => {
    const d = deps();
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    const full = buildPlanAlternatives(getTemplate(TPL)).find((a) => a.id === "as-templated")!;
    assert.equal(planRevision(full.snapshot), planRevision(m.planSnapshot));
  });
  it("drafts-only drops every outside-acting and approval step, keeps order contiguous", () => {
    const alt = buildPlanAlternatives(getTemplate(TPL)).find((a) => a.id === "drafts-only")!;
    assert.ok(alt.steps.every((s) => s.tier === 0 && s.kind !== "approval"));
    assert.deepEqual(alt.steps.map((s) => s.order), alt.steps.map((_, i) => i + 1));
    assert.deepEqual(alt.omitted, ["Approve offer launch", "Publish offer to owned channels"]);
  });
  it("never mutates the template and never offers an empty or duplicate plan", () => {
    for (const t of MISSION_TEMPLATES) {
      const before = JSON.stringify(t.plan);
      const alts = buildPlanAlternatives(t);
      assert.equal(JSON.stringify(t.plan), before);
      assert.ok(alts.every((a) => a.steps.length > 0));
      assert.equal(new Set(alts.map((a) => planRevision(a.snapshot))).size, alts.length);
    }
  });
});

describe("selectPlanAlternative", () => {
  it("swaps the draft, stays planned, and the old revision can no longer be approved", async () => {
    const d = deps();
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    const rev0 = planRevision(m.planSnapshot);
    const r = await selectPlanAlternative(d, m.id, WS, USER, { alternativeId: "drafts-only", expectedRevision: rev0 });
    assert.equal(r.changed, true);
    assert.equal(r.mission.status, "planned", "selection does not activate");
    await assert.rejects(approveMissionPlan(d, m.id, WS, USER, { expectedRevision: rev0 }), (e: MissionError) => e.status === 409);
    const ok = await approveMissionPlan(d, m.id, WS, USER, { expectedRevision: r.planRevision });
    assert.equal(ok.transitioned, true);
    const events = await d.store.listEvents(m.id, WS);
    assert.ok(events.some((e) => e.step === "mission.plan_alternative_selected"));
  });
  it("choosing is bookkeeping: it adds no counted step and no progress", async () => {
    const d = deps();
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    await selectPlanAlternative(d, m.id, WS, USER, { alternativeId: "drafts-only", expectedRevision: planRevision(m.planSnapshot) });
    const l = await loadMission(d, m.id, WS);
    assert.equal(l.stepCount, 0);
    assert.equal(l.progress, 0);
  });
  it("is a no-op for the current plan and refuses a stale revision or unknown id", async () => {
    const d = deps();
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    const rev0 = planRevision(m.planSnapshot);
    const same = await selectPlanAlternative(d, m.id, WS, USER, { alternativeId: "as-templated", expectedRevision: rev0 });
    assert.equal(same.changed, false);
    await assert.rejects(selectPlanAlternative(d, m.id, WS, USER, { alternativeId: "drafts-only", expectedRevision: "stale" }), (e: MissionError) => e.status === 409);
    await assert.rejects(selectPlanAlternative(d, m.id, WS, USER, { alternativeId: "nope", expectedRevision: rev0 }), (e: MissionError) => e.status === 400);
  });
  it("refuses once the mission is active", async () => {
    const d = deps();
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    const rev0 = planRevision(m.planSnapshot);
    await approveMissionPlan(d, m.id, WS, USER, { expectedRevision: rev0 });
    await assert.rejects(selectPlanAlternative(d, m.id, WS, USER, { alternativeId: "drafts-only", expectedRevision: rev0 }), (e: MissionError) => e.status === 409);
  });
  it("refuses in another workspace and when frozen", async () => {
    const d = deps();
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    const rev0 = planRevision(m.planSnapshot);
    await assert.rejects(selectPlanAlternative(d, m.id, "ws_other", USER, { alternativeId: "drafts-only", expectedRevision: rev0 }), (e: MissionError) => e.status === 404);
    const frozen = { ...d, isWorkspaceFrozen: async () => true };
    await assert.rejects(selectPlanAlternative(frozen, m.id, WS, USER, { alternativeId: "drafts-only", expectedRevision: rev0 }));
  });
  it("two concurrent choices from the same revision: exactly one wins", async () => {
    const d = deps();
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    const rev0 = planRevision(m.planSnapshot);
    const res = await Promise.allSettled([
      selectPlanAlternative(d, m.id, WS, USER, { alternativeId: "drafts-only", expectedRevision: rev0 }),
      selectPlanAlternative(d, m.id, WS, USER, { alternativeId: "drafts-only", expectedRevision: rev0 }),
    ]);
    assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
    const events = (await d.store.listEvents(m.id, WS)).filter((e) => e.step === "mission.plan_alternative_selected");
    assert.equal(events.length, 1);
  });
  it("a choice racing an approval cannot swap the plan under it", async () => {
    const d = deps();
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    const rev0 = planRevision(m.planSnapshot);
    const [sel, app] = await Promise.allSettled([
      selectPlanAlternative(d, m.id, WS, USER, { alternativeId: "drafts-only", expectedRevision: rev0 }),
      approveMissionPlan(d, m.id, WS, USER, { expectedRevision: rev0 }),
    ]);
    const final = (await d.store.getMission(m.id, WS))!;
    const events = await d.store.listEvents(m.id, WS);
    const approvedRev = (events.find((e) => e.step === "mission.plan_approved")?.observation as { planRevision?: string } | undefined)?.planRevision;
    if (final.status === "active") assert.equal(approvedRev, planRevision(final.planSnapshot), "active mission runs exactly the approved revision");
    assert.ok(sel.status === "fulfilled" || app.status === "fulfilled");
  });
});

