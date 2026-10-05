// ShapesOS — Phase 16: automatic delegation, the pure rules (no database).
// Plan validation (cycles, unknown agents, width / depth caps, the fix
// round), the budget split and its return, dependency scheduling, the
// deliverable contract, the merge report and the automatic-trigger nudge.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DELEGATION_LIMITS,
  MERGE_RESERVE_SHARE,
  MIN_CHILD_BUDGET,
  childBriefMessage,
  delegationNudge,
  delegationProgress,
  dependencyOrder,
  doomedTasks,
  effectiveDelegationLimits,
  findCycle,
  joinAccounting,
  joinReport,
  parseDeliverable,
  progressLine,
  readyTasks,
  splitBudget,
  tasksToStart,
  validateDelegationPlan,
  waitingPlaceholder,
  isWaitingPlaceholder,
  type DelegationPlanState,
  type DelegationTaskState,
  type DelegationTaskStatus,
} from "../plan";
import { applyJoinToState, hasUnappliedJoin, patchDecidedProposals, placeholderSaved } from "../join";
import { initialLoopState, type LoopState } from "@/lib/agents/loop";
import { DELEGATION_GUIDANCE } from "@/lib/agents/roles";

const limits = DEFAULT_DELEGATION_LIMITS;

function plan(tasks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { goal: "Compare three competitors", mergeInstructions: "One table, then a recommendation.", tasks, ...extra };
}

function task(id: string, agent = "researcher", more: Record<string, unknown> = {}) {
  return { id, agent, brief: `Do ${id}`, deliverable: `${id} findings`, ...more };
}

function state(id: string, status: DelegationTaskStatus, more: Partial<DelegationTaskState> = {}): DelegationTaskState {
  return {
    id,
    agent: "researcher",
    brief: `Do ${id}`,
    deliverableSpec: `${id} findings`,
    dependsOn: [],
    requestedTools: null,
    grant: ["workspace", "web"],
    dropped: [],
    budgetShare: 0.5,
    budget: { costMicroUsd: 1_000_000, steps: 8, ms: 600_000 },
    status,
    ...more,
  };
}

