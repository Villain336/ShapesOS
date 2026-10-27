// ShapesOS — Agentic OS status language.
// Run: npx tsx --test lib/aos/__tests__/status.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AOS_STATUSES,
  SHAPE_PATHS,
  STATUS_META,
  countStatuses,
  fromAgentRunStatus,
  fromMissionStatus,
  fromSkillRunStatus,
  isAosStatus,
  rollupStatus,
  statusLabel,
} from "../status";

describe("status meta", () => {
  it("every state has a label, a shape and a path; labels are sentence case", () => {
    for (const s of AOS_STATUSES) {
      const m = STATUS_META[s];
      assert.ok(m.label && m.shape && SHAPE_PATHS[s].d, s);
      assert.equal(m.label[0], m.label[0]!.toUpperCase());
      assert.equal(m.label.slice(1), m.label.slice(1).toLowerCase());
    }
    assert.equal(statusLabel("needs"), "Needs you");
  });

  it("each colored state owns one shape and one color; queued/paused are ink only", () => {
    assert.equal(STATUS_META.running.shape, "circle");
    assert.equal(STATUS_META.needs.shape, "triangle");
    assert.equal(STATUS_META.done.shape, "quarter");
    assert.equal(STATUS_META.failed.shape, "square");
    const fills = ["running", "needs", "done", "failed"].map((s) => STATUS_META[s as "running"].fill);
    assert.equal(new Set(fills).size, 4);
    assert.match(STATUS_META.queued.mark, /ink/);
    assert.match(STATUS_META.paused.mark, /ink/);
  });

  it("text on yellow is always black; white on the other fills", () => {
    assert.equal(STATUS_META.needs.onFill, "text-ink");
    for (const s of ["running", "done", "failed"] as const) assert.equal(STATUS_META[s].onFill, "text-paper");
  });

  it("only running pulses", () => {
    assert.deepEqual(AOS_STATUSES.filter((s) => STATUS_META[s].live), ["running"]);
  });

  it("isAosStatus guards strings", () => {
    assert.ok(isAosStatus("done"));
    assert.ok(!isAosStatus("succeeded"));
    assert.ok(!isAosStatus(3));
  });
});

describe("record → status", () => {
  it("maps AgentRun statuses; cancelled has no status color", () => {
    assert.equal(fromAgentRunStatus("queued"), "queued");
    assert.equal(fromAgentRunStatus("running"), "running");
    assert.equal(fromAgentRunStatus("succeeded"), "done");
    assert.equal(fromAgentRunStatus("failed"), "failed");
    assert.equal(fromAgentRunStatus("cancelled"), null);
  });

  it("maps SkillRun statuses", () => {
    assert.equal(fromSkillRunStatus("pending"), "queued");
    assert.equal(fromSkillRunStatus("approved"), "queued");
    assert.equal(fromSkillRunStatus("awaiting_approval"), "needs");
    assert.equal(fromSkillRunStatus("running"), "running");
    assert.equal(fromSkillRunStatus("succeeded"), "done");
    assert.equal(fromSkillRunStatus("blocked"), "failed");
    assert.equal(fromSkillRunStatus("rejected"), null);
  });

  it("maps missions; a pending approval raises a live mission to needs you", () => {
    assert.equal(fromMissionStatus("planned"), "needs");
    assert.equal(fromMissionStatus("active"), "running");
    assert.equal(fromMissionStatus("paused"), "paused");
    assert.equal(fromMissionStatus("complete"), "done");
    assert.equal(fromMissionStatus("archived"), null);
    assert.equal(fromMissionStatus("active", 2), "needs");
    assert.equal(fromMissionStatus("complete", 2), "done");
  });
});

describe("rollups", () => {
  it("needs beats failed beats running beats the rest", () => {
    assert.equal(rollupStatus(["done", "running", "failed", "needs"]), "needs");
    assert.equal(rollupStatus(["done", "running", "failed"]), "failed");
    assert.equal(rollupStatus(["done", "queued", "running"]), "running");
    assert.equal(rollupStatus(["done", null, "paused"]), "paused");
    assert.equal(rollupStatus([]), null);
  });

  it("counts only the four colored states", () => {
    assert.deepEqual(countStatuses(["running", "running", "needs", "done", "queued", "paused", null]), {
      running: 2,
      needs: 1,
      done: 1,
      failed: 0,
    });
  });
});
