// Marketr — Phase 9 M4: mission engine tests (docs/specs/SPEC-PHASE9.md §P9C).
// Run: npx tsx --test lib/missions/__tests__/engine.test.ts
//
// Memory-store backed throughout (the Prisma twin is exercised by the API
// layer; the engine is store-agnostic by design).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getTemplate, listTemplates, MISSION_TEMPLATES, templatesByBusinessType } from "../templates";
import { checkTermination, validateGoal, missionProgress } from "../types";
import { createMemoryMissionStore } from "../store";
import {
  appendStepEvent,
  approveMissionPlan,
  checkpoint,
  createStalenessVerifier,
  decideApproval,
  loadMission,
  pauseMission,
  planRevision,
  resumeMission,
  startMission,
  type EngineDeps,
} from "../engine";

const WS = "ws_missions_test";
const USER = "user_test_1";

function deps(overrides: Partial<EngineDeps> = {}): EngineDeps {
  return {
    store: createMemoryMissionStore(),
    isWorkspaceFrozen: async () => false,
    isMissionPaused: async () => false,
    ...overrides,
  };
}

const GOOD_GOAL = { metric: "booked_jobs", targetValue: 40, unit: "jobs", timeframeDays: 90, baseline: 22 };

// Start + approve the plan: most tests exercise an ACTIVE mission. The
// whole-plan gate itself is covered in the startMission / approveMissionPlan
// blocks below.
async function started(d: EngineDeps, goal: unknown = GOOD_GOAL, templateId = "home-services.booked-job-growth") {
  const m = await startMission(d, { workspaceId: WS, userId: USER, templateId, goal });
  const { mission } = await approveMissionPlan(d, m.id, WS, USER);
  return mission;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

describe("mission templates", () => {
  it("ships 12 templates across the 5 locked business types", () => {
    assert.equal(MISSION_TEMPLATES.length, 12);
    const byType = templatesByBusinessType();
    for (const bt of ["home-services", "local-services", "saas", "ecommerce", "professional-services"] as const) {
      assert.ok(byType[bt].length >= 2 && byType[bt].length <= 3, `${bt} should have 2-3 templates`);
    }
  });

  it("every template has 2-3 goals, a plan skeleton, checkpoints, playbook refs", () => {
    for (const t of listTemplates()) {
      assert.ok(t.goals.length >= 2 && t.goals.length <= 3, `${t.id} goals`);
      assert.ok(t.plan.length >= 5, `${t.id} plan skeleton`);
      assert.ok(t.successMetrics.length > 0, `${t.id} success metrics`);
      assert.ok(t.typicalCheckpoints.length > 0, `${t.id} checkpoints`);
      assert.ok(t.playbookRefs.length > 0, `${t.id} playbook refs`);
      // plan orders are sequential from 1
      t.plan.forEach((s, i) => assert.equal(s.order, i + 1, `${t.id} step order`));
    }
  });

  it("getTemplate throws on unknown template id", () => {
    assert.throws(() => getTemplate("nope.unknown"), /Unknown mission template/);
  });

  it("each locked example goal exists (spec §P9C examples)", () => {
    const byId = Object.fromEntries(MISSION_TEMPLATES.map((t) => [t.id, t]));
    const has = (id: string, metric: string) =>
      assert.ok(byId[id].goals.some((g) => g.metric === metric), `${id} should have goal ${metric}`);
    has("home-services.booked-job-growth", "booked_jobs");
    has("home-services.review-velocity", "new_reviews");
    has("home-services.slow-season-fill", "maintenance_plan_signups");
    has("local-services.quote-request-volume", "quote_requests");
    has("local-services.gbp-visibility", "gbp_views");
    has("saas.trial-starts", "trial_starts");
    has("saas.trial-to-paid", "trial_to_paid_rate");
    has("saas.churn-reduction", "churn_rate");
    has("ecommerce.repeat-purchase", "repeat_purchase_rate");
    has("ecommerce.cart-recovery", "recovered_carts");
    has("professional-services.consultation-bookings", "consultations_booked");
    has("professional-services.proposal-win-rate", "proposal_win_rate");
  });
});

// ---------------------------------------------------------------------------
// Goal validation
// ---------------------------------------------------------------------------

describe("goal validation", () => {
  it("accepts a well-formed goal with defaults", () => {
    const g = validateGoal(GOOD_GOAL);
    assert.equal(g.direction, "increase");
    assert.equal(g.baseline, 22);
  });

  it("rejects missing/empty metric", () => {
    assert.throws(() => validateGoal({ ...GOOD_GOAL, metric: " " }), /goal\.metric/);
    assert.throws(() => validateGoal({ targetValue: 1, timeframeDays: 7 }), /goal\.metric/);
  });

  it("rejects non-positive or non-finite targetValue", () => {
    assert.throws(() => validateGoal({ ...GOOD_GOAL, targetValue: 0 }), /targetValue/);
    assert.throws(() => validateGoal({ ...GOOD_GOAL, targetValue: -5 }), /targetValue/);
    assert.throws(() => validateGoal({ ...GOOD_GOAL, targetValue: NaN }), /targetValue/);
  });

  it("rejects bad timeframeDays", () => {
    assert.throws(() => validateGoal({ ...GOOD_GOAL, timeframeDays: 0 }), /timeframeDays/);
    assert.throws(() => validateGoal({ ...GOOD_GOAL, timeframeDays: 366 }), /timeframeDays/);
    assert.throws(() => validateGoal({ ...GOOD_GOAL, timeframeDays: 7.5 }), /timeframeDays/);
  });

  it("rejects bad direction", () => {
    assert.throws(() => validateGoal({ ...GOOD_GOAL, direction: "sideways" }), /direction/);
  });
});

// ---------------------------------------------------------------------------
// startMission (Tier 0)
// ---------------------------------------------------------------------------

describe("startMission", () => {
  let d: EngineDeps;
  beforeEach(() => {
    d = deps();
  });

  it("creates a PLANNED mission with plan snapshot + genesis event; executes nothing until a person approves the plan", async () => {
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: "home-services.booked-job-growth", goal: GOOD_GOAL });
    assert.equal(m.status, "planned");
    assert.equal(m.template, "home-services.booked-job-growth");
    const snap = m.planSnapshot as { steps: unknown[] };
    assert.ok(Array.isArray(snap.steps) && snap.steps.length > 0, "plan snapshot written");
    const events = await d.store.listEvents(m.id, WS);
    assert.equal(events.length, 1, "genesis only — no activation before plan approval");
    assert.equal(events[0].step, "mission.genesis");
    assert.equal(events[0].prevHash, "GENESIS");
    // Tier 0: no executor/tool events — only engine bookkeeping
    assert.ok(events.every((e) => e.tool === null), "no tool calls on start");

    // The whole-plan gate: a person's approval activates the mission.
    const { mission: activated, transitioned } = await approveMissionPlan(d, m.id, WS, USER);
    assert.equal(transitioned, true);
    assert.equal(activated.status, "active");
    const after = await d.store.listEvents(m.id, WS);
    assert.equal(after[1].step, "mission.plan_approved");
    assert.equal(after[1].prevHash, after[0].eventHash, "hash chain links");
    assert.equal(after[2].step, "mission.activated");
    assert.equal(after[2].prevHash, after[1].eventHash, "hash chain links");
  });

  it("stores the user-supplied name as the goal label", async () => {
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: "saas.trial-starts", goal: { metric: "trial_starts", targetValue: 500, timeframeDays: 90 }, name: "Q4 trial push" });
    assert.equal((m.goal as { label: string }).label, "Q4 trial push");
  });

  it("defaults the name to the template name", async () => {
    const m = await started(d);
    assert.equal((m.goal as { label: string }).label, "Booked-job growth");
  });

  it("404s on unknown template, 400s on bad goal", async () => {
    await assert.rejects(started(d, GOOD_GOAL, "nope.x"), (e: Error) => /Unknown mission template/.test(e.message));
    await assert.rejects(started(d, { metric: "", targetValue: 1, timeframeDays: 7 }), /goal\.metric/);
  });

  it("checks the workspace freeze FIRST (before template/goal validation)", async () => {
    const frozen = deps({ isWorkspaceFrozen: async () => true });
    await assert.rejects(started(frozen, GOOD_GOAL, "nope.x"), /frozen/i);
    // nothing was created
    assert.equal((await frozen.store.listMissions(WS)).length, 0);
  });
});