describe("plan validation", () => {
  it("accepts a well-formed plan and fills defaults", () => {
    const v = validateDelegationPlan(plan([task("a"), task("b", "analyst", { dependsOn: ["a"] })]), { limits, depth: 0 });
    assert.ok(v.ok, JSON.stringify(v));
    if (v.ok) {
      assert.deepEqual(v.plan.tasks[0]!.dependsOn, []);
      assert.deepEqual(v.plan.tasks[1]!.dependsOn, ["a"]);
    }
  });

  it("refuses dependency cycles and names the cycle", () => {
    const v = validateDelegationPlan(
      plan([task("a", "researcher", { dependsOn: ["c"] }), task("b", "researcher", { dependsOn: ["a"] }), task("c", "analyst", { dependsOn: ["b"] })]),
      { limits, depth: 0 },
    );
    assert.equal(v.ok, false);
    if (!v.ok) assert.ok(v.errors.some((e) => /cycle: (a → c → b → a|a → b → c → a|.*→.*→.*→)/.test(e)), v.errors.join(" | "));
    assert.deepEqual(findCycle([{ id: "x", dependsOn: ["y"] }, { id: "y", dependsOn: ["x"] }]), ["x", "y", "x"]);
    assert.equal(findCycle([{ id: "x" }, { id: "y", dependsOn: ["x"] }]), null);
  });

  it("refuses self-dependencies, dangling edges and duplicate ids", () => {
    const self = validateDelegationPlan(plan([task("a", "researcher", { dependsOn: ["a"] })]), { limits, depth: 0 });
    assert.ok(!self.ok && self.errors.some((e) => /depends on itself/.test(e)));
    const dangling = validateDelegationPlan(plan([task("a", "researcher", { dependsOn: ["zzz"] })]), { limits, depth: 0 });
    assert.ok(!dangling.ok && dangling.errors.some((e) => /unknown task "zzz"/.test(e)));
    const dup = validateDelegationPlan(plan([task("a"), task("a")]), { limits, depth: 0 });
    assert.ok(!dup.ok && dup.errors.some((e) => /used twice/.test(e)));
  });

  it("refuses unknown agents and the lead itself", () => {
    const unknown = validateDelegationPlan(plan([task("a", "hacker")]), { limits, depth: 0 });
    assert.ok(!unknown.ok && unknown.errors.some((e) => /unknown agent "hacker"/.test(e)));
    const lead = validateDelegationPlan(plan([task("a", "lead")]), { limits, depth: 0 });
    assert.ok(!lead.ok && lead.errors.some((e) => /lead can't be delegated to/.test(e)));
  });

  it("enforces the width cap", () => {
    const nine = Array.from({ length: 9 }, (_, i) => task(`t${i}`));
    const v = validateDelegationPlan(plan(nine), { limits, depth: 0 });
    assert.ok(!v.ok && v.errors.some((e) => /at most 8 sub-agents/.test(e)));
    const ok = validateDelegationPlan(plan(nine), { limits: { ...limits, maxWidth: 9 }, depth: 0 });
    assert.ok(ok.ok);
  });

  it("enforces the depth cap: the lead (0) and its sub-agents (1) may delegate, their sub-agents (2) may not", () => {
    assert.ok(validateDelegationPlan(plan([task("a")]), { limits, depth: 0 }).ok);
    assert.ok(validateDelegationPlan(plan([task("a")]), { limits, depth: 1 }).ok);
    const deep = validateDelegationPlan(plan([task("a")]), { limits, depth: 2 });
    assert.ok(!deep.ok && deep.errors.some((e) => /depth limit is 2/.test(e)));
    const shallow = validateDelegationPlan(plan([task("a")]), { limits: { ...limits, maxDepth: 1 }, depth: 1 });
    assert.ok(!shallow.ok);
  });

  it("refuses budget shares that add up to more than everything", () => {
    const v = validateDelegationPlan(plan([task("a", "researcher", { budgetShare: 0.7 }), task("b", "researcher", { budgetShare: 0.4 })]), { limits, depth: 0 });
    assert.ok(!v.ok && v.errors.some((e) => /must not exceed 1/.test(e)));
  });

  it("after a plan, only a fix round: one retry per failed task, nothing else", () => {
    const previous: Array<Pick<DelegationPlanState, "planId" | "tasks">> = [
      { planId: "p1", tasks: [state("a", "succeeded"), state("b", "failed"), state("c", "cancelled")] },
    ];
    assert.ok(validateDelegationPlan(plan([task("b2", "researcher", { fixes: "b" }), task("c2", "analyst", { fixes: "c" })]), { limits, depth: 0, previous }).ok);
    const fresh = validateDelegationPlan(plan([task("d")]), { limits, depth: 0, previous });
    assert.ok(!fresh.ok && fresh.errors.some((e) => /may only retry failed tasks/.test(e)));
    const notFailed = validateDelegationPlan(plan([task("a2", "researcher", { fixes: "a" })]), { limits, depth: 0, previous });
    assert.ok(!notFailed.ok && notFailed.errors.some((e) => /not a failed or stopped task/.test(e)));
    const twice = validateDelegationPlan(plan([task("b2", "researcher", { fixes: "b" }), task("b3", "researcher", { fixes: "b" })]), { limits, depth: 0, previous });
    assert.ok(!twice.ok && twice.errors.some((e) => /already retried once/.test(e)));
    const already = [...previous, { planId: "p2", tasks: [state("b2", "failed", { fixes: "b" })] }];
    const again = validateDelegationPlan(plan([task("b3", "researcher", { fixes: "b" })]), { limits, depth: 0, previous: already });
    assert.ok(!again.ok && again.errors.some((e) => /already retried once/.test(e)));
    const retryOfRetry = validateDelegationPlan(plan([task("b4", "researcher", { fixes: "b2" })]), { limits, depth: 0, previous: already });
    assert.ok(!retryOfRetry.ok, "a failed retry is not retried again");
    const first = validateDelegationPlan(plan([task("x", "researcher", { fixes: "y" })]), { limits, depth: 0 });
    assert.ok(!first.ok && first.errors.some((e) => /only for retrying/.test(e)));
  });

  it("bounds the workspace's stored limits", () => {
    assert.deepEqual(effectiveDelegationLimits(null), DEFAULT_DELEGATION_LIMITS);
    assert.deepEqual(effectiveDelegationLimits({ maxParallelPerRun: 99, maxLivePerWorkspace: 0, maxWidth: null, maxDepth: 5 }), {
      maxParallelPerRun: 8,
      maxLivePerWorkspace: 1,
      maxWidth: 8,
      maxDepth: 2,
    });
  });
});

describe("budget split and return", () => {
  const left = { costMicroUsd: 1_000_000, steps: 30, ms: 600_000 };

  it("reserves the merge's share and splits the rest evenly by default", () => {
    const r = splitBudget(left, [{ id: "a" }, { id: "b" }, { id: "c" }]);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.split.reserve.costMicroUsd, Math.ceil(left.costMicroUsd * MERGE_RESERVE_SHARE));
    assert.equal(r.split.reserve.steps, 6);
    for (const id of ["a", "b", "c"]) assert.equal(r.split.perTask[id]!.steps, 8);
    assert.equal(r.split.perTask.a!.costMicroUsd, 266_666);
  });

  it("siblings together never exceed what was left (any shares, any amounts)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(rnd() * 8);
      const l = { costMicroUsd: Math.floor(rnd() * 50_000_000) + 50_000, steps: 10 + Math.floor(rnd() * 200), ms: 120_000 + Math.floor(rnd() * 3_600_000) };
      const tasks = Array.from({ length: n }, (_, k) => (rnd() < 0.4 ? { id: `t${k}`, budgetShare: Math.max(0.01, rnd() / n) } : { id: `t${k}` }));
      const r = splitBudget(l, tasks);
      if (!r.ok) continue;
      const sum = (f: (b: { costMicroUsd: number; steps: number; ms: number }) => number) => Object.values(r.split.perTask).reduce((a, b) => a + f(b), 0);
      assert.ok(sum((b) => b.costMicroUsd) + r.split.reserve.costMicroUsd <= l.costMicroUsd, "cost");
      assert.ok(sum((b) => b.steps) + r.split.reserve.steps <= l.steps, "steps");
      assert.ok(sum((b) => b.ms) + r.split.reserve.ms <= l.ms, "time");
    }
  });

  it("honours explicit shares; unshared tasks split what's left; an unclaimed rest stays with the parent", () => {
    const r = splitBudget(left, [{ id: "big", budgetShare: 0.5 }, { id: "x" }, { id: "y" }]);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.split.shares.big, 0.5);
    assert.equal(r.split.shares.x, 0.25);
    const half = splitBudget(left, [{ id: "only", budgetShare: 0.5 }]);
    assert.ok(half.ok && half.split.perTask.only!.steps === 12, "half the pool; the other half returns");
  });

  it("refuses a split that leaves a child too little to work", () => {
    const r = splitBudget({ costMicroUsd: 1_000_000, steps: 5, ms: 600_000 }, [{ id: "a" }, { id: "b" }, { id: "c" }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Not enough budget left to split 3 ways/);
    assert.ok(MIN_CHILD_BUDGET.steps >= 2);
  });

  it("unused budget returns at the join", () => {
    const a = joinAccounting([
      { budget: { costMicroUsd: 500, steps: 8, ms: 1000 }, costMicroUsd: 200, steps: 3, activeMs: 400 },
      { budget: { costMicroUsd: 500, steps: 8, ms: 1000 }, costMicroUsd: 500, steps: 8, activeMs: 1000 },
      { budget: { costMicroUsd: 500, steps: 8, ms: 1000 } },
    ]);
    assert.deepEqual(a.reserved, { costMicroUsd: 1500, steps: 24, ms: 3000 });
    assert.deepEqual(a.used, { costMicroUsd: 700, steps: 11, ms: 1400 });
    assert.deepEqual(a.returned, { costMicroUsd: 800, steps: 13, ms: 1600 });
  });
});

