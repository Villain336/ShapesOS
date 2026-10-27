// Adoption core against the in-memory store. Imports zod via CandidateSchema, so CI-only.
// Run: npx tsx --test lib/missions/__tests__/competing-plans-adopt.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMissionStore } from "../store";
import { approveMissionPlan, planRevision, startMission, MissionError, type EngineDeps } from "../engine";
import { adoptCandidate, candidateToSnapshot, type StoredCandidate } from "../competing-plans-adopt";

const WS = "ws_adopt";
const USER = "u1";
const TPL = "home-services.booked-job-growth";
const GOAL = { metric: "booked_jobs", targetValue: 40, unit: "jobs", timeframeDays: 90, baseline: 22 };
const deps = (o: Partial<EngineDeps> = {}): EngineDeps => ({ store: createMemoryMissionStore(), isWorkspaceFrozen: async () => false, isMissionPaused: async () => false, ...o });
const cand = { summary: "s", steps: [{ key: "a", title: "A", kind: "research", executor: "researcher", description: "d" }, { key: "b", title: "B", kind: "draft", executor: "drafter", description: "e" }] };
const stored = (m: { id: string; planSnapshot: unknown }, o: Partial<StoredCandidate> = {}): StoredCandidate => ({ id: "c1", workspaceId: WS, missionId: m.id, baseRevision: planRevision(m.planSnapshot), candidate: cand, ...o });
const status = (e: unknown) => (e as MissionError).status;

describe("candidateToSnapshot", () => {
  it("maps to tier 0 steps with no checkpoint and contiguous order", () => {
    const s = candidateToSnapshot(TPL, "c1", cand);
    assert.deepEqual(s.steps.map((x) => x.order), [1, 2]);
    assert.ok(s.steps.every((x) => x.tier === 0 && x.checkpointAfter === false));
    assert.equal(s.alternativeId, "candidate:c1");
  });
  it("refuses a non-draft-safe executor, a duplicate key and an empty plan", () => {
    const bad = (steps: unknown[]) => () => candidateToSnapshot(TPL, "c1", { summary: "s", steps });
    assert.throws(bad([{ ...cand.steps[0], executor: "human" }]), (e) => status(e) === 422);
    assert.throws(bad([cand.steps[0], cand.steps[0]]), (e) => status(e) === 422);
    assert.throws(bad([]), (e) => status(e) === 422);
  });
});

describe("adoptCandidate", () => {
  it("swaps the draft, stays planned, never approves; the old revision can no longer be approved", async () => {
    const d = deps();
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    const rev0 = planRevision(m.planSnapshot);
    const r = await adoptCandidate(d, { stored: stored(m), missionId: m.id, workspaceId: WS, userId: USER, expectedRevision: rev0 });
    assert.equal(r.mission.status, "planned");
    assert.notEqual(r.planRevision, rev0);
    await assert.rejects(approveMissionPlan(d, m.id, WS, USER, { expectedRevision: rev0 }), (e) => status(e) === 409);
  });
  it("refuses another workspace's or mission's candidate as not found", async () => {
    const d = deps();
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    const rev0 = planRevision(m.planSnapshot);
    for (const o of [{ workspaceId: "other" }, { missionId: "other" }]) {
      await assert.rejects(adoptCandidate(d, { stored: stored(m, o), missionId: m.id, workspaceId: WS, userId: USER, expectedRevision: rev0 }), (e) => status(e) === 404);
    }
  });
  it("refuses a stale reviewed revision and a candidate composed against an older plan", async () => {
    const d = deps();
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    const rev0 = planRevision(m.planSnapshot);
    await assert.rejects(adoptCandidate(d, { stored: stored(m), missionId: m.id, workspaceId: WS, userId: USER, expectedRevision: "stale" }), (e) => status(e) === 409);
    await assert.rejects(adoptCandidate(d, { stored: stored(m, { baseRevision: "old" }), missionId: m.id, workspaceId: WS, userId: USER, expectedRevision: rev0 }), (e) => status(e) === 409);
  });
  it("a second adoption of the same candidate loses once the revision moved", async () => {
    const d = deps();
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    const rev0 = planRevision(m.planSnapshot);
    await adoptCandidate(d, { stored: stored(m), missionId: m.id, workspaceId: WS, userId: USER, expectedRevision: rev0 });
    await assert.rejects(adoptCandidate(d, { stored: stored(m), missionId: m.id, workspaceId: WS, userId: USER, expectedRevision: rev0 }), (e) => status(e) === 409);
  });
  it("re-validates stored steps and leaves the plan untouched on failure", async () => {
    const d = deps();
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    const rev0 = planRevision(m.planSnapshot);
    const tampered = { summary: "s", steps: [{ ...cand.steps[0], executor: "human" }] };
    await assert.rejects(adoptCandidate(d, { stored: stored(m, { candidate: tampered }), missionId: m.id, workspaceId: WS, userId: USER, expectedRevision: rev0 }), (e) => status(e) === 422);
    const again = await d.store.getMission(m.id, WS);
    assert.equal(planRevision(again!.planSnapshot), rev0);
  });
  it("refuses when frozen, paused or already approved", async () => {
    const m0 = await startMission(deps(), { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    void m0;
    for (const o of [{ isWorkspaceFrozen: async () => true }, { isMissionPaused: async () => true }]) {
      const d = deps(o as Partial<EngineDeps>);
      const m = await startMission(deps({ store: d.store }), { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
      await assert.rejects(adoptCandidate(d, { stored: stored(m), missionId: m.id, workspaceId: WS, userId: USER, expectedRevision: planRevision(m.planSnapshot) }), MissionError);
    }
    const d = deps();
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: TPL, goal: GOAL });
    const rev0 = planRevision(m.planSnapshot);
    await approveMissionPlan(d, m.id, WS, USER, { expectedRevision: rev0 });
    await assert.rejects(adoptCandidate(d, { stored: stored(m), missionId: m.id, workspaceId: WS, userId: USER, expectedRevision: rev0 }), (e) => status(e) === 409);
  });
});
