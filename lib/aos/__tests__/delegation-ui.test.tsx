// ShapesOS — Phase 16: the delegation UI renders from seeded data (no DB,
// no browser): the plan view-model, the agent tree nesting a lead's
// sub-agents with "N of M sub-agents done", and static renders of the plan
// table, the chat card list and the tree (status shapes are agent states).
// Run: npx tsx --test lib/aos/__tests__/delegation-ui.test.tsx

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDelegationView, formatBudget, taskAosStatus, viewProgress } from "../delegation";
import { deriveAgentTree, type AgentRunInput } from "../agents";
import { DelegationPlan } from "@/components/aos/DelegationPlan";
import { AgentTree } from "@/components/aos/AgentTree";
import type { DelegationState } from "@/lib/agents/delegation/store";
import type { DelegationTaskState, DelegationTaskStatus } from "@/lib/agents/delegation/plan";

const NOW = new Date("2026-10-05T12:00:00Z");

function task(id: string, agent: DelegationTaskState["agent"], status: DelegationTaskStatus, more: Partial<DelegationTaskState> = {}): DelegationTaskState {
  return {
    id,
    agent,
    brief: `Brief ${id}`,
    deliverableSpec: `${id} output`,
    dependsOn: [],
    requestedTools: null,
    grant: ["workspace"],
    dropped: [],
    budgetShare: 0.25,
    budget: { costMicroUsd: 400_000, steps: 6, ms: 300_000 },
    status,
    ...more,
  };
}

const STATE: DelegationState = {
  v: 1,
  continuation: { kind: "chat_turn", payload: { projectId: "p", workspaceId: "w", userId: "u", role: "editor", threadId: "t", userContent: "", agentKey: "lead", grant: [], mode: "default" } },
  plans: [
    {
      planId: "plan_1",
      toolUseId: "tu",
      goal: "Compare three rivals",
      mergeInstructions: "One table",
      depth: 1,
      round: 0,
      createdAt: NOW.toISOString(),
      armed: true,
      reserve: { costMicroUsd: 200_000, steps: 3, ms: 120_000 },
      tasks: [
        task("t1", "researcher", "succeeded", { childRunId: "run-c1", deliverable: { summary: "Acme is cheapest", outputs: "…", artifacts: [], openIssues: ["no Q3 data"], confidence: "high" }, costMicroUsd: 120_000, steps: 3 }),
        task("t2", "analyst", "running", { childRunId: "run-c2" }),
        task("t3", "actor", "awaiting_confirmation", { childRunId: "run-c3" }),
        task("t4", "drafter", "pending", { dependsOn: ["t1", "t2"] }),
        task("t5", "scheduler", "cancelled", { childRunId: "run-c5", error: "Stopped before it finished." }),
      ],
    },
  ],
};

describe("the plan view-model", () => {
  it("maps every task state to its agent-state shape (stopped stays neutral)", () => {
    assert.equal(taskAosStatus("running"), "running");
    assert.equal(taskAosStatus("awaiting_confirmation"), "needs");
    assert.equal(taskAosStatus("succeeded"), "done");
    assert.equal(taskAosStatus("failed"), "failed");
    assert.equal(taskAosStatus("skipped"), "failed");
    assert.equal(taskAosStatus("pending"), "queued");
    assert.equal(taskAosStatus("cancelled"), null);
  });

  it("builds the view: agents, links, budgets, deliverables, progress", () => {
    const v = buildDelegationView("run-lead", "running", STATE);
    assert.equal(v.live, true);
    const p = v.plans[0]!;
    assert.equal(p.line, "2 of 5 sub-agents done");
    assert.deepEqual(p.tasks.map((t) => t.agentName), ["Researcher", "Analyst", "Operator", "Writer", "Scheduler"]);
    assert.equal(p.tasks[0]!.href, "/dashboard/runs/run-c1");
    assert.equal(p.tasks[3]!.href, null, "not started: no run yet");
    assert.deepEqual(p.tasks[0]!.used, { costMicroUsd: 120_000, steps: 3 });
    assert.equal(p.tasks[0]!.summary, "Acme is cheapest");
    assert.equal(formatBudget(p.tasks[0]!.budget), "6 calls · ≈$0.40 · 5 min");
    assert.deepEqual(viewProgress(v), { total: 5, done: 2, succeeded: 1, failed: 1, running: 1, needs: 1, pending: 1 });
    assert.equal(buildDelegationView("x", "succeeded", STATE).live, false);
  });
});

