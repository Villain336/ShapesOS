// ShapesOS — approvals inbox as agent work: agent names, modes, labels, grouping.
// Run: npx tsx --test lib/aos/__tests__/approvals.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { InboxItem } from "@/lib/approvals/types";
import { deriveMission, type MissionInput } from "../agents";
import {
  approvalAgent,
  approvalBody,
  approvalMode,
  approvalQuestion,
  displayRequester,
  approvalsBanner,
  approveLabelFor,
  decisionToast,
  editLabelFor,
  groupApprovals,
  missionAgentIndex,
} from "../approvals";

function item(p: Partial<InboxItem> & Pick<InboxItem, "key" | "source">): InboxItem {
  return {
    id: p.key,
    typeLabel: "Thing",
    title: "Do the thing",
    detail: null,
    requestedBy: null,
    requester: null,
    createdAt: "2026-10-04T09:00:00.000Z",
    expiresAt: null,
    risk: "low",
    href: "/dashboard/x",
    canDecide: true,
    blockedReason: null,
    approve: { method: "POST", url: "/a", body: {} },
    deny: { method: "POST", url: "/d", body: {} },
    agent: null,
    missionId: null,
    missionName: null,
    lines: [],
    lineTotal: 0,
    ...p,
  };
}

const renewals: MissionInput = {
  id: "m1",
  name: "October renewal emails",
  status: "active",
  createdAt: "2026-10-04T08:00:00.000Z",
  updatedAt: "2026-10-04T08:30:00.000Z",
  planTotal: 7,
  pendingApprovals: 2,
  events: [
    { ts: "2026-10-04T08:01:00.000Z", actor: "chief-strategy-agent", step: "route.1", args: { nextAgent: "analyst", taskLabel: "Find accounts" } },
    { ts: "2026-10-04T08:02:00.000Z", actor: "analyst", step: "exec.1", observation: { summary: "Found 14." } },
    { ts: "2026-10-04T08:03:00.000Z", actor: "chief-strategy-agent", step: "route.2", args: { nextAgent: "drafter", taskLabel: "Draft reminders" } },
  ],
};

describe("missionAgentIndex / approvalAgent", () => {
  const index = missionAgentIndex([deriveMission(renewals)!]);

  it("names the sub-agent waiting on the human", () => {
    assert.equal(index.m1!.agent, "Writer");
    assert.equal(index.m1!.missionName, "October renewal emails");
    assert.equal(approvalAgent(item({ key: "mission:a", source: "mission", missionId: "m1" }), index), "Writer");
  });

  it("falls back to the lead for unknown missions, and the requester elsewhere", () => {
    assert.equal(approvalAgent(item({ key: "mission:b", source: "mission", missionId: "zz" }), index), "Strategist");
    assert.equal(approvalAgent(item({ key: "spend:1", source: "spend", requester: "Jordan Lee" }), index), "Jordan Lee");
    assert.equal(approvalAgent(item({ key: "mail:1", source: "mail" }), index), "Direct mail");
  });
});

describe("approvalMode", () => {
  it("decide inline only with both actions and the right role", () => {
    assert.equal(approvalMode(item({ key: "a", source: "mission" })), "decide");
    assert.equal(approvalMode(item({ key: "b", source: "media", approve: null, deny: null })), "review");
    assert.equal(approvalMode(item({ key: "c", source: "mission", canDecide: false, approve: null, deny: null })), "blocked");
  });
});

describe("labels", () => {
  it("approve says what happens", () => {
    assert.equal(approveLabelFor({ source: "mission", title: "Send renewal emails", typeLabel: "Mission · tier 2" }), "Approve and send");
    assert.equal(approveLabelFor({ source: "mission", title: "Publish offer post", typeLabel: "Mission · tier 2" }), "Approve and publish");
    assert.equal(approveLabelFor({ source: "social", title: "New spring menu", typeLabel: "Social post" }), "Approve and publish");
    assert.equal(approveLabelFor({ source: "messaging", title: "Hello → Priya", typeLabel: "Nurture send" }), "Approve and send");
    assert.equal(approveLabelFor({ source: "spend", title: "Increase budget campaign", typeLabel: "Ad spend · budget" }), "Approve");
  });

  it("edit where the queue holds a draft, open elsewhere", () => {
    assert.equal(editLabelFor({ source: "messaging" }), "Edit draft");
    assert.equal(editLabelFor({ source: "cad" }), "Open");
  });

  it("the result keeps the verb", () => {
    assert.equal(decisionToast({ source: "mission", title: "Send renewal emails", typeLabel: "Mission" }, "approve").title, "Approved and sent");
    assert.equal(decisionToast({ source: "cad", title: "Widen the bracket", typeLabel: "CAD change" }, "approve").title, "Approved");
    assert.equal(decisionToast({ source: "cad", title: "Widen the bracket", typeLabel: "CAD change" }, "deny").title, "Denied");
  });
});

