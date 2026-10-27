// Marketr — Phase 9 M2: orchestrator + executors + ask + Prisma approval store tests.
// Run: npx tsx --test lib/orchestrator/__tests__/orchestrator.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runMission,
  planToTasks,
  ROUTING_TABLE,
  MAX_ROUTING_HOPS,
  type MissionTask,
  type OrchestratorDeps,
  type RunMissionResult,
} from "../orchestrator";
import type { MissionEventInput } from "../audit";
import { KillSwitchError } from "../executors/_guard";
import { assertToolAllowed } from "../executors/_guard";
import { runResearcher, RESEARCHER_TOOLS } from "../executors/researcher";
import { runPlanner, PLANNER_TOOLS, MissionPlanSchema, assertNoExecutionMarkers } from "../executors/planner";
import { runDrafter, DRAFTER_TOOLS } from "../executors/drafter";
import { runAnalyst, ANALYST_TOOLS } from "../executors/analyst";
import { runScheduler, SCHEDULER_TOOLS } from "../executors/scheduler";
import { answerAsk } from "../ask";
import { createMemoryMissionApprovalStore, ApprovalError } from "../../authority/executor";
import { createPrismaMissionApprovalStore, type ApprovalTx, type ApprovalRow } from "../../authority/mission-approvals-db";

const WS = "ws_m2_test";
const MISSION = "mission_m2_test";

function task(kind: string, label = kind): MissionTask {
  return { kind, label, workspaceId: WS, missionId: MISSION };
}

/** Collecting event log double. */
function eventLog() {
  const events: MissionEventInput[] = [];
  return {
    events,
    append: async (input: MissionEventInput) => {
      events.push(input);
      return { id: `ev_${events.length}` };
    },
  };
}

function baseDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  const log = eventLog();
  return {
    appendEvent: log.append,
    isWorkspaceFrozen: async () => false,
    isMissionPaused: async () => false,
    pauseMission: async () => {},
    clock: () => Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Routing state
// ---------------------------------------------------------------------------

describe("orchestrator routing state", () => {
  it("records { nextAgent, routingReason } on every delegation", async () => {
    const log = eventLog();
    const seen: Array<{ executor: string; kind: string }> = [];
    const deps = baseDeps({
      appendEvent: log.append,
      dispatch: async (executor, t) => {
        seen.push({ executor, kind: t.kind });
        return { summary: "ok", costCents: 5 };
      },
    });
    const res: RunMissionResult = await runMission({
      missionId: MISSION,
      workspaceId: WS,
      initialTasks: [task("research", "q1"), task("analyze", "q2"), task("schedule", "q3")],
      deps,
    });
    assert.equal(res.status, "complete");
    const routes = log.events.filter((e) => String(e.step).startsWith("route."));
    assert.equal(routes.length, 3, "one routing event per delegation");
    for (const r of routes) {
      const args = r.args as Record<string, unknown>;
      assert.ok(typeof args.nextAgent === "string" && args.nextAgent.length > 0, "nextAgent recorded");
      assert.ok(typeof args.routingReason === "string" && args.routingReason.length > 0, "routingReason recorded");
    }
    // Routing table honored: research -> researcher, etc.
    assert.deepEqual(seen.map((s) => s.executor), ["researcher", "analyst", "scheduler"]);
  });

  it("routes known kinds via the table, never 'collaborate when useful'", () => {
    assert.equal(ROUTING_TABLE["research"], "researcher");
    assert.equal(ROUTING_TABLE["plan"], "planner");
    assert.equal(ROUTING_TABLE["draft"], "drafter");
    assert.equal(ROUTING_TABLE["analyze"], "analyst");
    assert.equal(ROUTING_TABLE["schedule"], "scheduler");
  });

  it("novel task kinds escalate (pause + escalation event), never guess", async () => {
    const log = eventLog();
    let paused = 0;
    const deps = baseDeps({
      appendEvent: log.append,
      pauseMission: async () => { paused += 1; },
      dispatch: async () => ({ summary: "ok", costCents: 1 }),
    });
    const res = await runMission({
      missionId: MISSION,
      workspaceId: WS,
      initialTasks: [task("teleport", "do the impossible")],
      deps,
    });
    assert.equal(res.status, "escalated");
    assert.equal(res.reason, "unknown_task_kind");
    assert.equal(paused, 1);
    const esc = log.events.find((e) => e.step === "escalate");
    assert.ok(esc, "escalation event appended for the human");
    assert.equal((esc!.observation as Record<string, unknown>).terminationCode, "unknown_task_kind");
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe("circuit breaker", () => {
  it("trips at the hop cap, pauses the mission, appends an escalation event", async () => {
    const log = eventLog();
    let paused = 0;
    const deps = baseDeps({
      appendEvent: log.append,
      pauseMission: async () => { paused += 1; },
      // Every dispatch fans out another task — a runaway without the breaker.
      dispatch: async (_e, t) => ({
        summary: "ok",
        costCents: 1,
        followUps: [{ ...t, label: `${t.label}+` }],
      }),
    });
    const res = await runMission({
      missionId: MISSION,
      workspaceId: WS,
      initialTasks: [task("research", "loop")],
      maxRoutingHops: 5,
      deps,
    });
    assert.equal(res.status, "escalated");
    assert.equal(res.reason, "circuit_breaker");
    assert.ok(res.hops <= 5, `hops capped at 5, got ${res.hops}`);
    assert.equal(paused, 1, "mission paused on trip");
    const esc = log.events.find((e) => e.step === "escalate");
    assert.ok(esc, "escalation event appended");
    assert.equal((esc!.observation as Record<string, unknown>).terminationCode, "circuit_breaker");
  });

  it("default hop cap is ~20", () => {
    assert.ok(MAX_ROUTING_HOPS >= 15 && MAX_ROUTING_HOPS <= 25);
  });
});

// ---------------------------------------------------------------------------
// Deterministic termination — every condition fires in code, each hop.
// ---------------------------------------------------------------------------

describe("deterministic termination", () => {
  it("max_steps: stops after the step cap", async () => {
    let dispatched = 0;
    const deps = baseDeps({
      dispatch: async () => {
        dispatched += 1;
        return { summary: "ok", costCents: 1, followUps: [task("research", `more-${dispatched}`)] };
      },
    });
    const res = await runMission({
      missionId: MISSION, workspaceId: WS,
      initialTasks: [task("research", "start")],
      maxSteps: 3,
      maxRoutingHops: 100,
      deps,
    });
    assert.equal(res.reason, "max_steps");
    assert.equal(res.status, "terminated");
    assert.equal(dispatched, 3);
  });

  it("timeout: stops when the deadline passes", async () => {
    let t = 0;
    const deps = baseDeps({
      clock: () => (t += 1000),
      dispatch: async () => ({ summary: "ok", costCents: 1, followUps: [task("research", "x")] }),
    });
    const res = await runMission({
      missionId: MISSION, workspaceId: WS,
      initialTasks: [task("research", "start")],
      timeoutMs: 2500,
      maxRoutingHops: 100,
      deps,
    });
    assert.equal(res.reason, "timeout");
    assert.equal(res.status, "terminated");
  });

  it("cost_budget: stops when per-mission spend hits the budget", async () => {
    const deps = baseDeps({
      dispatch: async () => ({ summary: "ok", costCents: 6000, followUps: [task("research", "x")] }),
    });
    const res = await runMission({
      missionId: MISSION, workspaceId: WS,
      initialTasks: [task("research", "a"), task("research", "b"), task("research", "c")],
      costBudgetCents: 10_000,
      maxRoutingHops: 100,
      deps,
    });
    assert.equal(res.reason, "cost_budget");
    assert.equal(res.status, "terminated");
    assert.ok(res.costCents >= 10_000);
  });

  it("loop_detected: same nextAgent+reason 3x in a row terminates", async () => {
    const log = eventLog();
    const deps = baseDeps({
      appendEvent: log.append,
      dispatch: async () => ({ summary: "ok", costCents: 1 }),
      routeNovelTask: async () => ({ nextAgent: "researcher", routingReason: "novel: keep digging" }),
    });
    const res = await runMission({
      missionId: MISSION, workspaceId: WS,
      // Same task re-queued: the novel router keeps deciding identically.
      initialTasks: [task("mystery", "dig"), task("mystery", "dig"), task("mystery", "dig"), task("mystery", "dig")],
      deps,
    });
    assert.equal(res.reason, "loop_detected");
    assert.equal(res.status, "terminated");
    const term = log.events.find((e) => e.step === "terminate");
    assert.ok(term, "termination event appended");
    assert.equal((term!.observation as Record<string, unknown>).terminationCode, "loop_detected");
  });

  it("consecutive_failures: pauses + escalates after N failures in a row", async () => {
    const log = eventLog();
    let paused = 0;
    let dispatched = 0;
    const deps = baseDeps({
      appendEvent: log.append,
      pauseMission: async () => { paused += 1; },
      dispatch: async () => {
        dispatched += 1;
        throw new Error(`boom ${dispatched}`);
      },
    });
    const res = await runMission({
      missionId: MISSION, workspaceId: WS,
      initialTasks: [task("research", "a"), task("research", "b"), task("research", "c"), task("research", "d")],
      maxConsecutiveFailures: 3,
      deps,
    });
    assert.equal(res.reason, "consecutive_failures");
    assert.equal(res.status, "escalated");
    assert.equal(dispatched, 3);
    assert.equal(paused, 1);
  });

  it("a success resets the consecutive-failure count", async () => {
    let n = 0;
    const deps = baseDeps({
      dispatch: async () => {
        n += 1;
        if (n % 2 === 1) throw new Error("odd fails");
        return { summary: "ok", costCents: 1 };
      },
    });
    const res = await runMission({
      missionId: MISSION, workspaceId: WS,
      initialTasks: [task("research", "a"), task("research", "b"), task("research", "c"), task("research", "d")],
      maxConsecutiveFailures: 2,
      deps,
    });
    assert.equal(res.status, "complete");
    assert.equal(res.reason, "queue_drained");
  });

  it("frozen workspace halts the run before any dispatch", async () => {
    let dispatched = 0;
    const deps = baseDeps({
      isWorkspaceFrozen: async () => true,
      dispatch: async () => {
        dispatched += 1;
        return { summary: "ok", costCents: 1 };
      },
    });
    await assert.rejects(
      () => runMission({ missionId: MISSION, workspaceId: WS, initialTasks: [task("research")], deps }),
      (e: unknown) => e instanceof KillSwitchError,
    );
    assert.equal(dispatched, 0);
  });

  it("paused mission stops the loop without dispatching", async () => {
    let dispatched = 0;
    const deps = baseDeps({
      isMissionPaused: async () => true,
      dispatch: async () => {
        dispatched += 1;
        return { summary: "ok", costCents: 1 };
      },
    });
    const res = await runMission({ missionId: MISSION, workspaceId: WS, initialTasks: [task("research")], deps });
    assert.equal(res.status, "paused");
    assert.equal(res.reason, "mission_paused");
    assert.equal(dispatched, 0);
  });
});

// ---------------------------------------------------------------------------
// Executor safety: killswitch-first, tool allow-lists, read-only/draft-only.
// ---------------------------------------------------------------------------

describe("executor safety", () => {
  it("killswitch checks run before any executor tool (frozen -> halt, tool untouched)", async () => {
    let toolCalls = 0;
    await assert.rejects(
      () =>
        runResearcher(
          { workspaceId: WS, query: "churn" },
          {
            isWorkspaceFrozen: async () => true,
            contextPacket: async () => {
              toolCalls += 1;
              throw new Error("must not be called");
            },
          },
        ),
      (e: unknown) => e instanceof KillSwitchError,
    );
    assert.equal(toolCalls, 0, "no tool ran before the killswitch check");
  });

  it("paused mission halts the executor before tools", async () => {
    await assert.rejects(
      () =>
        runAnalyst(
          { workspaceId: WS, missionId: MISSION, hypothesis: "h", action: "a", result: "worked" },
          { isMissionPaused: async () => true },
        ),
      (e: unknown) => e instanceof KillSwitchError,
    );
  });

  it("each executor throws when asked to use a tool outside its allow-list", () => {
    assert.throws(() => assertToolAllowed("researcher", RESEARCHER_TOOLS, "send_email"), /not in the allow-list/);
    assert.throws(() => assertToolAllowed("planner", PLANNER_TOOLS, "execute_plan"), /not in the allow-list/);
    assert.throws(() => assertToolAllowed("drafter", DRAFTER_TOOLS, "send"), /not in the allow-list/);
    assert.throws(() => assertToolAllowed("drafter", DRAFTER_TOOLS, "publish"), /not in the allow-list/);
    assert.throws(() => assertToolAllowed("analyst", ANALYST_TOOLS, "delete"), /not in the allow-list/);
    assert.throws(() => assertToolAllowed("scheduler", SCHEDULER_TOOLS, "send_reminder"), /not in the allow-list/);
    // Allowed tools pass.
    assert.doesNotThrow(() => assertToolAllowed("researcher", RESEARCHER_TOOLS, "substrate.context"));
    assert.doesNotThrow(() => assertToolAllowed("drafter", DRAFTER_TOOLS, "mission_approval.create"));
  });

  it("researcher is read-only: allow-list contains no write tool", () => {
    const writeish = ["write", "create", "send", "publish", "execute", "update", "delete", "dispatch"];
    for (const tool of RESEARCHER_TOOLS) {
      assert.ok(!writeish.some((w) => tool.includes(w)), `researcher tool "${tool}" looks writable`);
    }
  });

  it("planner output never contains executed side effects", async () => {
    const r = await runPlanner({ workspaceId: WS, goal: "get 40 booked jobs" });
    for (const step of r.plan.steps) {
      assert.equal(step.status, "proposed");
    }
    assertNoExecutionMarkers(r.plan);
    assert.doesNotThrow(() => MissionPlanSchema.parse(r.plan));
  });

  it("planner rejects a tampered plan carrying execution markers", async () => {
    const evil = {
      goal: "x",
      budgetCents: 100,
      steps: [
        { id: "s1", executor: "drafter", task: "draft", inputs: {}, dependsOn: [], status: "proposed", executed: true },
      ],
      checkpoints: [],
      successMetrics: [],
    };
    await assert.rejects(
      () => runPlanner({ workspaceId: WS, goal: "x", compose: () => evil as never }),
      /executed side effects/,
    );
  });

  it("drafter never sends: drafts + creates a Tier-2 approval instead", async () => {
    const store = createMemoryMissionApprovalStore();
    const r = await runDrafter(
      { workspaceId: WS, missionId: MISSION, brief: "Win back lapsed HVAC customers", artifactKind: "outreach", channel: "email" },
      { approvalStore: store },
    );
    assert.equal(r.draft.status, "draft");
    assert.equal(r.approval.tier, 2);
    assert.equal(r.approval.action, "outreach_send");
    assert.equal(r.approval.status, "pending");
    // The approval is real in the store.
    const fetched = await store.get(r.approval.id, WS);
    assert.ok(fetched);
    assert.equal(fetched!.bindingHash, r.approval.bindingHash);
  });

  it("analyst writes learnings to Growth Memory via the injected write path", async () => {
    const written: Array<{ ws: string; input: Record<string, unknown> }> = [];
    const r = await runAnalyst(
      { workspaceId: WS, missionId: MISSION, hypothesis: "Email beats SMS", action: "sent 200 emails", result: "worked", metricDelta: { replies: +12 } },
      {
        recall: async () => [],
        writeLearning: async (ws, input) => {
          written.push({ ws, input: input as unknown as Record<string, unknown> });
          return { id: "learn_1", redactions: 0 };
        },
      },
    );
    assert.equal(r.learningId, "learn_1");
    assert.equal(written.length, 1);
    assert.equal(written[0].ws, WS);
    assert.equal((written[0].input as Record<string, unknown>).result, "worked");
    assert.ok(String(r.attribution).includes("learn_1".slice(-8)));
  });

  it("scheduler returns proposals only — nothing armed, sent, or fired", async () => {
    const plan = await runPlanner({ workspaceId: WS, goal: "fill slow season" }).then((r) => r.plan);
    const r = await runScheduler(
      { workspaceId: WS, missionId: MISSION, plan },
      { readTimeline: async () => [] },
    );
    assert.equal(r.checkpoints.length, plan.checkpoints.length);
    assert.equal(r.reminders.length, plan.checkpoints.length);
    for (const rem of r.reminders) {
      assert.ok(rem.message.includes("proposed, not sent"));
    }
    assert.ok(r.summary.includes("nothing was armed, sent, or fired"));
  });

  it("the planner's scheduler step carries its plan, so the scheduler runs instead of throwing a TypeError", async () => {
    const plan = await runPlanner({ workspaceId: WS, goal: "fill slow season" }).then((r) => r.plan);
    const tasks = planToTasks(plan, task("plan", "root"));
    const sched = tasks.find((t) => t.kind === "schedule");
    assert.ok(sched, "the default plan has a scheduler step");
    const carried = (sched.payload as { plan?: typeof plan }).plan;
    assert.ok(carried, "scheduler task payload carries the plan");
    const r = await runScheduler(
      { workspaceId: WS, missionId: MISSION, plan: carried },
      { readTimeline: async () => [] },
    );
    assert.equal(r.checkpoints.length, plan.checkpoints.length);
    // Only the scheduler step carries the plan; other steps keep their own inputs.
    for (const t of tasks.filter((x) => x.kind !== "schedule")) {
      assert.equal((t.payload as Record<string, unknown>).plan, undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Ask: citations + propose-only.
// ---------------------------------------------------------------------------

describe("ask (propose-only)", () => {
  const fakeResearcher = async () => ({
    executor: "researcher" as const,
    summary: "Findings: 2 nodes about churn.",
    citations: [
      { type: "graph_node", id: "n1", label: "metric: churn rate" },
      { type: "memory", id: "m1", label: "Q3 retention learning" },
    ],
    packetStats: { graphNodes: 1, graphEdges: 0, memories: 1 },
    costCents: 2,
  });

  it("returns citations from the researcher", async () => {
    const logged: Array<Record<string, unknown>> = [];
    const r = await answerAsk(
      { workspaceId: WS, userId: "u1", query: "what do we know about churn?" },
      { researcher: fakeResearcher as never, logAsk: async (i) => { logged.push(i as never); } },
    );
    assert.equal(r.citations.length, 2);
    assert.equal(r.citations[0].type, "graph_node");
    assert.equal(r.proposedAction, null, "Tier-0 question -> no drafted action");
    assert.equal(logged.length, 1, "ask is audit-logged");
  });

  it("a write-implying query returns a drafted request, never an execution", async () => {
    const r = await answerAsk(
      { workspaceId: WS, userId: "u1", query: "send the outreach email to 500 leads" },
      { researcher: fakeResearcher as never, logAsk: async () => {} },
    );
    assert.ok(r.proposedAction, "write action -> drafted request");
    assert.equal(r.proposedAction!.kind, "drafted_request");
    assert.equal(r.proposedAction!.tier, 2);
    assert.ok(r.answer.includes("drafted request"));
    assert.ok(r.citations.length > 0);
  });

  it("a Tier-3 query is refused outright (hard deny, not even drafted)", async () => {
    const r = await answerAsk(
      { workspaceId: WS, userId: "u1", query: "buy $5000 in ads for the client" },
      { researcher: fakeResearcher as never, logAsk: async () => {} },
    );
    assert.equal(r.proposedAction, null);
    assert.ok(/Tier-3|hard-denied/.test(r.answer), "refusal explains the hard deny");
  });

  it("frozen workspace halts ask before the researcher runs", async () => {
    let ran = 0;
    await assert.rejects(
      () =>
        answerAsk(
          { workspaceId: WS, userId: "u1", query: "hello" },
          {
            isWorkspaceFrozen: async () => true,
            researcher: (async () => { ran += 1; throw new Error("must not run"); }) as never,
            logAsk: async () => {},
          },
        ),
      (e: unknown) => e instanceof KillSwitchError,
    );
    assert.equal(ran, 0);
  });
});

// ---------------------------------------------------------------------------
// Prisma MissionApprovalStore (fake tx — no database needed).
// ---------------------------------------------------------------------------

function createFakeTx(): { tx: ApprovalTx; approvals: Map<string, ApprovalRow>; events: Array<Record<string, unknown>> } {
  const approvals = new Map<string, ApprovalRow>();
  const events: Array<Record<string, unknown>> = [];
  let n = 0;
  const tx: ApprovalTx = {
    missionApproval: {
      async create({ data }) {
        n += 1;
        const d = data as Record<string, unknown>;
        const row: ApprovalRow = {
          id: `ap_fake_${n}`,
          workspaceId: d.workspaceId as string,
          missionId: (d.missionId as string | null) ?? null,
          action: d.action as string,
          tier: d.tier as number,
          bindingJson: d.bindingJson,
          bindingHash: d.bindingHash as string,
          status: "pending",
          expiresAt: d.expiresAt as Date,
          decidedAt: null,
          createdBy: d.createdBy as string,
          createdAt: new Date(),
        };
        approvals.set(row.id, row);
        return row;
      },
      async findFirst({ where }) {
        const row = approvals.get(where.id);
        // Defense-in-depth: the workspace filter is enforced even here.
        return row && row.workspaceId === where.workspaceId ? { ...row } : null;
      },
      async update({ where, data }) {
        const row = approvals.get(where.id);
        if (!row) throw new Error("not found");
        const d = data as Record<string, unknown>;
        if (d.status) row.status = d.status as string;
        if (d.decidedAt) row.decidedAt = d.decidedAt as Date;
        return { ...row };
      },
    },
    missionEvent: {
      async findFirst({ where, select: _select }) {
        void _select;
        const prefix = where.step.startsWith;
        const matches = events.filter(
          (e) =>
            e.missionId === where.missionId &&
            e.workspaceId === where.workspaceId &&
            String(e.step).startsWith(prefix),
        );
        matches.sort((a, b) => (b.ts as Date).getTime() - (a.ts as Date).getTime());
        return matches.length ? { eventHash: matches[0].eventHash as string } : null;
      },
      async create({ data }) {
        n += 1;
        const id = `me_fake_${n}`;
        events.push({ id, ...(data as Record<string, unknown>) });
        return { id };
      },
    },
  };
  return { tx, approvals, events };
}

describe("Prisma MissionApprovalStore", () => {
  it("implements the memory-twin interface: create/get/setStatus/appendEvent", async () => {
    const { tx } = createFakeTx();
    const seenScopes: string[] = [];
    const store = createPrismaMissionApprovalStore(async (ws, fn) => {
      seenScopes.push(ws);
      return fn(tx);
    });

    const created = await store.create({
      workspaceId: WS,
      missionId: MISSION,
      action: "outreach_send",
      tier: 2,
      bindingJson: { to: "leads", draft: "hi" },
      createdBy: "chief-strategy-agent",
    });
    assert.ok(created.id);
    assert.equal(created.status, "pending");
    assert.equal(created.bindingHash.length, 64);
    assert.ok(created.expiresAt instanceof Date, "default expiresAt (Prisma NOT NULL)");

    const fetched = await store.get(created.id, WS);
    assert.ok(fetched);
    assert.equal(fetched!.id, created.id);

    // Cross-workspace reads see nothing (defense-in-depth where filter).
    const cross = await store.get(created.id, "ws_other");
    assert.equal(cross, null);

    const approved = await store.setStatus(created.id, WS, "approved", { decidedAt: new Date() });
    assert.equal(approved.status, "approved");
    assert.ok(approved.decidedAt instanceof Date);

    // Every call ran inside a workspace scope (tenant GUC equivalent).
    // The cross-workspace probe is scoped to the REQUESTED workspace —
    // isolation is enforced by scope + where-filter, not caller trust.
    assert.deepEqual(seenScopes, [WS, WS, "ws_other", WS]);

    // Chain events: GENESIS -> chained.
    const e1 = await store.appendEvent(created.id, WS, "executor", "executed", { tier: 2 });
    assert.equal(e1.prevHash, "GENESIS");
    assert.equal(e1.eventHash.length, 64);
    const e2 = await store.appendEvent(created.id, WS, "executor", "noted", { note: "x" });
    assert.equal(e2.prevHash, e1.eventHash, "per-approval chain links");
  });

  it("appendEvent on a mission-less approval throws loudly", async () => {
    const { tx } = createFakeTx();
    const store = createPrismaMissionApprovalStore(async (_ws, fn) => fn(tx));
    const created = await store.create({
      workspaceId: WS,
      action: "outreach_send",
      tier: 2,
      bindingJson: {},
      createdBy: "chief-strategy-agent",
    });
    assert.equal(created.missionId, null);
    await assert.rejects(
      () => store.appendEvent(created.id, WS, "executor", "executed", {}),
      (e: unknown) => e instanceof ApprovalError && /mission-scoped trail/.test((e as Error).message),
    );
  });

  it("create honors an explicit expiresAt", async () => {
    const { tx } = createFakeTx();
    const store = createPrismaMissionApprovalStore(async (_ws, fn) => fn(tx));
    const exp = new Date(Date.now() + 3_600_000);
    const created = await store.create({
      workspaceId: WS,
      action: "outreach_send",
      tier: 2,
      bindingJson: {},
      createdBy: "u1",
      expiresAt: exp,
    });
    assert.equal(created.expiresAt!.getTime(), exp.getTime());
  });
});

// ---------------------------------------------------------------------------
// M9: Expert corpus wiring in the Researcher (behind MARKETR_EXPERT_CORPUS).
// ---------------------------------------------------------------------------

function emptyPacket(query: string) {
  return {
    query,
    asOf: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    budgets: { memories: 0, graphNodes: 0 },
    graph: { nodes: [], edges: [] },
    memories: [],
  };
}

describe("researcher expert corpus (M9)", () => {
  const expertRetriever = async () => [
    {
      text: "Attract strangers with useful content; engage them; delight customers.",
      sourceTitle: "Marketr Tier 1S synthesis from HubSpot Academy",
      author: "Marketr (original synthesis)",
      license: "CC-BY-4.0",
    },
  ];

  it("is OFF by default: no expert section, no expert_corpus citations", async () => {
    const res = await runResearcher(
      { workspaceId: WS, query: "inbound marketing" },
      { contextPacket: async (_ws, q) => emptyPacket(q), expertRetriever },
    );
    assert.ok(!res.summary.includes("Expert corpus context"), "no expert section");
    assert.ok(!res.citations.some((c) => c.type === "expert_corpus"));
    assert.equal(res.expertCorpus, null);
  });

  it("appends an explicitly labeled Expert corpus context section + expert_corpus citations when enabled", async () => {
    const res = await runResearcher(
      { workspaceId: WS, query: "inbound marketing" },
      { contextPacket: async (_ws, q) => emptyPacket(q), expertCorpus: true, expertRetriever },
    );
    assert.ok(res.summary.includes("Expert corpus context"), "labeled section present");
    assert.ok(
      res.summary.includes("not workspace-owned facts"),
      "does not imply passages are workspace-owned facts",
    );
    const expert = res.citations.filter((c) => c.type === "expert_corpus");
    assert.equal(expert.length, 1);
    assert.equal(expert[0]!.id, "Marketr Tier 1S synthesis from HubSpot Academy");
    assert.ok(expert[0]!.label.includes("CC-BY-4.0"), "license in citation label");
    assert.deepEqual(res.expertCorpus, {
      hits: 1,
      sources: ["Marketr Tier 1S synthesis from HubSpot Academy"],
    });
  });

  it("degrades gracefully when the expert retriever throws", async () => {
    const res = await runResearcher(
      { workspaceId: WS, query: "inbound marketing" },
      {
        contextPacket: async (_ws, q) => emptyPacket(q),
        expertCorpus: true,
        expertRetriever: async () => {
          throw new Error("no corpus built");
        },
      },
    );
    assert.ok(res.summary.includes("Expert corpus context: unavailable"), "failure noted in summary");
    assert.equal(res.expertCorpus, null);
  });
});