// ---------------------------------------------------------------------------
// approveMissionPlan (the whole-plan gate)
// ---------------------------------------------------------------------------

describe("approveMissionPlan", () => {
  let d: EngineDeps;
  beforeEach(() => {
    d = deps();
  });

  it("is idempotent on an already-active mission — a repeat approval activates nothing twice", async () => {
    const m = await started(d);
    const before = await d.store.listEvents(m.id, WS);
    const again = await approveMissionPlan(d, m.id, WS, USER);
    assert.equal(again.transitioned, false);
    assert.equal(again.mission.status, "active");
    const after = await d.store.listEvents(m.id, WS);
    assert.equal(after.length, before.length, "no duplicate plan_approved/activated events");
  });

  it("rejects approving the plan of a mission that is not planned", async () => {
    const m = await started(d);
    await pauseMission(d, m.id, WS);
    await assert.rejects(approveMissionPlan(d, m.id, WS, USER), /status "paused"/);
  });

  it("404s on an unknown mission", async () => {
    await assert.rejects(approveMissionPlan(d, "nope", WS, USER), /not found/i);
  });

  it("checks the workspace freeze FIRST", async () => {
    const frozen = deps({ isWorkspaceFrozen: async () => true });
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: "home-services.booked-job-growth", goal: GOOD_GOAL });
    await assert.rejects(approveMissionPlan(frozen, m.id, WS, USER), /frozen/i);
  });

  it("binds the approval to the reviewed plan revision — a changed plan is refused (409)", async () => {
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: "home-services.booked-job-growth", goal: GOOD_GOAL });
    const reviewed = planRevision(m.planSnapshot);
    await assert.rejects(
      approveMissionPlan(d, m.id, WS, USER, { expectedRevision: "stale-revision" }),
      (e: Error) => /changed since you reviewed/.test(e.message) && (e as { status?: number }).status === 409,
    );
    assert.equal((await d.store.getMission(m.id, WS))!.status, "planned", "still gated after a refused approval");
    const { transitioned } = await approveMissionPlan(d, m.id, WS, USER, { expectedRevision: reviewed });
    assert.equal(transitioned, true);
  });

  it("planRevision is stable for the same plan and changes with the plan", async () => {
    const a = planRevision({ steps: [{ order: 1, title: "A" }] });
    const same = planRevision({ steps: [{ title: "A", order: 1 }] });
    const different = planRevision({ steps: [{ order: 1, title: "B" }] });
    assert.equal(a, same, "key order does not change the revision");
    assert.notEqual(a, different, "content changes the revision");
  });

  it("records the approved plan revision on the timeline", async () => {
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: "home-services.booked-job-growth", goal: GOOD_GOAL });
    const reviewed = planRevision(m.planSnapshot);
    await approveMissionPlan(d, m.id, WS, USER, { expectedRevision: reviewed });
    const events = await d.store.listEvents(m.id, WS);
    const approved = events.find((e) => e.step === "mission.plan_approved")!;
    assert.equal((approved.observation as { planRevision?: string }).planRevision, reviewed);
  });

  it("concurrent approvals converge: one transition, one plan_approved event", async () => {
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: "home-services.booked-job-growth", goal: GOOD_GOAL });
    const [a, b] = await Promise.all([
      approveMissionPlan(d, m.id, WS, USER),
      approveMissionPlan(d, m.id, WS, USER),
    ]);
    assert.equal([a.transitioned, b.transitioned].filter(Boolean).length, 1, "exactly one approval transitions");
    assert.equal((await d.store.getMission(m.id, WS))!.status, "active");
    const events = await d.store.listEvents(m.id, WS);
    assert.equal(events.filter((e) => e.step === "mission.plan_approved").length, 1, "no duplicate approval events");
    assert.equal(events.filter((e) => e.step === "mission.activated").length, 1, "no duplicate activation events");
  });

  it("an approved mission whose plan changed afterwards cannot (re-)launch under the old approval", async () => {
    const m = await started(d);
    await d.store.updateMission(m.id, WS, { planSnapshot: { templateId: "home-services.booked-job-growth", steps: [{ order: 1, title: "Swapped step" }] } });
    await assert.rejects(approveMissionPlan(d, m.id, WS, USER), /changed after it was approved/);
  });

  it("pauseMission refuses a planned mission — no planned->paused->resume bypass of the plan gate", async () => {
    const m = await startMission(d, { workspaceId: WS, userId: USER, templateId: "home-services.booked-job-growth", goal: GOOD_GOAL });
    await assert.rejects(pauseMission(d, m.id, WS), /planned/);
    assert.equal((await d.store.getMission(m.id, WS))!.status, "planned");
  });
});