describe("groupApprovals", () => {
  const index = missionAgentIndex([deriveMission(renewals)!]);

  it("hangs mission items under lead → waiting sub-agent; the rest stand alone", () => {
    const items = [
      item({ key: "mission:1", source: "mission", missionId: "m1" }),
      item({ key: "spend:1", source: "spend" }),
      item({ key: "mission:2", source: "mission", missionId: "m1" }),
      item({ key: "mission:3", source: "mission", missionId: "m9", missionName: "Spring push" }),
    ];
    const g = groupApprovals(items, index);
    assert.equal(g.lead?.name, "Strategist");
    assert.equal(g.lead?.isLead, true);
    assert.match(g.lead!.line, /3 approvals waiting on you across 2 missions/);
    assert.deepEqual(g.groups.map((x) => [x.node.name, x.items.map((i) => i.key)]), [
      ["Writer", ["mission:1", "mission:2"]],
      ["Strategist", ["mission:3"]],
    ]);
    assert.match(g.groups[1]!.node.line, /^Spring push · 1 approval waiting$/);
    assert.ok(g.groups.every((x) => x.node.status === "needs"));
    assert.deepEqual(g.other.map((i) => i.key), ["spend:1"]);
  });

  it("no lead row when nothing came from a mission", () => {
    const g = groupApprovals([item({ key: "cad:1", source: "cad" })]);
    assert.equal(g.lead, null);
    assert.equal(g.groups.length, 0);
  });
});

describe("approvalsBanner", () => {
  it("counts what this viewer can decide and names who asked", () => {
    const index = missionAgentIndex([deriveMission(renewals)!]);
    const b = approvalsBanner(
      [
        item({ key: "mission:1", source: "mission", missionId: "m1" }),
        item({ key: "spend:1", source: "spend", requester: "Jordan Lee" }),
        item({ key: "cad:1", source: "cad", canDecide: false }),
      ],
      index,
    );
    assert.equal(b?.title, "2 approvals are waiting on you");
    assert.equal(b?.description, "Writer and Jordan Lee paused for your approval. Nothing goes out until you decide.");
  });

  it("is absent when nothing waits on this viewer", () => {
    assert.equal(approvalsBanner([item({ key: "x", source: "cad", canDecide: false })]), null);
  });
});

describe("card copy", () => {
  const index = missionAgentIndex([deriveMission(renewals)!]);

  it("the queue's agent wins; internal id prefixes never show", () => {
    assert.equal(approvalAgent(item({ key: "scheduler:1", source: "scheduler", agent: "Review replies", requester: "admin:a@b.co" })), "Review replies");
    assert.equal(approvalAgent(item({ key: "spend:2", source: "spend", requester: "admin:a@b.co" })), "a@b.co");
    assert.equal(displayRequester("Jordan Lee"), "Jordan Lee");
    assert.equal(displayRequester(null), null);
  });

  it("verb-first requests read as the question; mission bodies say who paused what", () => {
    assert.equal(approvalQuestion({ source: "mission", title: "Send renewal emails" }), "Send renewal emails?");
    assert.equal(approvalQuestion({ source: "messaging", title: "Hello → Priya" }), "Hello → Priya");
    assert.equal(
      approvalBody(item({ key: "mission:1", source: "mission", missionId: "m1", detail: "x" }), index),
      "Writer paused October renewal emails for your approval. Nothing goes out until you decide.",
    );
    assert.equal(approvalBody(item({ key: "cad:1", source: "cad", detail: "Model v3" })), "Model v3");
  });
});