describe("the agent tree nests chat delegation", () => {
  const runs: AgentRunInput[] = [
    { id: "run-lead", kind: "chat", status: "running", missionId: null, createdAt: "2026-10-05T11:50:00Z", endedAt: null, agentKey: "lead", task: "Compare rivals", parentRunId: null, delegation: { done: 2, total: 5 } },
    { id: "run-c1", kind: "chat", status: "succeeded", missionId: null, createdAt: "2026-10-05T11:51:00Z", endedAt: "2026-10-05T11:55:00Z", agentKey: "researcher", task: "Brief t1", parentRunId: "run-lead" },
    { id: "run-c2", kind: "chat", status: "running", missionId: null, createdAt: "2026-10-05T11:51:01Z", endedAt: null, agentKey: "analyst", task: "Brief t2", parentRunId: "run-lead" },
    { id: "run-c3", kind: "chat", status: "awaiting_confirmation", missionId: null, createdAt: "2026-10-05T11:51:02Z", endedAt: null, agentKey: "actor", task: "Brief t3", parentRunId: "run-lead" },
  ];

  it("hangs the sub-agents under the lead's run, in hand-out order, with progress", () => {
    const tree = deriveAgentTree({ missions: [], runs, now: NOW })!;
    assert.equal(tree.branches.length, 1, "only the lead's run is a top-level branch");
    const lead = tree.branches[0]!;
    assert.match(lead.line, /2 of 5 sub-agents done/);
    assert.deepEqual(lead.progress, { done: 2, total: 5 });
    assert.deepEqual(lead.children?.map((c) => [c.name, c.status]), [
      ["Researcher", "done"],
      ["Analyst", "running"],
      ["Operator", "needs"],
    ]);
    assert.match(lead.children![2]!.line, /Waiting for your OK/);
    assert.equal(tree.counts.needs, 1);
    assert.equal(tree.counts.running, 2);
    assert.equal(tree.lead.status, "needs", "what needs the human rolls up first");
  });

  it("a sub-agent whose parent isn't listed still shows (top level)", () => {
    const tree = deriveAgentTree({ missions: [], runs: runs.slice(1), now: NOW })!;
    assert.equal(tree.branches.length, 3);
  });

  it("renders: the tree with nested sub-agent rows and their state shapes", () => {
    const tree = deriveAgentTree({ missions: [], runs, now: NOW })!;
    for (const tone of ["paper", "night"] as const) {
      const html = renderToStaticMarkup(<AgentTree lead={tree.lead} branches={tree.branches} tone={tone} />);
      assert.match(html, /aria-label="Sub-agents"/);
      assert.match(html, /2 of 5 sub-agents done/);
      for (const name of ["Researcher", "Analyst", "Operator"]) assert.ok(html.includes(name), `${tone}: ${name}`);
      assert.match(html, /aria-label="Needs you"/, "the waiting sub-agent carries its shape + word");
      assert.match(html, /href="\/dashboard\/runs\/run-c2"/);
    }
  });
});

describe("the plan renders (run page table, chat card list)", () => {
  const plan = buildDelegationView("run-lead", "running", STATE).plans[0]!;

  it("table: every task, its state, dependencies, budget and result", () => {
    const html = renderToStaticMarkup(<DelegationPlan plan={plan} />);
    for (const id of ["t1", "t2", "t3", "t4", "t5"]) assert.ok(html.includes(`>${id}<`), id);
    assert.match(html, /Acme is cheapest/);
    assert.match(html, /Confidence: high/);
    assert.match(html, /Open: no Q3 data/);
    assert.match(html, /t1, t2/, "what t4 waits on");
    assert.match(html, /6 calls · ≈\$0\.40 · 5 min/);
    assert.match(html, /used 3 calls · ≈\$0\.12/);
    assert.match(html, />Stopped</, "a stopped task is a neutral chip");
    assert.match(html, /Needs you/);
    assert.equal((html.match(/<svg/g) ?? []).length, 4, "a shape for every task but the stopped one");
  });

  it("list (the chat card): one row per sub-agent with a link to its run", () => {
    const html = renderToStaticMarkup(<DelegationPlan plan={plan} variant="list" />);
    assert.match(html, /aria-label="Sub-agents: 2 of 5 sub-agents done"/);
    assert.equal((html.match(/<li/g) ?? []).length, 5);
    assert.match(html, /Waiting for your OK in the chat/);
    assert.match(html, /After t1, t2/);
    assert.equal((html.match(/>Open</g) ?? []).length, 4);
  });
});