// ---------------------------------------------------------------------------
// Termination conditions (in code, never "the LLM says it's done")
// ---------------------------------------------------------------------------

describe("checkTermination", () => {
  const base = {
    goal: { metric: "booked_jobs", targetValue: 40, direction: "increase" as const },
    maxSteps: 48,
    stepCount: 5,
    maxCostCents: 60_000,
    totalCostCents: 1_000,
    deadlineAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    maxConsecutiveFailures: 3,
    consecutiveFailures: 0,
  };

  it("not done in the normal case", () => {
    assert.deepEqual(checkTermination(base), { done: false, reason: null });
  });

  it("goal_met (increase): currentValue >= target", () => {
    const r = checkTermination({ ...base, goal: { ...base.goal, currentValue: 42 } });
    assert.deepEqual(r, { done: true, reason: "goal_met" });
  });

  it("goal_met (decrease): currentValue <= target", () => {
    const r = checkTermination({
      ...base,
      goal: { metric: "churn_rate", targetValue: 3, direction: "decrease", currentValue: 2.5 },
    });
    assert.deepEqual(r, { done: true, reason: "goal_met" });
  });

  it("goal_met wins over step limit pressure", () => {
    const r = checkTermination({ ...base, stepCount: 48, goal: { ...base.goal, currentValue: 40 } });
    assert.deepEqual(r, { done: true, reason: "goal_met" });
  });

  it("step_limit", () => {
    assert.deepEqual(checkTermination({ ...base, stepCount: 48 }).reason, "step_limit");
  });

  it("cost_budget", () => {
    assert.deepEqual(checkTermination({ ...base, totalCostCents: 60_000 }).reason, "cost_budget");
  });

  it("timeout", () => {
    assert.deepEqual(
      checkTermination({ ...base, deadlineAt: new Date(Date.now() - 1_000).toISOString() }).reason,
      "timeout",
    );
  });

  it("consecutive_failures", () => {
    assert.deepEqual(checkTermination({ ...base, consecutiveFailures: 3 }).reason, "consecutive_failures");
  });
});

