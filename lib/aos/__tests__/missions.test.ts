// ShapesOS — a loaded mission as agent work, and inbox fact lines.
// Run: npx tsx --test lib/aos/__tests__/missions.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { missionAgentView, missionDisplayName, missionInputFromLoaded, missionLeadNode } from "../missions";
import { factLines } from "@/lib/approvals/format";

const loaded = {
  mission: {
    id: "m1",
    template: "home-services.booked-job-growth",
    goal: { label: "October renewal emails" },
    status: "active",
    planSnapshot: { steps: [{}, {}, {}] },
    createdAt: new Date("2026-10-04T08:00:00.000Z"),
    updatedAt: "2026-10-04T08:30:00.000Z",
  },
  events: [
    { ts: new Date("2026-10-04T08:01:00.000Z"), actor: "chief-strategy-agent", step: "route.1", args: { nextAgent: "drafter", taskLabel: "Draft reminders" }, observation: {} },
  ],
  approvals: [{ status: "pending" }, { status: "approved" }],
};

describe("missionInputFromLoaded", () => {
  it("names, counts the plan and the pending approvals, ISO times", () => {
    const i = missionInputFromLoaded(loaded);
    assert.equal(i.name, "October renewal emails");
    assert.equal(i.planTotal, 3);
    assert.equal(i.pendingApprovals, 1);
    assert.equal(i.createdAt, "2026-10-04T08:00:00.000Z");
    assert.equal(i.events[0]!.ts, "2026-10-04T08:01:00.000Z");
  });

  it("falls back to the template when the goal has no label", () => {
    assert.equal(missionDisplayName({}, "saas.trial-growth"), "saas.trial-growth");
  });
});

describe("missionAgentView / missionLeadNode", () => {
  it("a live mission with a pending approval needs you; the waiting sub-agent shows it", () => {
    const v = missionAgentView(loaded)!;
    assert.equal(v.status, "needs");
    assert.deepEqual(v.branches.map((b) => [b.name, b.status]), [["Writer", "needs"]]);
    const lead = missionLeadNode(v);
    assert.equal(lead.name, "Strategist");
    assert.equal(lead.isLead, true);
    assert.equal(lead.status, "needs");
  });

  it("archived missions have no agent state", () => {
    assert.equal(missionAgentView({ ...loaded, mission: { ...loaded.mission, status: "archived" } }), null);
  });
});

describe("factLines", () => {
  it("scalar facts become card rows; ids, objects and empties are skipped", () => {
    const f = factLines({ channel: "email", recipients: 14, amountCents: 125000, templateId: "x", nested: { a: 1 }, empty: "", ok: true });
    assert.deepEqual(f.lines, [
      { label: "Channel", detail: "email" },
      { label: "Recipients", detail: "14" },
      { label: "Amount", detail: "$1,250.00" },
      { label: "Ok", detail: "Yes" },
    ]);
    assert.equal(f.total, 4);
  });

  it("previews at most `max` rows and reports the total", () => {
    const f = factLines({ a: "1", b: "2", c: "3" }, 2);
    assert.equal(f.lines.length, 2);
    assert.equal(f.total, 3);
    assert.deepEqual(factLines(null), { lines: [], total: 0 });
  });
});
