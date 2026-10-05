// ShapesOS — lead agent + sub-agent tree derivation, and Overview banners.
// Run: npx tsx --test lib/aos/__tests__/agents.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LEAD_AGENT,
  SUB_AGENTS,
  deriveAgentTree,
  deriveMission,
  monogram,
  oneLine,
  visibleBranches,
  type AgentRunInput,
  type MissionEventInput,
  type MissionInput,
} from "../agents";
import { deriveBanners, failedWorkFromTree, listJoin, needsReconnect } from "../home";

const NOW = new Date("2026-10-04T12:00:00Z");
const t = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

let seq = 0;
function route(agent: string, label: string, min: number): MissionEventInput {
  seq += 1;
  return {
    ts: t(min),
    actor: "chief-strategy-agent",
    step: `route.${seq}`,
    args: { nextAgent: agent, routingReason: `routing-table -> ${agent}`, taskLabel: label },
  };
}
function exec(agent: string, summary: string, min: number): MissionEventInput {
  return { ts: t(min), actor: agent, step: `exec.${seq}`, observation: { summary } };
}
function execErr(agent: string, error: string, min: number): MissionEventInput {
  return { ts: t(min), actor: agent, step: `exec.${seq}.error`, observation: { error } };
}

function mission(over: Partial<MissionInput> = {}): MissionInput {
  return {
    id: "m1",
    name: "Weekly competitor brief",
    status: "active",
    createdAt: t(120),
    updatedAt: t(5),
    planTotal: 7,
    pendingApprovals: 0,
    events: [],
    ...over,
  };
}

describe("identity", () => {
  it("monograms are one uppercase letter; agents carry no color field", () => {
    assert.equal(monogram("researcher"), "R");
    assert.equal(monogram("  ops bot"), "O");
    assert.equal(monogram(""), "?");
    for (const p of [LEAD_AGENT, ...Object.values(SUB_AGENTS)]) {
      assert.ok(!("color" in p), "agents never get an identity color");
    }
  });

  it("oneLine keeps the first sentence on one line", () => {
    assert.equal(oneLine("Found 18 results and kept 12. Then more."), "Found 18 results and kept 12");
    assert.equal(oneLine("a\n b"), "a b");
    assert.ok(oneLine("x".repeat(200), 20).endsWith("…"));
  });
});

describe("deriveMission", () => {
  it("branches appear in delegation order with their latest state", () => {
    const m = deriveMission(
      mission({
        events: [
          route("planner", "Plan the work", 60),
          exec("planner", "Split the task into 5 steps.", 58),
          route("researcher", "Search the web", 57),
          exec("researcher", "Found 18 results and kept 12.", 50),
          route("researcher", "Read sources", 49),
          route("drafter", "Draft the brief", 10),
        ],
      }),
    )!;
    assert.deepEqual(m.branches.map((b) => b.key), ["planner", "researcher", "drafter"]);
    assert.deepEqual(m.branches.map((b) => b.status), ["done", "running", "running"]);
    assert.equal(m.branches[1]!.line, "Read sources");
    assert.equal(m.branches[2]!.name, "Writer");
    assert.equal(m.status, "running");
    assert.equal(m.line, "Writer: Draft the brief");
    assert.deepEqual(m.progress, { done: 2, total: 7 });
  });

  it("a pending approval makes the mission and its latest working sub-agent need you", () => {
    const m = deriveMission(
      mission({ pendingApprovals: 14, events: [route("researcher", "Read", 30), exec("researcher", "Read.", 20), route("drafter", "Draft renewal emails", 10)] }),
    )!;
    assert.equal(m.status, "needs");
    assert.equal(m.line, "14 approvals waiting on you");
    const writer = m.branches.find((b) => b.key === "drafter")!;
    assert.equal(writer.status, "needs");
    assert.equal(writer.line, "Waiting for your approval");
    assert.equal(m.branches.find((b) => b.key === "researcher")!.status, "done");
  });

  it("an executor error fails the branch; a failed latest run fails the mission", () => {
    const runs: AgentRunInput[] = [
      { id: "r1", kind: "mission", status: "failed", missionId: "m1", createdAt: t(9), endedAt: t(8) },
    ];
    const m = deriveMission(
      mission({ events: [route("actor", "Sync calendar", 10), execErr("actor", "Calendar access expired. Token revoked.", 9)] }),
      runs,
    )!;
    assert.equal(m.status, "failed");
    assert.equal(m.line, "Calendar access expired");
    assert.equal(m.branches[0]!.status, "failed");
    assert.equal(m.runId, "r1");
  });

  it("an escalation pauses for the human: needs you, or failed after repeated errors", () => {
    const esc = (code: string): MissionEventInput => ({
      ts: t(1),
      actor: "chief-strategy-agent",
      step: "escalate",
      observation: { terminationCode: code, detail: "No routing-table entry for task kind." },
    });
    assert.equal(deriveMission(mission({ status: "paused", events: [route("researcher", "x", 5), esc("unknown_task_kind")] }))!.status, "needs");
    assert.equal(deriveMission(mission({ status: "paused", events: [esc("consecutive_failures")] }))!.status, "failed");
  });

  it("a finished mission finishes its branches; paused pauses running ones", () => {
    const done = deriveMission(mission({ status: "complete", events: [route("researcher", "x", 5)] }))!;
    assert.equal(done.status, "done");
    assert.equal(done.branches[0]!.status, "done");
    assert.deepEqual(done.progress, { done: 7, total: 7 });
    const paused = deriveMission(mission({ status: "paused", events: [route("researcher", "x", 5)] }))!;
    assert.equal(paused.status, "paused");
    assert.equal(paused.branches[0]!.status, "paused");
  });

  it("archived missions are not shown", () => {
    assert.equal(deriveMission(mission({ status: "archived" })), null);
  });

  it("ignores unknown actors and malformed events", () => {
    const m = deriveMission(
      mission({ events: [{ ts: t(3), actor: "x", step: "route.1", args: { nextAgent: "hacker" } }, { ts: t(2), actor: "x", step: null, args: null }] }),
    )!;
    assert.deepEqual(m.branches, []);
  });
});

