// ShapesOS — Phase 16: automatic parallel delegation, end to end against Postgres.
//
//   * children really run at the same time, within the per-run and
//     per-workspace caps (request timestamps from the fake model);
//   * the join resumes the parent EXACTLY ONCE — also after a worker
//     "restart" mid-fan-out, and with settles racing;
//   * siblings together can't exceed the parent's budget;
//   * dependsOn order is honoured and earlier deliverables are passed on;
//   * stopping one child interrupts only it; stopping the lead cancels all;
//   * two children's proposals are listed together, "yes" resumes the right
//     child (each as its own agent); a new message declines them;
//   * a Tier-3 proposal in a child still asks with auto rules present, and
//     per-agent rules apply per child agent;
//   * a child can't widen its grant; a sub-agent with the opt-in `delegate`
//     group delegates once more (depth 2), its sub-agents can't;
//   * the workspace's "Automatic delegation" switch decides whether the lead
//     is offered delegate_tasks (with guidance and the request's nudge).
//
// MOCK: the model is the scripted fake Responses API (./fake-responses.ts);
// the loop, gates, run service, queue and worker are the real ones.
// Run: DATABASE_URL=… npx tsx --test lib/chat/__tests__/delegation-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { computeGrant } from "@/lib/agents/grants";
import { getAgentRun, requestAgentRunCancel } from "@/lib/agents/runs/service";
import { AgentWorker } from "@/lib/agents/queue/worker";
import { prismaTranscriptStore } from "@/lib/agents/runs/transcript";
import { isLoopState } from "@/lib/agents/loop";
import { getDelegation, loadDelegationView, settleDelegation } from "@/lib/agents/delegation/store";
import { loadAgentActivity } from "@/lib/aos/activity.server";
import { runTrackedAgentTurn, stopThreadRuns, type ChatToolCall } from "../agent";
import { allText, deferred, offered, startFakeModel, toolOutputs, waitFor, type FakeModel, type ResponsesBody } from "./fake-responses";

const RUN = `p16d-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const USER = `${RUN}-user`;
let projectId = "";
let model: FakeModel;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

before(async () => {
  model = await startFakeModel({ agentWorker: "external" });
  await prisma.workspace.create({ data: { id: WS, name: `P16 ${WS}`, ownerUserId: USER } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `${RUN}.example` } })).id;
});

after(async () => {
  await model.close();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

// ── helpers ─────────────────────────────────────────────────────────────────

async function thread(agentKey = "lead", tools: string[] = []) {
  const grant = computeGrant({ agentKey: agentKey as "lead", requested: tools });
  return prisma.aiChatThread.create({
    data: { projectId, userId: USER, title: "New chat", agentKey, allowedTools: tools.length ? grant.groups : [] },
  });
}

function turn(threadId: string, userContent: string) {
  return runTrackedAgentTurn({ projectId, workspaceId: WS, userId: USER, role: "editor", threadId, userContent });
}

function newWorker(over: Partial<{ leaseMs: number; heartbeatMs: number; concurrency: number }> = {}) {
  return new AgentWorker({ log: quiet, leaseMs: 60_000, heartbeatMs: 10_000, concurrency: 8, ...over });
}

/** Tick until nothing is due and nothing runs (bounded). */
async function pump(worker: AgentWorker, rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const started = await worker.tick();
    if (worker.busy > 0) await worker.drain();
    if (started === 0 && worker.busy === 0) {
      const due = await withWorkspaceScope(WS, (tx) =>
        tx.agentJob.count({ where: { workspaceId: WS, status: "queued", runAfter: { lte: new Date() } } }),
      );
      if (due === 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** The delegated task a request belongs to ("Task <id> of the plan" opens every child brief). */
function childTask(b: ResponsesBody): string | null {
  return allText(b).match(/Task ([A-Za-z0-9_-]+) of the plan/)?.[1] ?? null;
}

function isLead(b: ResponsesBody): boolean {
  return /lead agent \(Strategist\)/.test(b.instructions ?? "");
}

function deliverable(summary: string, outputs: string, confidence = "high"): string {
  return `Done.\n\n\`\`\`deliverable\n${JSON.stringify({ summary, outputs, artifacts: [], openIssues: [], confidence })}\n\`\`\``;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function children(parentRunId: string) {
  return withWorkspaceScope(WS, (tx) =>
    tx.agentRun.findMany({ where: { workspaceId: WS, parentRunId }, orderBy: { createdAt: "asc" } }),
  );
}

async function lastAssistant(threadId: string) {
  return prisma.aiChatMessage.findFirst({ where: { threadId, role: "assistant" }, orderBy: { createdAt: "desc" } });
}

async function jobs(runId: string, kind: string) {
  return withWorkspaceScope(WS, (tx) => tx.agentJob.findMany({ where: { workspaceId: WS, runId, kind } }));
}

function maxOverlap(intervals: Array<[number, number]>): number {
  const pts = intervals.flatMap(([a, b]) => [[a, 1], [b, -1]] as Array<[number, number]>).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let best = 0;
  for (const [, d] of pts) {
    cur += d;
    best = Math.max(best, cur);
  }
  return best;
}

function delegateCall(goal: string, tasks: Array<Record<string, unknown>>, mergeInstructions = "Merge them into one answer.") {
  return { calls: [{ tool: "delegate_tasks", args: { goal, tasks, mergeInstructions } }] };
}

