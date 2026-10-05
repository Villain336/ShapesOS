// ShapesOS — run timeline step states.
// Run: npx tsx --test lib/aos/__tests__/run-steps.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveRunSteps, ofCaption, progressFraction, stepCounter } from "../run-steps";

const STEPS = [
  { title: "Plan the work" },
  { title: "Search the web" },
  { title: "Read sources" },
  { title: "Draft the brief" },
  { title: "Send to your team", asksFirst: true },
];

describe("deriveRunSteps", () => {
  it("done steps, then the current step in the run's state, then queued", () => {
    const out = deriveRunSteps(STEPS, { completed: 2, status: "running" });
    assert.deepEqual(out.map((s) => s.state), ["done", "done", "running", "queued", "queued"]);
    assert.deepEqual(out.map((s) => s.current), [false, false, true, false, false]);
    assert.equal(out[4]!.asksFirst, true);
  });

  it("the current step carries needs-you / failed / paused", () => {
    assert.equal(deriveRunSteps(STEPS, { completed: 4, status: "needs" })[4]!.state, "needs");
    assert.equal(deriveRunSteps(STEPS, { completed: 1, status: "failed" })[1]!.state, "failed");
    assert.equal(deriveRunSteps(STEPS, { completed: 0, status: "paused" })[0]!.state, "paused");
  });

  it("a finished run marks every step done", () => {
    assert.ok(deriveRunSteps(STEPS, { completed: 3, status: "done" }).every((s) => s.state === "done"));
  });

  it("clamps out-of-range progress", () => {
    assert.deepEqual(
      deriveRunSteps(STEPS, { completed: -3, status: "queued" }).map((s) => s.state),
      ["queued", "queued", "queued", "queued", "queued"],
    );
    const over = deriveRunSteps(STEPS, { completed: 99, status: "running" });
    assert.ok(over.every((s) => s.state === "done"));
    assert.deepEqual(deriveRunSteps([], { completed: 0, status: "running" }), []);
  });
});

describe("progress helpers", () => {
  it("progressFraction is 0..1 and safe", () => {
    assert.equal(progressFraction(7, 12), 7 / 12);
    assert.equal(progressFraction(20, 12), 1);
    assert.equal(progressFraction(3, 0), 0);
    assert.equal(progressFraction(Number.NaN, 4), 0);
  });

  it("stepCounter names the step being worked on", () => {
    assert.equal(stepCounter(2, 7), "Step 3 of 7");
    assert.equal(stepCounter(7, 7), "Step 7 of 7");
    assert.equal(stepCounter(0, 0), "No steps yet");
    assert.equal(ofCaption(7, 12), "7 of 12");
  });
});
