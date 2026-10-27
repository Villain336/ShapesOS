// ShapesOS - mission progress and cost wording.
// Run: npx tsx --test lib/missions/__tests__/progress-accounting.test.ts
//
// Regression: a mission that had just run its first three steps read "100% of goal, 16/8 steps,
// $0.14 spent". Progress divided every event (two per orchestrator hop) by the plan size, the
// planner's own follow-up runs counted as plan steps, progress was labelled as the business goal, and
// the cost model's estimate was worded as money spent.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { completedPlanStepKeys, isCountedStep, missionProgress } from "../types";
import { costSummary } from "../display";

const KEYS = ["audit-local-presence", "quarter-plan", "draft-offer", "approve-launch", "publish", "drive", "review", "cadence"];

function hop(n: number, label: string, ok = true) {
  return [
    { step: `route.${n}`, args: { taskLabel: label } },
    { step: ok ? `exec.${n}` : `exec.${n}.error`, args: {} },
  ];
}

describe("completedPlanStepKeys", () => {
  it("counts a plan step once its orchestrator run succeeded", () => {
    const events = [...hop(1, "audit-local-presence: Audit local presence"), ...hop(2, "quarter-plan: Draft 90-day plan")];
    assert.deepEqual([...completedPlanStepKeys(events, KEYS)].sort(), ["audit-local-presence", "quarter-plan"]);
  });

  it("does not count a failed run, or the planner's own follow-up runs", () => {
    const events = [
      ...hop(1, "audit-local-presence: Audit local presence", false),
      ...hop(2, "quarter-plan: Draft 90-day plan"),
      ...hop(3, "s1_research: research"),
      ...hop(4, "s2_analyze: analyze"),
      ...hop(5, "s3_draft: draft"),
      ...hop(6, "s4_schedule: schedule"),
    ];
    assert.deepEqual([...completedPlanStepKeys(events, KEYS)], ["quarter-plan"]);
  });

  it("failed plan work consumes the original step budget but does not complete a plan step", () => {
    const events = [{ step: "draft-offer", observation: { failure: true } }];
    assert.equal(completedPlanStepKeys(events, KEYS).size, 0);
    assert.equal(events.filter((e) => isCountedStep(e.step)).length, 1);
  });
  it("still counts the engine's own step events by key, once each", () => {
    const events = [{ step: "audit-local-presence" }, { step: "audit-local-presence" }, { step: "automation.flow_run" }];
    assert.deepEqual([...completedPlanStepKeys(events, KEYS)], ["audit-local-presence"]);
  });

  it("the reported case: 8 runs and 3 plan steps read as 3 of 8, never 100%", () => {
    const events = [
      ...hop(1, "audit-local-presence: a"),
      ...hop(2, "quarter-plan: b"),
      ...hop(3, "draft-offer: c"),
      ...hop(4, "s1_research: research"),
      ...hop(5, "s2_analyze: analyze"),
      ...hop(6, "s3_draft: draft"),
      ...hop(7, "s4_schedule: schedule"),
      ...hop(8, "s1_research: research"),
      { step: "complete" },
      { step: "mission.awaiting_human" },
    ];
    const done = completedPlanStepKeys(events, KEYS).size;
    assert.equal(done, 3);
    assert.equal(missionProgress(KEYS.length, done, "active"), 3 / 8);
    // The event count that feeds the maxSteps check keeps its meaning (every non-meta event).
    assert.equal(events.filter((e) => isCountedStep(e.step)).length, 18);
  });
});

describe("costSummary", () => {
  it("words the cost model's estimate as an estimate, never as spend or as a billing claim", () => {
    assert.equal(costSummary(14, 14), " · ~$0.14 model estimate, not metered");
    assert.ok(!/spent|billed/.test(costSummary(14, 14)));
  });
  it("keeps metered spend and the estimate apart", () => {
    assert.equal(costSummary(114, 14), " · $1.00 recorded cost · ~$0.14 model estimate, not metered");
    assert.equal(costSummary(250, 0), " · $2.50 recorded cost");
  });
  it("discloses a mixed total as both parts, never dropping the estimate", () => {
    const t = costSummary(300, 100);
    assert.ok(t.includes("$2.00 recorded cost") && t.includes("~$1.00 model estimate, not metered"));
  });
  it("says nothing when there is no cost", () => {
    assert.equal(costSummary(0, 0), "");
  });
});