describe("dependency scheduling", () => {
  it("starts only tasks whose prerequisites all succeeded, in plan order", () => {
    const tasks = [state("a", "succeeded"), state("b", "running"), state("c", "pending", { dependsOn: ["a"] }), state("d", "pending", { dependsOn: ["a", "b"] }), state("e", "pending")];
    assert.deepEqual(readyTasks(tasks).map((t) => t.id), ["c", "e"]);
  });

  it("skips tasks whose prerequisite failed, was stopped or skipped", () => {
    const tasks = [state("a", "failed"), state("b", "pending", { dependsOn: ["a"] }), state("c", "cancelled"), state("d", "pending", { dependsOn: ["c"] }), state("e", "pending")];
    assert.deepEqual(doomedTasks(tasks).map((d) => [d.task.id, d.because]), [["b", "a"], ["d", "c"]]);
  });

  it("starts no more than the per-run and per-workspace caps allow", () => {
    const tasks = Array.from({ length: 8 }, (_, i) => state(`t${i}`, "pending"));
    assert.equal(tasksToStart(tasks, { liveForRun: 0, liveForWorkspace: 0, limits }).length, 4);
    assert.equal(tasksToStart(tasks, { liveForRun: 3, liveForWorkspace: 3, limits }).length, 1);
    assert.equal(tasksToStart(tasks, { liveForRun: 0, liveForWorkspace: 5, limits }).length, 1);
    assert.equal(tasksToStart(tasks, { liveForRun: 0, liveForWorkspace: 6, limits }).length, 0);
  });

  it("a simulated run never starts a task before what it depends on succeeded", () => {
    const tasks = [
      state("research", "pending"),
      state("numbers", "pending"),
      state("draft", "pending", { dependsOn: ["research", "numbers"] }),
      state("review", "pending", { dependsOn: ["draft"] }),
      state("side", "pending"),
    ];
    const started: string[] = [];
    for (let wave = 0; wave < 10; wave++) {
      const go = tasksToStart(tasks, { liveForRun: 0, liveForWorkspace: 0, limits: { ...limits, maxParallelPerRun: 2 } });
      if (go.length === 0) break;
      for (const t of go) {
        for (const d of t.dependsOn) assert.equal(tasks.find((x) => x.id === d)!.status, "succeeded", `${t.id} before ${d}`);
        started.push(t.id);
        t.status = "succeeded";
      }
    }
    // Two at a time, plan order on ties: draft is ready (and first in plan order) once both inputs succeeded.
    assert.deepEqual(started, ["research", "numbers", "draft", "side", "review"]);
    assert.deepEqual(dependencyOrder(tasks), ["research", "numbers", "draft", "review", "side"]);
  });

  it("counts progress for the tree (\"3 of 5 sub-agents done\")", () => {
    const p = delegationProgress([state("a", "succeeded"), state("b", "failed"), state("c", "skipped"), state("d", "running"), state("e", "awaiting_confirmation")]);
    assert.deepEqual(p, { total: 5, done: 3, succeeded: 1, failed: 2, running: 1, needs: 1, pending: 0 });
    assert.equal(progressLine(p), "3 of 5 sub-agents done");
  });
});