describe("deriveAgentTree", () => {
  it("returns null for an empty workspace", () => {
    assert.equal(deriveAgentTree({ missions: [], runs: [], now: NOW }), null);
  });

  it("one lead, sub-agents branch beneath it; the lead rolls up the most urgent state", () => {
    const tree = deriveAgentTree({
      now: NOW,
      missions: [
        mission({ id: "a", name: "Renewal emails", pendingApprovals: 3, events: [route("drafter", "Draft", 20)] }),
        mission({ id: "b", name: "Competitor brief", events: [route("planner", "Plan", 40), exec("planner", "Planned.", 39), route("researcher", "Read 12 sources", 30)] }),
      ],
      runs: [],
    })!;
    assert.equal(tree.lead.isLead, true);
    assert.equal(tree.lead.name, LEAD_AGENT.name);
    assert.equal(tree.lead.status, "needs");
    assert.equal(tree.lead.line, "3 approvals waiting on you");
    assert.equal(tree.missions[0]!.id, "a", "the mission that needs you comes first");
    assert.deepEqual(tree.branches.map((b) => b.key), ["drafter", "planner", "researcher"]);
    assert.ok(tree.branches.every((b) => !b.isLead));
    assert.deepEqual(tree.counts, { running: 1, needs: 1, done: 1, failed: 0 });
  });

  it("one node per sub-agent across missions, keeping the state that matters most", () => {
    const tree = deriveAgentTree({
      now: NOW,
      missions: [
        mission({ id: "a", events: [route("researcher", "Old", 50), exec("researcher", "Done.", 45)] }),
        mission({ id: "b", updatedAt: t(1), events: [route("researcher", "Reading", 2)] }),
      ],
      runs: [],
    })!;
    assert.equal(tree.branches.length, 1);
    assert.equal(tree.branches[0]!.status, "running");
    assert.equal(tree.branches[0]!.missionId, "b");
    assert.equal(tree.lead.line, "Working on 2 missions");
  });

  it("standalone runs hang off the lead; stale finished work drops out", () => {
    const runs: AgentRunInput[] = [
      { id: "r1", kind: "browser", status: "running", missionId: null, createdAt: t(3), endedAt: null },
      { id: "r2", kind: "follow_up", status: "failed", missionId: null, createdAt: t(60), endedAt: t(59) },
      { id: "r3", kind: "playbook", status: "succeeded", missionId: null, createdAt: t(4000), endedAt: t(3999) },
      { id: "r4", kind: "browser", status: "cancelled", missionId: null, createdAt: t(3), endedAt: t(2) },
    ];
    const tree = deriveAgentTree({ now: NOW, missions: [mission({ status: "complete", updatedAt: t(5000) })], runs })!;
    assert.equal(tree.missions.length, 0, "a mission finished days ago is not live work");
    assert.deepEqual(tree.branches.map((b) => b.key), ["run:r2", "run:r1"]);
    assert.equal(tree.branches[1]!.href, "/dashboard/runs/r1");
    assert.equal(tree.lead.status, "failed");
  });
});