describe("termination via engine", () => {
  it("appendStepEvent flips to complete + appends terminal event on goal_met", async () => {
    const d = deps();
    const m = await started(d);
    // report goal progress to the target, then append a step -> termination fires
    await appendStepEvent(d, m.id, WS, {
      actor: "analyst",
      step: "weekly-attribution",
      tool: "analyze_results",
      observation: { goalProgress: { metric: "booked_jobs", currentValue: 40 }, summary: "hit 40 booked jobs" },
    });
    const loaded = await loadMission(d, m.id, WS);
    assert.equal(loaded.mission.status, "complete");
    assert.deepEqual(loaded.termination, { done: true, reason: "goal_met" });
    const last = loaded.events[loaded.events.length - 1];
    assert.equal(last.step, "mission.terminated");
    assert.equal((last.observation as { reason: string }).reason, "goal_met");
  });

  it("consecutive failures counted from trailing failed step events", async () => {
    const d = deps();
    const m = await started(d);
    await appendStepEvent(d, m.id, WS, { actor: "e", step: "s1", observation: { failure: true } });
    await appendStepEvent(d, m.id, WS, { actor: "e", step: "s2", observation: { failure: true } });
    // meta events don't break or extend the run
    await appendStepEvent(d, m.id, WS, { actor: "mission-engine", step: "checkpoint", observation: {} });
    let loaded = await loadMission(d, m.id, WS);
    assert.equal(loaded.consecutiveFailures, 2);
    await appendStepEvent(d, m.id, WS, { actor: "e", step: "s3", observation: { failure: true } });
    loaded = await loadMission(d, m.id, WS);
    assert.equal(loaded.mission.status, "complete");
    assert.equal(loaded.termination.reason, "consecutive_failures");
  });

  it("a success breaks the failure run", async () => {
    const d = deps();
    const m = await started(d);
    await appendStepEvent(d, m.id, WS, { actor: "e", step: "s1", observation: { failure: true } });
    await appendStepEvent(d, m.id, WS, { actor: "e", step: "s2", observation: { summary: "ok" } });
    const loaded = await loadMission(d, m.id, WS);
    assert.equal(loaded.consecutiveFailures, 0);
    assert.equal(loaded.mission.status, "active");
  });
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

describe("checkpoint", () => {
  it("persists a checkpoint record + appends a checkpoint event", async () => {
    const d = deps();
    const m = await started(d);
    await appendStepEvent(d, m.id, WS, { actor: "researcher", step: "audit-local-presence", costCents: 250 });
    const { mission, checkpoint: cp, termination } = await checkpoint(d, m.id, WS, "after_step", USER);
    assert.equal(cp.reason, "after_step");
    assert.equal(mission.checkpoints.length, 1);
    assert.equal(cp.snapshot.stepCount, 1);
    assert.equal(cp.snapshot.totalCostCents, 250);
    assert.equal(termination.done, false);
    const events = await d.store.listEvents(m.id, WS);
    const last = events[events.length - 1];
    assert.equal(last.step, "checkpoint");
    assert.equal((last.observation as { reason: string }).reason, "after_step");
    // chain intact across all writes
    for (let i = 1; i < events.length; i++) {
      assert.equal(events[i].prevHash, events[i - 1].eventHash, `chain link ${i}`);
    }
  });

  it("checks frozen + paused FIRST", async () => {
    const d = deps();
    const m = await started(d);
    const frozen = deps({ store: d.store, isWorkspaceFrozen: async () => true });
    await assert.rejects(checkpoint(frozen, m.id, WS, "manual"), /frozen/i);
    const paused = deps({ store: d.store, isMissionPaused: async () => true });
    await assert.rejects(checkpoint(paused, m.id, WS, "manual"), /paused/i);
    assert.equal((await d.store.getMission(m.id, WS))!.checkpoints.length, 0);
  });

  it("supports every hybrid checkpoint reason", async () => {
    const d = deps();
    const m = await started(d);
    const reasons = ["after_step", "before_irreversible", "cost_budget_fraction", "after_approval", "on_error", "time_safety_net", "mission_start", "manual"] as const;
    for (const r of reasons) {
      const { checkpoint: cp } = await checkpoint(d, m.id, WS, r);
      assert.equal(cp.reason, r);
    }
    assert.equal((await d.store.getMission(m.id, WS))!.checkpoints.length, reasons.length);
  });
});

// ---------------------------------------------------------------------------
// Pause -> resume staleness flow (engine-level; killswitch consumes the verifier)
// ---------------------------------------------------------------------------

describe("resume staleness re-verification", () => {
  const FRESH_AS_OF = () => Promise.resolve(new Date());

  it("fresh mission: all checks pass", async () => {
    const d = deps();
    const m = await started(d);
    const verify = createStalenessVerifier({ store: d.store, getGraphNewestAsOf: FRESH_AS_OF });
    const report = await verify(m.id, WS);
    assert.equal(report.fresh, true);
    assert.deepEqual(report.checks.map((c) => c.name), ["cost_budget", "data_freshness", "goal_assumptions"]);
    assert.ok(report.checks.every((c) => c.ok));
    // no blocking event on the fresh path
    const events = await d.store.listEvents(m.id, WS);
    assert.ok(!events.some((e) => e.step === "killswitch.resume_blocked"));
  });

  it("stale graph data blocks resume + appends a human-review event", async () => {
    const d = deps();
    const m = await started(d);
    const old = new Date(Date.now() - 20 * 86_400_000);
    const verify = createStalenessVerifier({ store: d.store, getGraphNewestAsOf: async () => old });
    const report = await verify(m.id, WS);
    assert.equal(report.fresh, false);
    const freshness = report.checks.find((c) => c.name === "data_freshness")!;
    assert.equal(freshness.ok, false);
    const events = await d.store.listEvents(m.id, WS);
    const blocked = events.filter((e) => e.step === "killswitch.resume_blocked");
    assert.equal(blocked.length, 1);
    assert.equal((blocked[0].observation as { action: string }).action, "human review required before resume");
  });

  it("exceeded cost budget blocks resume", async () => {
    const d = deps();
    const m = await started(d);
    await appendStepEvent(d, m.id, WS, { actor: "e", step: "expensive-step", costCents: 60_000 });
    const verify = createStalenessVerifier({ store: d.store, getGraphNewestAsOf: FRESH_AS_OF });
    const report = await verify(m.id, WS);
    assert.equal(report.fresh, false);
    assert.equal(report.checks.find((c) => c.name === "cost_budget")!.ok, false);
  });

  it("deadline blown past grace blocks resume", async () => {
    const d = deps();
    const m = await startMission(
      { ...d, now: () => new Date(Date.now() - 100 * 86_400_000) },
      { workspaceId: WS, userId: USER, templateId: "saas.churn-reduction", goal: { metric: "churn_rate", targetValue: 3, timeframeDays: 90, direction: "decrease" } },
    );
    const verify = createStalenessVerifier({ store: d.store, getGraphNewestAsOf: FRESH_AS_OF });
    const report = await verify(m.id, WS);
    assert.equal(report.fresh, false);
    assert.equal(report.checks.find((c) => c.name === "goal_assumptions")!.ok, false);
  });

  it("no graph data yet is NOT stale (nothing to go stale)", async () => {
    const d = deps();
    const m = await started(d);
    const verify = createStalenessVerifier({ store: d.store, getGraphNewestAsOf: async () => null });
    const report = await verify(m.id, WS);
    assert.equal(report.fresh, true);
  });

  it("pause -> resume round trip at the engine level", async () => {
    const d = deps();
    const m = await started(d);
    // simulate the killswitch pause (killswitch.resumeMission consumes the same verifier)
    await d.store.updateMission(m.id, WS, { status: "paused" });
    const verify = createStalenessVerifier({ store: d.store, getGraphNewestAsOf: FRESH_AS_OF });
    const report = await verify(m.id, WS);
    assert.equal(report.fresh, true);
    // fresh -> resume flips back to active (this is what killswitch.resumeMission does after verify)
    await d.store.updateMission(m.id, WS, { status: "active" });
    assert.equal((await d.store.getMission(m.id, WS))!.status, "active");
    // stale -> stays paused
    await d.store.updateMission(m.id, WS, { status: "paused" });
    const staleVerify = createStalenessVerifier({
      store: d.store,
      getGraphNewestAsOf: async () => new Date(Date.now() - 30 * 86_400_000),
    });
    const stale = await staleVerify(m.id, WS);
    assert.equal(stale.fresh, false);
    assert.equal((await d.store.getMission(m.id, WS))!.status, "paused");
  });
});

// ---------------------------------------------------------------------------
// pauseMission / resumeMission (kill-switch twins, store-backed)
// ---------------------------------------------------------------------------

describe("pauseMission / resumeMission", () => {
  const FRESH = () => Promise.resolve(new Date());

  it("pause: active -> paused + killswitch.pause event; idempotent", async () => {
    const d = deps();
    const m = await started(d);
    const paused = await pauseMission(d, m.id, WS, USER);
    assert.equal(paused.status, "paused");
    const events = await d.store.listEvents(m.id, WS);
    const last = events[events.length - 1];
    assert.equal(last.step, "killswitch.pause");
    assert.deepEqual(last.observation, { from: "active", to: "paused" });
    // idempotent second pause
    const again = await pauseMission(d, m.id, WS, USER);
    assert.equal(again.status, "paused");
  });

  it("pause rejects complete missions and unknown missions", async () => {
    const d = deps();
    const m = await started(d);
    await d.store.updateMission(m.id, WS, { status: "complete" });
    await assert.rejects(pauseMission(d, m.id, WS), /Cannot pause mission in status "complete"/);
    await assert.rejects(pauseMission(d, "nope", WS), /not found/i);
  });

  it("pause checks the workspace freeze first", async () => {
    const d = deps();
    const m = await started(d);
    const frozen = deps({ store: d.store, isWorkspaceFrozen: async () => true });
    await assert.rejects(pauseMission(frozen, m.id, WS), /frozen/i);
    assert.equal((await d.store.getMission(m.id, WS))!.status, "active");
  });

  it("resume fresh: paused -> active + killswitch.resume event carrying the report", async () => {
    const d = deps();
    const m = await started(d);
    await pauseMission(d, m.id, WS, USER);
    const verify = createStalenessVerifier({ store: d.store, getGraphNewestAsOf: FRESH });
    const { mission, report } = await resumeMission(d, m.id, WS, {
      actor: USER,
      verifyStaleness: (mid, ws) => verify(mid, ws),
    });
    assert.equal(mission.status, "active");
    assert.equal(report.fresh, true);
    const events = await d.store.listEvents(m.id, WS);
    const last = events[events.length - 1];
    assert.equal(last.step, "killswitch.resume");
    assert.equal(last.actor, USER);
    assert.deepEqual((last.observation as { stalenessReport: unknown }).stalenessReport, report);
  });

  it("resume stale: stays paused + human-review event, throws", async () => {
    const d = deps();
    const m = await started(d);
    await pauseMission(d, m.id, WS, USER);
    const stale = createStalenessVerifier({
      store: d.store,
      getGraphNewestAsOf: async () => new Date(Date.now() - 30 * 86_400_000),
    });
    await assert.rejects(
      resumeMission(d, m.id, WS, { verifyStaleness: (mid, ws) => stale(mid, ws) }),
      /Staleness re-verification FAILED.*data_freshness/,
    );
    assert.equal((await d.store.getMission(m.id, WS))!.status, "paused");
    const events = await d.store.listEvents(m.id, WS);
    assert.ok(events.some((e) => e.step === "killswitch.resume_blocked"), "human-review event appended");
  });

  it("resume rejects non-paused missions and unknown missions", async () => {
    const d = deps();
    const m = await started(d);
    await assert.rejects(resumeMission(d, m.id, WS), /only paused missions resume/);
    await assert.rejects(resumeMission(d, "nope", WS), /not found/i);
  });

  it("resume without a verifier is fail-closed (stays paused)", async () => {
    const d = deps();
    const m = await started(d);
    await pauseMission(d, m.id, WS, USER);
    await assert.rejects(resumeMission(d, m.id, WS), /verifier_supplied/);
    assert.equal((await d.store.getMission(m.id, WS))!.status, "paused");
  });
});

// ---------------------------------------------------------------------------
// decideApproval (the decide-API contract M6's inbox will call)
// ---------------------------------------------------------------------------

describe("decideApproval", () => {
  let d: EngineDeps;
  let missionId: string;
  let approvalId: string;
  beforeEach(async () => {
    d = deps();
    const m = await started(d);
    missionId = m.id;
    const a = await d.store.createApproval({
      workspaceId: WS,
      missionId,
      action: "publish_offer",
      tier: 2,
      bindingJson: { channel: "owned", creative: "summer-tuneup" },
      createdBy: USER,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    approvalId = a.id;
  });

  it("approve: records decidedBy/decidedAt + appends decision event", async () => {
    const a = await decideApproval(d, { missionId, approvalId, workspaceId: WS, decision: "approved", decidedBy: USER });
    assert.equal(a.status, "approved");
    assert.equal(a.decidedBy, USER);
    assert.ok(a.decidedAt instanceof Date);
    const events = await d.store.listEvents(missionId, WS);
    const last = events[events.length - 1];
    assert.equal(last.step, "approval.decided");
    assert.equal((last.observation as { decision: string }).decision, "approved");
    assert.equal(last.actor, USER);
  });

  it("deny: same contract, denied status", async () => {
    const a = await decideApproval(d, { missionId, approvalId, workspaceId: WS, decision: "denied", decidedBy: USER });
    assert.equal(a.status, "denied");
    assert.equal(a.decidedBy, USER);
  });

  it("rejects invalid decision values", async () => {
    await assert.rejects(
      decideApproval(d, { missionId, approvalId, workspaceId: WS, decision: "maybe" as "approved", decidedBy: USER }),
      /decision must be "approved" or "denied"/,
    );
  });

  it("404s on unknown approval", async () => {
    await assert.rejects(
      decideApproval(d, { missionId, approvalId: "nope", workspaceId: WS, decision: "approved", decidedBy: USER }),
      /not found/i,
    );
  });

  it("422s when not pending (double-decide)", async () => {
    await decideApproval(d, { missionId, approvalId, workspaceId: WS, decision: "approved", decidedBy: USER });
    await assert.rejects(
      decideApproval(d, { missionId, approvalId, workspaceId: WS, decision: "denied", decidedBy: USER }),
      /only pending approvals/,
    );
  });

  it("expired: marks expired + 422s (no decision recorded)", async () => {
    const a = await d.store.createApproval({
      workspaceId: WS,
      missionId,
      action: "publish_offer",
      tier: 2,
      bindingJson: { channel: "owned" },
      createdBy: USER,
      expiresAt: new Date(Date.now() - 1_000),
    });
    await assert.rejects(
      decideApproval(d, { missionId, approvalId: a.id, workspaceId: WS, decision: "approved", decidedBy: USER }),
      /expired/i,
    );
    const after = await d.store.getApproval(a.id, WS);
    assert.equal(after!.status, "expired");
    assert.equal(after!.decidedBy, null);
  });

  it("cross-mission approval ids are rejected", async () => {
    const other = await started(d);
    await assert.rejects(
      decideApproval(d, { missionId: other.id, approvalId, workspaceId: WS, decision: "approved", decidedBy: USER }),
      /not found/i,
    );
  });

  it("frozen workspace halts decisions; paused mission halts decisions", async () => {
    const frozen = deps({ store: d.store, isWorkspaceFrozen: async () => true });
    await assert.rejects(
      decideApproval(frozen, { missionId, approvalId, workspaceId: WS, decision: "approved", decidedBy: USER }),
      /frozen/i,
    );
    const paused = deps({ store: d.store, isMissionPaused: async () => true });
    await assert.rejects(
      decideApproval(paused, { missionId, approvalId, workspaceId: WS, decision: "approved", decidedBy: USER }),
      /paused/i,
    );
    assert.equal((await d.store.getApproval(approvalId, WS))!.status, "pending");
  });
});

// ---------------------------------------------------------------------------
// loadMission rehydration + progress
// ---------------------------------------------------------------------------

describe("loadMission", () => {
  it("rehydrates mission + events + approvals + derived state", async () => {
    const d = deps();
    const m = await started(d);
    await appendStepEvent(d, m.id, WS, { actor: "researcher", step: "audit-local-presence", costCents: 100 });
    await appendStepEvent(d, m.id, WS, { actor: "planner", step: "quarter-plan", costCents: 200 });
    const loaded = await loadMission(d, m.id, WS);
    assert.equal(loaded.mission.id, m.id);
    assert.equal(loaded.stepCount, 2);
    assert.equal(loaded.totalCostCents, 300);
    assert.equal(loaded.approvals.length, 0);
    assert.equal(loaded.planStepCount, 8);
    assert.equal(loaded.progress, missionProgress(8, 2, "active"));
    assert.equal(loaded.nextCheckpoint, "Approve offer launch");
    assert.deepEqual(loaded.termination, { done: false, reason: null });
  });

  it("404s on unknown mission", async () => {
    const d = deps();
    await assert.rejects(loadMission(d, "nope", WS), /not found/i);
  });

  it("tenant isolation: another workspace sees nothing", async () => {
    const d = deps();
    const m = await started(d);
    assert.equal(await d.store.getMission(m.id, "ws_other"), null);
    await assert.rejects(loadMission(d, m.id, "ws_other"), /not found/i);
  });
});