describe("deliverables and the merge", () => {
  it("reads the structured deliverable block", () => {
    const d = parseDeliverable(
      'Here is what I found.\n\n```deliverable\n{"summary":"Acme is cheapest","outputs":"Acme $10, Beta $12","artifacts":["doc-1"],"openIssues":["no data for Gamma"],"confidence":"high"}\n```',
    );
    assert.deepEqual(d, { summary: "Acme is cheapest", outputs: "Acme $10, Beta $12", artifacts: ["doc-1"], openIssues: ["no data for Gamma"], confidence: "high" });
    const num = parseDeliverable('```json\n{"summary":"s","outputs":{"a":1},"confidence":0.5}\n```');
    assert.equal(num.confidence, "medium");
    assert.match(num.outputs, /"a": 1/);
  });

  it("falls back to the text itself, with unknown confidence", () => {
    const d = parseDeliverable("Plain report.\n\nSecond paragraph.");
    assert.equal(d.summary, "Plain report.");
    assert.match(d.outputs, /Second paragraph/);
    assert.equal(d.confidence, "unknown");
    assert.equal(parseDeliverable("```deliverable\nnot json\n```").confidence, "unknown");
  });

  it("a dependent task's brief carries its prerequisites' results, truncated", () => {
    const msg = childBriefMessage({
      goal: "Launch plan",
      task: { id: "draft", brief: "Write the launch email", deliverableSpec: "the email", dependsOn: ["research"], budget: { costMicroUsd: 2_000_000, steps: 6, ms: 300_000 } },
      prerequisites: [{ id: "research", agent: "researcher", deliverable: { summary: "Audience is SMBs", outputs: "x".repeat(5_000), artifacts: [], openIssues: [], confidence: "high" } }],
    });
    assert.match(msg, /Write the launch email/);
    assert.match(msg, /Hand back: the email/);
    assert.match(msg, /### research \(Researcher\)/);
    assert.match(msg, /Summary: Audience is SMBs/);
    assert.match(msg, /truncated 3500 characters/);
  });

  it("the merge report contains EVERY task's deliverable, failed and stopped ones reported honestly", () => {
    const tasks = [
      state("a", "succeeded", { deliverable: { summary: "A summary", outputs: "A outputs 111", artifacts: ["file-a"], openIssues: ["a issue"], confidence: "high" }, costMicroUsd: 300_000, steps: 3 }),
      state("b", "succeeded", { agent: "analyst", deliverable: { summary: "B summary", outputs: "B outputs 222", artifacts: [], openIssues: [], confidence: "low" }, costMicroUsd: 100_000, steps: 2 }),
      state("c", "failed", { error: "It reached its share of the budget (cost) before finishing.", deliverable: { summary: "partial C", outputs: "C partial 333", artifacts: [], openIssues: [], confidence: "unknown" } }),
      state("d", "cancelled", { error: "Stopped before it finished." }),
      state("e", "skipped", { error: 'Not started: it needed "c", which did not succeed.', dependsOn: ["c"] }),
    ];
    const report = joinReport({ planId: "plan_x", goal: "Compare", mergeInstructions: "One table please.", tasks, round: 0 });
    for (const needle of ["A outputs 111", "B outputs 222", "C partial 333", "file-a", "a issue", "confidence high", "confidence low"]) {
      assert.ok(report.includes(needle), needle);
    }
    assert.match(report, /Task c — Researcher — FAILED/);
    assert.match(report, /Task d — Researcher — STOPPED/);
    assert.match(report, /Task e — Researcher — SKIPPED/);
    assert.match(report, /2 of 5 tasks succeeded, 3 did not/);
    assert.match(report, /One table please\./);
    assert.match(report, /retry each failed or stopped task at most once/);
    assert.match(report, /never drop them silently/);
    const fixRound = joinReport({ planId: "plan_y", goal: "Compare", mergeInstructions: "m", tasks, round: 1 });
    assert.match(fixRound, /No more delegation for this plan/);
  });

  it("the placeholder is recognisable (the join replaces it)", () => {
    const p = waitingPlaceholder("plan_1", 3);
    assert.ok(isWaitingPlaceholder(p, "plan_1"));
    assert.ok(!isWaitingPlaceholder(p, "plan_2"));
  });
});

describe("the automatic trigger (a cheap nudge; the model decides)", () => {
  it("nudges on an explicit ask, a list of separate items, or a long multi-part request", () => {
    assert.match(delegationNudge("Research these three competitors in parallel") ?? "", /split or run in parallel/);
    assert.match(delegationNudge("Please:\n- audit the site\n- draft a post\n- check rankings") ?? "", /3 separate items/);
    const long = `${"We need a full launch plan for the spring collection and then the email copy and also the ad budget plus a review of last year. ".repeat(6)}`;
    assert.match(delegationNudge(long) ?? "", /multi-part/);
  });

  it("the lead's guidance says when to split and when not (lib/agents/roles.ts)", () => {
    assert.match(DELEGATION_GUIDANCE, /independent parts/);
    assert.match(DELEGATION_GUIDANCE, /different tools/);
    assert.match(DELEGATION_GUIDANCE, /a third of this run's budget/);
    assert.match(DELEGATION_GUIDANCE, /Keep small tasks inline/);
    assert.match(DELEGATION_GUIDANCE, /Never delegate a single tool call/);
    assert.match(DELEGATION_GUIDANCE, /money and irreversible actions always ask/);
  });

  it("stays quiet on small requests", () => {
    assert.equal(delegationNudge("What are my top keywords?"), null);
    assert.equal(delegationNudge(""), null);
  });
});

describe("transcript patches (join, decisions)", () => {
  function waitingState(planId: string, toolUseId: string): LoopState {
    const s = initialLoopState({ system: "sys", messages: [{ role: "user", content: "go" }], workload: "lead", now: 1_000 });
    s.messages.push({ role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "delegate_tasks", input: {} }] });
    s.messages.push({ role: "user", content: [{ type: "tool_result", toolUseId, content: waitingPlaceholder(planId, 2) }] });
    s.toolResults[toolUseId] = { type: "tool_result", toolUseId, content: waitingPlaceholder(planId, 2) };
    s.calls.push({ tool: "delegate_tasks", args: {}, status: "executed", toolUseId, resultSummary: "Working with 2 sub-agents" });
    s.costMicroUsd = 1_000;
    return s;
  }
  const joined = (planId: string, toolUseId: string): DelegationPlanState => ({
    planId,
    toolUseId,
    goal: "g",
    mergeInstructions: "m",
    depth: 1,
    round: 0,
    createdAt: new Date(0).toISOString(),
    armed: true,
    reserve: { costMicroUsd: 10, steps: 2, ms: 60_000 },
    joinedAt: new Date(5_000).toISOString(),
    tasks: [
      state("a", "succeeded", { deliverable: { summary: "s", outputs: "A-OUT", artifacts: [], openIssues: [], confidence: "high" }, costMicroUsd: 400 }),
      state("b", "failed", { error: "boom", costMicroUsd: 250 }),
    ],
  });

  it("the join replaces the placeholder with the report and adds the children's spend — once", () => {
    const s = waitingState("plan_j", "tu_1");
    assert.ok(placeholderSaved(s, { planId: "plan_j", toolUseId: "tu_1" }));
    const plans = [joined("plan_j", "tu_1")];
    assert.ok(hasUnappliedJoin(s, plans));
    assert.deepEqual(applyJoinToState(s, plans, { now: 10_000, maxMs: 1_000_000 }), ["plan_j"]);
    const last = s.messages.at(-1)!;
    const block = (last.content as Array<{ type: string; content?: unknown }>)[0]!;
    assert.match(String(block.content), /A-OUT/);
    assert.match(String(block.content), /FAILED/);
    assert.equal(s.costMicroUsd, 1_650);
    assert.match(s.calls[0]!.resultSummary ?? "", /2 of 2 sub-agents done — 1 succeeded, 1 did not/);
    assert.deepEqual(applyJoinToState(s, plans, { now: 10_000, maxMs: 1_000_000 }), [], "never twice");
    assert.equal(s.costMicroUsd, 1_650);
    assert.ok(!hasUnappliedJoin(s, plans));
  });

  it("the merge keeps its reserved time even when the children took long", () => {
    const s = waitingState("plan_t", "tu_2");
    s.startedAt = 0;
    applyJoinToState(s, [joined("plan_t", "tu_2")], { now: 2_000_000, maxMs: 1_000_000 });
    assert.equal(2_000_000 - s.startedAt, 1_000_000 - 60_000);
  });

  it("a decision patches the proposal's result, clears the outcome and doesn't count the wait", () => {
    const s = initialLoopState({ system: "sys", messages: [{ role: "user", content: "go" }], workload: "subagent", now: 0 });
    s.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "tu_p", name: "run_workflow", input: {} }] });
    s.messages.push({ role: "user", content: [{ type: "tool_result", toolUseId: "tu_p", content: "Not run: waiting" }] });
    const pending = { tool: "run_workflow", args: {}, status: "pending_confirmation" as const, toolUseId: "tu_p", runId: "child-1" };
    s.calls.push(pending);
    s.outcome = { status: "awaiting_confirmation", finalText: "ok?", proposal: pending };
    s.pausedAt = 5_000;
    const next = patchDecidedProposals(
      s,
      [{ call: pending, exec: { tool: "run_workflow", args: {}, status: "executed", confirmed: true, resultSummary: "Started" }, result: { type: "tool_result", toolUseId: "tu_p", content: "Started" } }],
      65_000,
    );
    assert.ok(next);
    assert.equal(next!.outcome, undefined);
    assert.equal(next!.startedAt, 60_000, "the minute it waited for the person is not counted");
    assert.equal(next!.calls[0]!.status, "executed");
    assert.equal(((next!.messages.at(-1)!.content as Array<{ content: unknown }>)[0]!).content, "Started");
    assert.equal(s.outcome?.status, "awaiting_confirmation", "the input is not mutated");
    assert.equal(patchDecidedProposals(s, [{ call: { ...pending, toolUseId: "nope" }, exec: pending, result: { type: "tool_result", toolUseId: "nope", content: "x" } }], 1), null);
  });
});