// ── the suite ───────────────────────────────────────────────────────────────

describe("Phase 16 automatic delegation (fake Responses API, real loop + queue + worker)", () => {
  it("children really run at the same time, within the per-run cap of 4 (the 5th waits for a slot)", async () => {
    const t = await thread();
    const ids = ["t1", "t2", "t3", "t4", "t5"];
    model.requests.length = 0;
    model.script = (b) => {
      const id = childTask(b);
      if (id) return { text: deliverable(`${id} done`, `${id} facts`), hold: sleep(400) };
      return toolOutputs(b).length
        ? { text: "Merged all five." }
        : delegateCall("Five lookups", ids.map((id) => ({ id, agent: "researcher", brief: `Look up ${id}`, deliverable: `${id} facts` })));
    };
    const out = await turn(t.id, "Look up these five things in parallel");
    assert.equal(out.queued, true);
    assert.equal(out.waiting, true, "the lead waits on its sub-agents");
    assert.equal((await getAgentRun(WS, out.runId))?.status, "running");
    const plan = (out.toolCalls.find((c) => c.tool === "delegate_tasks") as ChatToolCall | undefined)?.delegation;
    assert.equal(plan?.tasks, 5);

    // Only 4 may start at once.
    assert.equal((await children(out.runId)).length, 4, "the per-run cap holds the 5th back");
    await pump(newWorker());

    const childReqs = model.requests.filter((r) => childTask(r.body));
    const intervals = childReqs.map((r) => [r.startedAt, r.endedAt ?? r.startedAt] as [number, number]);
    const overlap = maxOverlap(intervals);
    assert.ok(overlap >= 2, `sub-agents overlapped in time (max ${overlap} at once)`);
    assert.ok(overlap <= 4, `never more than 4 at once (saw ${overlap})`);

    const kids = await children(out.runId);
    assert.equal(kids.length, 5);
    assert.ok(kids.every((k) => k.status === "succeeded" && k.kind === "chat" && k.threadId === t.id));
    const firstFourEnded = Math.min(...kids.slice(0, 4).map((k) => k.endedAt!.getTime()));
    assert.ok(kids[4]!.createdAt.getTime() >= firstFourEnded, "the 5th started only after a slot freed");
    assert.equal((await lastAssistant(t.id))?.content, "Merged all five.");
    assert.equal((await getAgentRun(WS, out.runId))?.status, "succeeded");

    // The UI's data, from these real rows: the plan view and the agent tree.
    const view = await loadDelegationView(WS, out.runId);
    assert.equal(view?.live, false);
    assert.equal(view?.plans[0]?.line, "5 of 5 sub-agents done");
    assert.ok(view?.plans[0]?.tasks.every((x) => x.aos === "done" && x.href && x.summary));
    const activity = await loadAgentActivity(WS);
    const node = activity.tree?.branches.find((b) => b.key === `run:${out.runId}`);
    assert.ok(node, "the lead's run is in the tree");
    assert.match(node!.line, /5 of 5 sub-agents done/);
    assert.equal(node!.children?.length, 5, "its sub-agents hang under it");
    assert.ok(node!.children!.every((c) => c.name === "Researcher" && c.status === "done"));

    // The subagent_spawn credit is metered once per child (idempotent per run).
    const spawns = await withWorkspaceScope(WS, (tx) =>
      tx.usageEvent.findMany({ where: { workspaceId: WS, action: "subagent_spawn", idempotencyKey: { in: kids.map((k) => `subagent-spawn:${k.id}`) } } }),
    );
    assert.equal(spawns.length, 5, "one spawn charge per sub-agent");
  });

  it("the workspace cap holds across runs (a workspace setting: 2 live sub-agents)", async () => {
    await withWorkspaceScope(WS, (tx) =>
      tx.agentDelegationSetting.create({ data: { workspaceId: WS, maxLivePerWorkspace: 2, updatedBy: USER } }),
    );
    try {
      const t = await thread();
      model.requests.length = 0;
      model.script = (b) => {
        const id = childTask(b);
        if (id) return { text: deliverable(`${id} ok`, id), hold: sleep(200) };
        return toolOutputs(b).length
          ? { text: "Three merged." }
          : delegateCall("Three lookups", ["a", "b", "c"].map((id) => ({ id, agent: "analyst", brief: `Check ${id}`, deliverable: id })));
      };
      const out = await turn(t.id, "Check three numbers");
      assert.equal((await children(out.runId)).length, 2, "only 2 may be live in the workspace");
      await pump(newWorker());
      const childReqs = model.requests.filter((r) => childTask(r.body));
      assert.ok(maxOverlap(childReqs.map((r) => [r.startedAt, r.endedAt ?? r.startedAt])) <= 2);
      assert.equal((await children(out.runId)).filter((k) => k.status === "succeeded").length, 3);
      assert.equal((await lastAssistant(t.id))?.content, "Three merged.");
    } finally {
      await withWorkspaceScope(WS, (tx) => tx.agentDelegationSetting.deleteMany({ where: { workspaceId: WS } }));
    }
  });

  it("the join resumes the lead EXACTLY ONCE — after a worker restart mid-fan-out, and with settles racing", async () => {
    const t = await thread();
    const gate = deferred();
    const firstCall = new Set<string>();
    model.requests.length = 0;
    model.script = (b) => {
      const id = childTask(b);
      if (id) {
        if (!firstCall.has(id)) {
          firstCall.add(id);
          return { text: "never delivered", hold: gate.promise };
        }
        return { text: deliverable(`${id} after restart`, `${id} result`) };
      }
      return toolOutputs(b).length
        ? { text: "Merged three after the restart." }
        : delegateCall("Three checks", ["x", "y", "z"].map((id) => ({ id, agent: "researcher", brief: `Check ${id}`, deliverable: id })));
    };
    const out = await turn(t.id, "Check x, y and z in parallel");
    const w1 = newWorker({ leaseMs: 5_000, heartbeatMs: 1_000 });
    await w1.tick();
    await waitFor(() => firstCall.size === 3, "all three sub-agents in flight");

    // The worker "dies": its leases go to nobody, so it stops its local work.
    await withWorkspaceScope(WS, (tx) =>
      tx.$executeRaw`UPDATE "agent_jobs" SET "locked_by" = 'gone' WHERE "workspace_id" = ${WS} AND "status" = 'running'`,
    );
    const lost = await w1.drain();
    assert.equal(lost.filter((o) => o.status === "lease_lost").length, 3, JSON.stringify(lost));
    for (const k of await children(out.runId)) assert.equal(k.status, "running", "a cut-off sub-agent stays resumable");

    // A new worker picks the orphans up when their leases pass.
    await withWorkspaceScope(WS, (tx) =>
      tx.$executeRaw`UPDATE "agent_jobs" SET "lease_until" = now() - interval '1 second' WHERE "workspace_id" = ${WS} AND "locked_by" = 'gone'`,
    );
    gate.resolve();
    await pump(newWorker());

    const kids = await children(out.runId);
    assert.ok(kids.every((k) => k.status === "succeeded"), kids.map((k) => k.status).join(","));
    // Settles racing after the fact change nothing.
    await Promise.all(Array.from({ length: 8 }, () => settleDelegation(WS, out.runId)));
    assert.equal((await jobs(out.runId, "delegation_join")).length, 1, "one join job, ever");
    const merges = model.requests.filter((r) => isLead(r.body) && toolOutputs(r.body).length > 0);
    assert.equal(merges.length, 1, "the lead merged once");
    assert.equal(await prisma.aiChatMessage.count({ where: { threadId: t.id, content: "Merged three after the restart." } }), 1);
    assert.ok(toolOutputs(merges[0]!.body).some((o) => /x result/.test(o) && /y result/.test(o) && /z result/.test(o)));
    assert.equal((await getAgentRun(WS, out.runId))?.status, "succeeded");
  });

  it("siblings together can't exceed the parent's budget (cost and model calls)", async () => {
    const saved = { cost: process.env.AGENT_MAX_RUN_COST_MICRO_USD, steps: process.env.AGENT_MAX_STEPS };
    // gpt-5.5 at $5 / $30 per M tokens: 1000 in + 100 out ≈ 8000 micro-USD per call.
    process.env.AGENT_MAX_RUN_COST_MICRO_USD = "60000";
    process.env.AGENT_MAX_STEPS = "12";
    try {
      const t = await thread();
      const usage = { input_tokens: 1000, output_tokens: 100 };
      model.script = (b) => {
        if (childTask(b)) return { calls: [{ tool: "get_keywords" }], usage }; // never stops on its own
        return toolOutputs(b).length
          ? { text: "Budget report merged.", usage }
          : { ...delegateCall("Two endless digs", ["p", "q"].map((id) => ({ id, agent: "researcher", brief: `Dig ${id}`, deliverable: id }))), usage };
      };
      const out = await turn(t.id, "Dig into both");
      const before = (await getDelegation(WS, out.runId))!.state!.plans[0]!;
      const leadState = await prismaTranscriptStore.load(WS, out.runId);
      assert.ok(isLoopState(leadState));
      const leadSpentBefore = leadState.costMicroUsd;
      const reserved = before.tasks.reduce((n, x) => n + x.budget.costMicroUsd, 0);
      assert.ok(reserved + before.reserve.costMicroUsd <= 60_000 - leadSpentBefore, "the shares fit in what was left");
      await pump(newWorker());

      const plan = (await getDelegation(WS, out.runId))!.state!.plans[0]!;
      let spent = 0;
      let steps = 0;
      for (const task of plan.tasks) {
        const s = await prismaTranscriptStore.load(WS, task.childRunId!);
        assert.ok(isLoopState(s));
        assert.ok(s.costMicroUsd <= task.budget.costMicroUsd, `${task.id}: ${s.costMicroUsd} ≤ its share ${task.budget.costMicroUsd}`);
        assert.ok(s.steps <= task.budget.steps, `${task.id}: ${s.steps} calls ≤ ${task.budget.steps}`);
        assert.equal(task.status, "failed");
        assert.match(task.error ?? "", /reached its share of the budget/);
        spent += s.costMicroUsd;
        steps += s.steps;
      }
      assert.ok(spent > 0 && steps >= 2, "the children did work");
      assert.ok(spent <= 60_000 - leadSpentBefore, `together ${spent} ≤ what the lead had left`);
      const leadAfter = await prismaTranscriptStore.load(WS, out.runId);
      assert.ok(isLoopState(leadAfter));
      assert.ok(leadAfter.costMicroUsd <= 60_000, `the whole run stayed inside its cap (${leadAfter.costMicroUsd})`);
      assert.equal(leadAfter.costMicroUsd >= leadSpentBefore + spent, true, "the children's real spend is on the lead at the join");
      assert.equal((await lastAssistant(t.id))?.content, "Budget report merged.");
    } finally {
      if (saved.cost === undefined) delete process.env.AGENT_MAX_RUN_COST_MICRO_USD;
      else process.env.AGENT_MAX_RUN_COST_MICRO_USD = saved.cost;
      if (saved.steps === undefined) delete process.env.AGENT_MAX_STEPS;
      else process.env.AGENT_MAX_STEPS = saved.steps;
    }
  });

  it("dependsOn: the dependent task starts after its prerequisite succeeded and gets its deliverable", async () => {
    const t = await thread();
    model.requests.length = 0;
    model.script = (b) => {
      const id = childTask(b);
      if (id === "research") return { text: deliverable("Audience found", "RESEARCH-FACT-42: small bakeries") };
      if (id === "draft") return { text: deliverable("Email drafted", "Hi bakers…") };
      return toolOutputs(b).length
        ? { text: "Research then draft, merged." }
        : delegateCall("Research then write", [
            { id: "research", agent: "researcher", brief: "Find the audience", deliverable: "audience" },
            { id: "draft", agent: "drafter", brief: "Write the email for that audience", deliverable: "email", dependsOn: ["research"] },
          ]);
    };
    const out = await turn(t.id, "Research the audience, then draft the email");
    assert.equal((await children(out.runId)).length, 1, "only the prerequisite starts");
    await pump(newWorker());
    const r = model.requests.filter((x) => childTask(x.body) === "research");
    const d = model.requests.filter((x) => childTask(x.body) === "draft");
    assert.ok(r.length && d.length);
    assert.ok(d[0]!.startedAt >= Math.max(...r.map((x) => x.endedAt ?? 0)), "the draft started after the research ended");
    assert.match(allText(d[0]!.body), /RESEARCH-FACT-42/, "the earlier deliverable was passed on");
    assert.match(d[0]!.body.instructions ?? "", /Writer sub-agent/);
    const kids = await children(out.runId);
    assert.equal(kids[0]!.agentKey, "researcher");
    assert.equal(kids[1]!.agentKey, "drafter");
    assert.ok(kids[1]!.createdAt >= kids[0]!.endedAt!);
    assert.equal((await lastAssistant(t.id))?.content, "Research then draft, merged.");
  });

  it("stopping one sub-agent interrupts only its in-flight call; its sibling finishes and the lead reports the stop", async () => {
    const t = await thread();
    const holdA = deferred();
    const holdB = deferred();
    model.requests.length = 0;
    model.script = (b) => {
      const id = childTask(b);
      if (id === "a") return { text: deliverable("a", "A-OUT"), hold: holdA.promise };
      if (id === "b") return { text: deliverable("b", "B-OUT"), hold: holdB.promise };
      return toolOutputs(b).length
        ? { text: "B finished; A was stopped." }
        : delegateCall("Two tasks", [
            { id: "a", agent: "researcher", brief: "Task A", deliverable: "A" },
            { id: "b", agent: "analyst", brief: "Task B", deliverable: "B" },
          ]);
    };
    const out = await turn(t.id, "Do A and B");
    const worker = newWorker({ leaseMs: 5_000, heartbeatMs: 1_000 });
    await worker.tick();
    await waitFor(() => model.requests.filter((r) => childTask(r.body)).length === 2, "both in flight");
    const kids = await children(out.runId);
    const a = kids.find((k) => k.agentKey === "researcher")!;
    const stoppedAt = Date.now();
    // Stop just A (as the Runs page's Stop does: POST /api/agent-runs/[id]/cancel).
    const stopped = await stopThreadRuns({ workspaceId: WS, threadId: t.id, userId: USER, runId: a.id });
    assert.deepEqual(stopped, [a.id]);
    await waitFor(() => model.requests.find((r) => childTask(r.body) === "a")?.aborted, "A's call aborted", 8_000);
    assert.ok(Date.now() - stoppedAt < 8_000, "A's in-flight call was interrupted, not waited out");
    assert.equal(model.requests.find((r) => childTask(r.body) === "b")!.aborted, false, "B's call is untouched");
    holdB.resolve();
    holdA.resolve();
    await worker.drain();
    await pump(worker);
    assert.equal((await getAgentRun(WS, a.id))?.status, "cancelled");
    assert.equal((await getAgentRun(WS, kids.find((k) => k.agentKey === "analyst")!.id))?.status, "succeeded");
    const merge = model.requests.filter((r) => isLead(r.body) && toolOutputs(r.body).length).at(-1)!;
    assert.ok(toolOutputs(merge.body).some((o) => /Task a — Researcher — STOPPED/.test(o) && /B-OUT/.test(o)), "the stop is reported, B's work merged");
    assert.equal((await lastAssistant(t.id))?.content, "B finished; A was stopped.");
    assert.equal((await getAgentRun(WS, out.runId))?.status, "succeeded");
  });

  it("stopping the lead cancels every sub-agent, the tasks not started yet, and the join", async () => {
    const t = await thread();
    const hold = deferred();
    model.requests.length = 0;
    model.script = (b) => {
      if (childTask(b)) return { text: deliverable("x", "x"), hold: hold.promise };
      return toolOutputs(b).length
        ? { text: "should never merge" }
        : delegateCall("Three, one dependent", [
            { id: "one", agent: "researcher", brief: "One", deliverable: "1" },
            { id: "two", agent: "analyst", brief: "Two", deliverable: "2" },
            { id: "three", agent: "drafter", brief: "Three", deliverable: "3", dependsOn: ["one"] },
          ]);
    };
    const out = await turn(t.id, "Three things");
    const worker = newWorker({ leaseMs: 5_000, heartbeatMs: 1_000 });
    await worker.tick();
    await waitFor(() => model.requests.filter((r) => childTask(r.body)).length === 2, "two in flight");
    const stopped = await stopThreadRuns({ workspaceId: WS, threadId: t.id, userId: USER });
    assert.ok(stopped.includes(out.runId));
    await waitFor(() => model.requests.filter((r) => childTask(r.body) && r.aborted).length === 2, "both calls aborted", 8_000);
    hold.resolve();
    await worker.drain();
    await pump(worker);
    for (const k of await children(out.runId)) assert.equal(k.status, "cancelled");
    assert.equal((await children(out.runId)).length, 2, "the dependent task never started");
    const plan = (await getDelegation(WS, out.runId))!.state!.plans[0]!;
    assert.deepEqual(plan.tasks.map((x) => x.status), ["cancelled", "cancelled", "cancelled"]);
    assert.equal((await jobs(out.runId, "delegation_join")).length, 0, "no join after a stop");
    assert.equal((await getAgentRun(WS, out.runId))?.status, "cancelled");
    assert.ok(!model.requests.some((r) => isLead(r.body) && toolOutputs(r.body).length > 0), "the lead never merged");
  });

  it("two sub-agents' proposals are listed together; \"yes\" runs each as its own agent and resumes the RIGHT child", async () => {
    const t = await thread();
    model.requests.length = 0;
    model.script = (b) => {
      const id = childTask(b);
      if (id === "op") {
        return toolOutputs(b).length ? { text: deliverable("Operator ran wf-A", `OP saw: ${toolOutputs(b).join(" | ")}`) } : { calls: [{ tool: "run_workflow", args: { workflowId: "wf-A" } }] };
      }
      if (id === "sched") {
        return toolOutputs(b).length
          ? { text: deliverable("Scheduler ran wf-B", `SCHED saw: ${toolOutputs(b).join(" | ")}`) }
          : { calls: [{ tool: "run_workflow", args: { workflowId: "wf-B" } }] };
      }
      return toolOutputs(b).length
        ? { text: "Both workflows handled." }
        : delegateCall("Two workflows", [
            { id: "op", agent: "actor", brief: "Start workflow A", deliverable: "status of A" },
            { id: "sched", agent: "scheduler", brief: "Start workflow B", deliverable: "status of B" },
          ]);
    };
    const out = await turn(t.id, "Start both workflows");
    const worker = newWorker();
    await pump(worker);

    const msg = await lastAssistant(t.id);
    const pending = ((msg?.toolCalls ?? []) as unknown as ChatToolCall[]).filter((c) => c.status === "pending_confirmation");
    assert.equal(pending.length, 2, `both proposals listed: ${msg?.content}`);
    assert.ok(!((msg?.toolCalls ?? []) as unknown as ChatToolCall[]).some((c) => c.status === "error"), "none turned into an error");
    assert.match(msg?.content ?? "", /2 sub-agents need your OK/);
    const kids = await children(out.runId);
    const op = kids.find((k) => k.agentKey === "actor")!;
    const sched = kids.find((k) => k.agentKey === "scheduler")!;
    assert.deepEqual(new Set(pending.map((c) => c.runId)), new Set([op.id, sched.id]));
    assert.equal((await getAgentRun(WS, op.id))?.status, "awaiting_confirmation");
    assert.equal((await getAgentRun(WS, sched.id))?.status, "awaiting_confirmation");
    assert.equal((await getAgentRun(WS, out.runId))?.status, "awaiting_confirmation", "the lead waits on the user too");

    const before = model.requests.length;
    const yes = await turn(t.id, "yes");
    assert.match(yes.assistantText, /2 sub-agents carry on/);
    await pump(worker);
    const after = model.requests.slice(before);
    const opNext = after.find((r) => childTask(r.body) === "op")!;
    const schedNext = after.find((r) => childTask(r.body) === "sched")!;
    assert.match(opNext.body.instructions ?? "", /Operator sub-agent/);
    assert.match(schedNext.body.instructions ?? "", /Scheduler sub-agent/);
    assert.ok(!offered(schedNext.body).includes("ops_mark_invoice_paid"), "the Scheduler kept its own tools");
    assert.ok(toolOutputs(opNext.body).some((o) => /wf-A/.test(o)) && !toolOutputs(opNext.body).some((o) => /wf-B/.test(o)), "the Operator got ITS result");
    assert.ok(toolOutputs(schedNext.body).some((o) => /wf-B/.test(o)) && !toolOutputs(schedNext.body).some((o) => /wf-A/.test(o)), "the Scheduler got ITS result");
    assert.equal((await getAgentRun(WS, op.id))?.status, "succeeded");
    assert.equal((await getAgentRun(WS, sched.id))?.status, "succeeded");
    assert.equal((await lastAssistant(t.id))?.content, "Both workflows handled.");
  });

  it("a new message instead of \"yes\" declines the sub-agent's proposal; it carries on knowing it was not run", async () => {
    const t = await thread();
    model.requests.length = 0;
    model.script = (b) => {
      const id = childTask(b);
      if (id === "w") {
        return toolOutputs(b).length
          ? { text: deliverable("Skipped the workflow", `W saw: ${toolOutputs(b).join(" | ")}`) }
          : { calls: [{ tool: "run_workflow", args: { workflowId: "wf-decline" } }] };
      }
      if (isLead(b) && toolOutputs(b).some((o) => /delegation plan result/.test(o))) return { text: "Merged after the decline." };
      return /What else/.test(allText(b)) ? { text: "Something else answered." } : delegateCall("One workflow", [{ id: "w", agent: "actor", brief: "Start the workflow", deliverable: "status" }]);
    };
    const out = await turn(t.id, "Start the workflow via a sub-agent");
    const worker = newWorker();
    await pump(worker);
    const [child] = await children(out.runId);
    assert.equal((await getAgentRun(WS, child!.id))?.status, "awaiting_confirmation");
    const proposalMsg = await lastAssistant(t.id);

    await turn(t.id, "What else is on my plate?");
    const declined = await prisma.aiChatMessage.findUnique({ where: { id: proposalMsg!.id } });
    assert.equal(((declined!.toolCalls as unknown as ChatToolCall[])[0]!).status, "cancelled", "marked declined on the message");
    await pump(worker);
    const resumed = model.requests.filter((r) => childTask(r.body) === "w").at(-1)!;
    assert.ok(toolOutputs(resumed.body).some((o) => /Not run: .*declined/.test(o)), "the sub-agent was told it was not run");
    assert.equal((await getAgentRun(WS, child!.id))?.status, "succeeded");
    assert.ok(!(await withWorkspaceScope(WS, (tx) => tx.agentRunEvent.findMany({ where: { workspaceId: WS, runId: child!.id } }))).some(
      (e) => (e.payload as { tool?: unknown; status?: unknown } | null)?.tool === "run_workflow" && (e.payload as { status?: unknown }).status === "executed",
    ), "the workflow never ran");
    assert.ok(await prisma.aiChatMessage.findFirst({ where: { threadId: t.id, content: "Merged after the decline." } }));
  });

  it("Tier 3 in a sub-agent still asks with auto rules present; per-agent rules apply to the child's own agent", async () => {
    await withWorkspaceScope(WS, async (tx) => {
      // The Operator may run workflows on its own (Tier 2) …
      await tx.automationSetting.create({ data: { workspaceId: WS, agentKey: "actor", action: "run_workflow", behavior: "auto", updatedBy: USER } });
      // … forced "auto" rows on a Tier-3 money kind (the PUT guard refuses these; the evaluator must still ask).
      await tx.automationSetting.create({ data: { workspaceId: WS, agentKey: "actor", action: "mark_invoice_paid", behavior: "auto", updatedBy: USER } });
      await tx.automationSetting.create({ data: { workspaceId: WS, agentKey: "*", action: "mark_invoice_paid", behavior: "auto", updatedBy: USER } });
      // A rule for the LEAD only must not cover the Operator.
      await tx.automationSetting.create({ data: { workspaceId: WS, agentKey: "lead", action: "audit_site", behavior: "auto", updatedBy: USER } });
    });
    try {
      const t = await thread();
      model.script = (b) => {
        if (childTask(b) === "money") {
          return toolOutputs(b).length
            ? { text: deliverable("done", "done") }
            : {
                calls: [
                  { tool: "run_workflow", args: { workflowId: "wf-auto" } },
                  { tool: "ops_mark_invoice_paid", args: { invoiceId: "inv-1" } },
                  { tool: "run_seo_audit", args: {} },
                ],
              };
        }
        return toolOutputs(b).length ? { text: "unused" } : delegateCall("Ops chores", [{ id: "money", agent: "actor", brief: "Do the chores", deliverable: "status" }]);
      };
      const out = await turn(t.id, "Handle the chores");
      await pump(newWorker());
      const [child] = await children(out.runId);
      const saved = await prismaTranscriptStore.load(WS, child!.id);
      assert.ok(isLoopState(saved));
      const byTool = (n: string) => saved.calls.find((c) => c.tool === n)!;
      assert.notEqual(byTool("run_workflow").status, "pending_confirmation", "Tier 2 under the Operator's own rule ran without asking");
      assert.match(byTool("run_workflow").autoApproved ?? "", /run_workflow rule for agent actor/);
      assert.equal(byTool("ops_mark_invoice_paid").status, "pending_confirmation", "Tier 3 always asks, whatever the rules say");
      assert.equal(byTool("ops_mark_invoice_paid").autoAction, undefined, "never offered auto");
      assert.equal(byTool("run_seo_audit").status, "pending_confirmation", "the lead's rule doesn't cover the Operator");
      assert.equal((await getAgentRun(WS, child!.id))?.status, "awaiting_confirmation");
      const msg = await lastAssistant(t.id);
      const listed = ((msg?.toolCalls ?? []) as unknown as ChatToolCall[]).map((c) => c.tool).sort();
      assert.deepEqual(listed, ["ops_mark_invoice_paid", "run_seo_audit"]);
      await stopThreadRuns({ workspaceId: WS, threadId: t.id, userId: USER });
      assert.equal((await getAgentRun(WS, child!.id))?.status, "cancelled", "Stop ends a waiting sub-agent");
      assert.equal((await getAgentRun(WS, out.runId))?.status, "cancelled");
    } finally {
      await withWorkspaceScope(WS, (tx) => tx.automationSetting.deleteMany({ where: { workspaceId: WS } }));
    }
  });

  it("a child can't widen its grant; with the opt-in `delegate` group it delegates once more (depth 2) and no further", async () => {
    const t = await thread("lead", ["email", "files"]); // lead grant: workspace, email, files, delegate
    model.requests.length = 0;
    model.script = (b) => {
      const id = childTask(b);
      if (id === "grand") return { text: deliverable("grandchild done", "GRAND-OUT") };
      if (id === "mid") {
        if (toolOutputs(b).some((o) => /delegation plan result/.test(o))) return { text: deliverable("mid merged", "MID-OUT") };
        if (toolOutputs(b).some((o) => /Refused/.test(o))) {
          return delegateCall("One level down", [{ id: "grand", agent: "drafter", brief: "Draft it", deliverable: "draft", tools: ["email", "delegate"] }]);
        }
        return { calls: [{ tool: "ops_mark_invoice_paid", args: { invoiceId: "x" } }, { tool: "research_question", args: { question: "q" } }] };
      }
      return toolOutputs(b).length ? { text: "Two levels merged." } : delegateCall("Nested", [{ id: "mid", agent: "actor", brief: "Coordinate", deliverable: "result", tools: ["web", "ops", "email", "files", "delegate"] }]);
    };
    const out = await turn(t.id, "Coordinate it with sub-agents");
    await pump(newWorker());

    const [mid] = await children(out.runId);
    assert.deepEqual(mid!.allowedTools, ["workspace", "email", "files", "delegate"], "web and ops were asked for but the parent never had them");
    const plan = (await getDelegation(WS, out.runId))!.state!.plans[0]!;
    assert.deepEqual(plan.tasks[0]!.dropped.sort(), ["ops", "web"]);
    const midFirst = model.requests.find((r) => childTask(r.body) === "mid")!;
    assert.ok(!offered(midFirst.body).includes("ops_mark_invoice_paid") && !offered(midFirst.body).includes("research_question"));
    assert.ok(offered(midFirst.body).includes("delegate_tasks"), "the opted-in sub-agent may delegate");
    const midState = await prismaTranscriptStore.load(WS, mid!.id);
    assert.ok(isLoopState(midState));
    assert.equal(midState.calls.find((c) => c.tool === "ops_mark_invoice_paid")?.status, "denied", "named anyway: refused");

    const [grand] = await children(mid!.id);
    assert.ok(grand, "depth 2 ran");
    assert.equal(grand!.agentKey, "drafter");
    assert.deepEqual(grand!.allowedTools, ["workspace", "email", "delegate"].filter((g) => mid!.allowedTools.includes(g)));
    const grandReq = model.requests.find((r) => childTask(r.body) === "grand")!;
    assert.ok(!offered(grandReq.body).includes("delegate_tasks") && !offered(grandReq.body).includes("delegate_to_subagent"), "depth 2 can't delegate further");
    assert.equal(grand!.status, "succeeded");
    assert.equal((await getAgentRun(WS, mid!.id))?.status, "succeeded");
    const leadMerge = model.requests.filter((r) => isLead(r.body) && toolOutputs(r.body).length).at(-1)!;
    assert.ok(toolOutputs(leadMerge.body).some((o) => /MID-OUT/.test(o)));
    assert.equal((await lastAssistant(t.id))?.content, "Two levels merged.");
  });

  it("\"Automatic delegation\": on (default) offers delegate_tasks with guidance and the request's nudge; off hides it", async () => {
    const t = await thread();
    model.requests.length = 0;
    model.script = () => ({ text: "Answered inline." });
    await turn(t.id, "Research our three competitors in parallel and compare them");
    const on = model.requests.at(-1)!.body;
    assert.ok(offered(on).includes("delegate_tasks"));
    assert.match(on.instructions ?? "", /Working with sub-agents/);
    assert.match(on.instructions ?? "", /Never delegate a single tool call/);
    // Phase 17 (A1): the per-request nudge rides in the user turn's
    // <workspace-context> block, never in the cached system prefix.
    assert.doesNotMatch(on.instructions ?? "", /Note on this request/, "the nudge is per request: not in the static prefix");
    assert.match(allText(on), /asked for the work to be split or run in parallel/);

    await turn(t.id, "What are my keywords?");
    assert.doesNotMatch(allText(model.requests.at(-1)!.body), /Note on this request/, "no nudge on a small request");

    await withWorkspaceScope(WS, (tx) => tx.agentDelegationSetting.create({ data: { workspaceId: WS, autoDelegation: false, updatedBy: USER } }));
    try {
      await turn(t.id, "Research our three competitors in parallel");
      const off = model.requests.at(-1)!.body;
      assert.ok(!offered(off).includes("delegate_tasks"), "not offered when off");
      assert.ok(offered(off).includes("delegate_to_subagent"), "the explicit one-task hand-off stays");
      assert.doesNotMatch(off.instructions ?? "", /Working with sub-agents/);
    } finally {
      await withWorkspaceScope(WS, (tx) => tx.agentDelegationSetting.deleteMany({ where: { workspaceId: WS } }));
    }
  });

  it("verify and fix: a failed task is reported, retried at most once, and the merge uses the retry", async () => {
    const t = await thread();
    model.requests.length = 0;
    let leadStep = 0;
    model.script = (b) => {
      const id = childTask(b);
      if (id === "good") return { text: deliverable("good ok", "GOOD-OUT") };
      if (id === "flaky") throw new Error("the flaky sub-agent's provider is down (fake 500)");
      if (id === "flaky2") return { text: deliverable("retry ok", "RETRY-OUT") };
      const outs = toolOutputs(b);
      if (outs.length === 0) {
        return delegateCall("Two parts", [
          { id: "good", agent: "researcher", brief: "Good part", deliverable: "good" },
          { id: "flaky", agent: "analyst", brief: "Flaky part", deliverable: "numbers" },
        ]);
      }
      leadStep++;
      if (leadStep === 1) {
        assert.ok(outs.some((o) => /Task flaky — Analyst — FAILED/.test(o)), "the failure is reported, not dropped");
        return delegateCall("Retry the flaky part", [{ id: "flaky2", agent: "analyst", brief: "Flaky part, again", deliverable: "numbers", fixes: "flaky" }]);
      }
      if (leadStep === 2) {
        // A second retry of the same task is refused.
        return delegateCall("Retry again", [{ id: "flaky3", agent: "analyst", brief: "Again", deliverable: "numbers", fixes: "flaky" }]);
      }
      return { text: `Merged: ${outs.some((o) => /RETRY-OUT/.test(o)) ? "with the retry" : "without"}.` };
    };
    const out = await turn(t.id, "Do both parts");
    await pump(newWorker());
    const plans = (await getDelegation(WS, out.runId))!.state!.plans;
    assert.equal(plans.length, 2, "the first plan and ONE fix round");
    assert.deepEqual(plans[0]!.tasks.map((x) => x.status), ["succeeded", "failed"]);
    assert.equal(plans[1]!.round, 1);
    assert.equal(plans[1]!.tasks[0]!.fixes, "flaky");
    assert.equal(plans[1]!.tasks[0]!.status, "succeeded");
    const refused = model.requests.filter((r) => isLead(r.body)).at(-1)!;
    assert.ok(toolOutputs(refused.body).some((o) => /already retried once/.test(o)), "a second retry was refused with the reason");
    assert.equal((await lastAssistant(t.id))?.content, "Merged: with the retry.");
    assert.equal((await getAgentRun(WS, out.runId))?.status, "succeeded");
  });

  it("the lead's own action proposed alongside a plan still waits for (and gets) the user's OK after the merge", async () => {
    const t = await thread();
    model.script = (b) => {
      if (childTask(b)) return { text: deliverable("checked", "CHECK-OUT") };
      const outs = toolOutputs(b);
      if (outs.length === 0) {
        return {
          calls: [
            { tool: "delegate_tasks", args: { goal: "Check first", tasks: [{ id: "chk", agent: "researcher", brief: "Check", deliverable: "check" }], mergeInstructions: "Say what was checked." } },
            { tool: "run_workflow", args: { workflowId: "wf-lead" } },
          ],
        };
      }
      return { text: "Checked; the workflow waits for you." };
    };
    const out = await turn(t.id, "Check it and start the workflow");
    assert.match(out.assistantText, /Meanwhile/, "the waiting message lists the lead's own proposal");
    await pump(newWorker());
    const last = await lastAssistant(t.id);
    const pending = ((last?.toolCalls ?? []) as unknown as ChatToolCall[]).filter((c) => c.status === "pending_confirmation");
    assert.deepEqual(pending.map((c) => c.tool), ["run_workflow"], "carried into the merged answer");
    assert.match(last!.content, /Checked; the workflow waits for you\.[\s\S]*Still waiting for your OK/);
    const yes = await turn(t.id, "yes");
    const ran = yes.toolCalls.find((c) => c.tool === "run_workflow");
    assert.ok(ran && ran.confirmed && ran.status !== "pending_confirmation", "\"yes\" ran it");
  });

  it("a plan the rules refuse starts nothing and tells the model why", async () => {
    const t = await thread();
    model.script = (b) =>
      toolOutputs(b).length
        ? { text: "I'll do it myself." }
        : delegateCall("Cyclic", [
            { id: "a", agent: "researcher", brief: "A", deliverable: "a", dependsOn: ["b"] },
            { id: "b", agent: "wizard", brief: "B", deliverable: "b", dependsOn: ["a"] },
          ]);
    const out = await turn(t.id, "Do the cyclic thing");
    const call = out.toolCalls.find((c) => c.tool === "delegate_tasks")!;
    assert.equal(call.status, "error");
    assert.match(call.resultSummary ?? "", /unknown agent "wizard"/);
    assert.match(call.resultSummary ?? "", /cycle/);
    assert.equal((await children(out.runId)).length, 0);
    assert.equal(out.assistantText, "I'll do it myself.");
    assert.equal((await getAgentRun(WS, out.runId))?.status, "succeeded");
  });
});