describe("Overview banners", () => {
  it("approvals waiting → one yellow banner with Review all", () => {
    const [b] = deriveBanners({ approvals: { actionable: 3, sources: ["Mission", "Social post", "Mission"] }, failed: [] });
    assert.equal(b!.status, "needs");
    assert.equal(b!.title, "3 approvals are waiting on you");
    assert.match(b!.description, /^Mission and Social post paused/);
    assert.deepEqual(b!.action, { label: "Review all", href: "/dashboard/approvals" });
    assert.deepEqual(deriveBanners({ approvals: { actionable: 0, sources: [] }, failed: [] }), []);
  });

  it("failures → red banners; an expired connection offers Reconnect", () => {
    const out = deriveBanners({
      approvals: { actionable: 0, sources: [] },
      failed: [
        { key: "x", name: "Operator", detail: "Calendar access expired", href: "/dashboard/runs/x" },
        { key: "y", name: "Researcher", detail: "The page returned 500.", href: "/dashboard/runs/y" },
      ],
    });
    assert.equal(out.length, 2);
    assert.equal(out[0]!.title, "Operator stopped");
    assert.equal(out[0]!.description, "Calendar access expired. Reconnect to resume.");
    assert.equal(out[0]!.action!.label, "Reconnect");
    assert.deepEqual(out[1]!.action, { label: "Open", href: "/dashboard/runs/y" });
    assert.equal(out[1]!.description, "The page returned 500.");
  });

  it("many failures collapse into one banner", () => {
    const failed = ["a", "b", "c"].map((k) => ({ key: k, name: k.toUpperCase(), detail: "boom", href: "/" }));
    const out = deriveBanners({ approvals: { actionable: 1, sources: [] }, failed });
    assert.equal(out.length, 2);
    assert.equal(out[0]!.title, "1 approval is waiting on you");
    assert.equal(out[1]!.title, "3 runs stopped on errors");
  });

  it("collects failed missions and branches from the tree without duplicates", () => {
    const tree = deriveAgentTree({
      now: NOW,
      missions: [mission({ events: [route("actor", "Sync", 5), execErr("actor", "Token revoked", 4)] })],
      runs: [{ id: "r9", kind: "mission", status: "failed", missionId: "m1", createdAt: t(4), endedAt: t(3) }],
    });
    const failed = failedWorkFromTree(tree);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.name, "Operator on Weekly competitor brief");
    assert.equal(failed[0]!.href, "/dashboard/runs/r9");
    assert.ok(needsReconnect(failed[0]!.detail));
  });

  it("listJoin reads naturally", () => {
    assert.equal(listJoin(["A"]), "A");
    assert.equal(listJoin(["A", "B"]), "A and B");
    assert.equal(listJoin(["A", "B", "C"]), "A, B and C");
    assert.equal(listJoin(["A", "B", "C", "D", "E"]), "A, B, C and 2 more");
  });
});

describe("visibleBranches", () => {
  const node = (key: string, status: "done" | "running" | "needs" | "failed") =>
    ({ key, status }) as unknown as import("../agents").AgentNode;
  it("drops finished branches first and keeps delegation order", () => {
    const list = [node("a", "done"), node("b", "running"), node("c", "done"), node("d", "needs"), node("e", "failed")];
    const { shown, hidden } = visibleBranches(list, 3);
    assert.deepEqual(shown.map((b) => b.key), ["b", "d", "e"]);
    assert.equal(hidden, 2);
    assert.deepEqual(visibleBranches(list, 4).shown.map((b) => b.key), ["a", "b", "d", "e"]);
    assert.equal(visibleBranches(list, 9).hidden, 0);
    assert.deepEqual(visibleBranches(list, 0), { shown: [], hidden: 5 });
  });
});

describe("chat runs in the tree (Phase 5)", () => {
  it("names a standalone run by the agent that ran it, with its task", () => {
    const tree = deriveAgentTree({
      missions: [],
      runs: [
        { id: "r1", kind: "chat", status: "running", missionId: null, createdAt: NOW.toISOString(), endedAt: null, agentKey: "drafter", task: "Draft the renewal email for Acme. Then send." },
        { id: "r2", kind: "browser", status: "running", missionId: null, createdAt: NOW.toISOString(), endedAt: null },
      ],
      now: NOW,
    });
    const names = tree!.branches.map((b) => b.name);
    assert.ok(names.includes("Writer"), names.join(","));
    assert.ok(names.includes("Browser run"));
    const writer = tree!.branches.find((b) => b.name === "Writer")!;
    assert.equal(writer.line, "In progress · Draft the renewal email for Acme");
  });
});
