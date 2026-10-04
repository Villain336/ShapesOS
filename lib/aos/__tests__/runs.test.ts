// ShapesOS — runs and missions as RunTimeline steps.
// Run: npx tsx --test lib/aos/__tests__/runs.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveRunSteps } from "../run-steps";
import {
  clockTime,
  durationLabel,
  missionTimeline,
  payloadFacts,
  planStepAsksFirst,
  runAgentName,
  runStatus,
  runTimeline,
  runTitle,
  toolCallFromPayload,
  upcomingPlanSteps,
  type RunEventInput,
} from "../runs";

const clock = (d: Date) => d.toISOString().slice(11, 16);

const EVENTS: RunEventInput[] = [
  { id: "e0", seq: 0, type: "agui", summary: "Plan the work", payload: { detail: "Split the task into 5 steps." }, createdAt: "2026-10-04T09:00:00.000Z" },
  {
    id: "e1",
    seq: 1,
    type: "agui",
    summary: "Search the web",
    payload: { detail: "Found 18 results and kept 12.", tool: "web.search", query: '"pricing"', limit: 20, result: "18 results, 12 kept", durationMs: 800 },
    createdAt: "2026-10-04T09:01:00.000Z",
  },
  { id: "e2", seq: 2, type: "agui", summary: "Read sources", payload: { progress: { done: 7, total: 12 } }, createdAt: "2026-10-04T09:02:00.000Z" },
];

describe("names", () => {
  it("mission runs are the lead's; titles prefer the mission", () => {
    assert.equal(runAgentName("mission"), "Strategist");
    assert.equal(runAgentName("browser"), "Browser agent");
    assert.equal(runAgentName("weird"), "Agent");
    // Phase 5: the run's own agent wins over its kind.
    assert.equal(runAgentName("chat", "drafter"), "Writer");
    assert.equal(runAgentName("chat", "lead"), "Strategist");
    assert.equal(runAgentName("chat", null), "Strategist");
    assert.equal(runTitle("chat", null, "Draft the renewal email.  Then schedule it"), "Draft the renewal email");
    assert.equal(runTitle("chat", null, null), "Task");
    assert.equal(runTitle("mission", "Weekly competitor brief"), "Weekly competitor brief");
    assert.equal(runTitle("browser", null), "Browser run");
  });

  it("clock time is 24h without a leading zero", () => {
    assert.equal(clockTime(new Date(2026, 9, 4, 9, 5)), "9:05");
    assert.equal(clockTime(new Date(2026, 9, 4, 14, 30)), "14:30");
    assert.equal(clockTime(new Date("nope")), "");
  });
});

describe("runStatus", () => {
  it("maps run states; a live mission run waiting on approvals needs you", () => {
    assert.equal(runStatus("running"), "running");
    assert.equal(runStatus("running", 2), "needs");
    assert.equal(runStatus("succeeded", 2), "done");
    assert.equal(runStatus("failed"), "failed");
    assert.equal(runStatus("cancelled"), null);
  });
});

describe("toolCallFromPayload", () => {
  it("draws a named tool with its scalar args, result and duration", () => {
    const t = toolCallFromPayload(EVENTS[1]!.payload)!;
    assert.equal(t.name, "web.search");
    assert.deepEqual(t.args, [
      ["query", '"pricing"'],
      ["limit", "20"],
    ]);
    assert.equal(t.result, "18 results, 12 kept");
    assert.equal(t.duration, "0.8 s");
  });

  it("is null when nothing names a tool", () => {
    assert.equal(toolCallFromPayload({ startUrl: "https://x" }), null);
    assert.equal(toolCallFromPayload(null), null);
  });

  it("durations read like the kit", () => {
    assert.equal(durationLabel(800), "0.8 s");
    assert.equal(durationLabel(12_400), "12 s");
    assert.equal(durationLabel(180_000), "3 min");
    assert.equal(durationLabel("x"), undefined);
  });

  it("other payloads become one quiet line", () => {
    assert.equal(payloadFacts({ startUrl: "https://x.co", headless: true, nested: { a: 1 } }), "startUrl https://x.co · headless true");
    assert.equal(payloadFacts({}), null);
  });
});

describe("runTimeline", () => {
  it("a live run: recorded steps, the last one current with its progress, then what is still to come", () => {
    const upcoming = upcomingPlanSteps(
      [
        { key: "a", title: "Done before", kind: "research" },
        { key: "b", title: "Draft the brief", kind: "draft", executor: "drafter" },
        { key: "c", title: "Send to your team", kind: "approval", tier: 2 },
      ],
      1,
    );
    const m = runTimeline({ status: "running", events: EVENTS, upcoming, clock });
    assert.equal(m.status, "running");
    assert.equal(m.completed, 2);
    assert.deepEqual(m.steps.map((s) => s.title), ["Plan the work", "Search the web", "Read sources", "Draft the brief", "Send to your team"]);
    assert.equal(m.steps[0]!.detail, "Split the task into 5 steps");
    assert.equal(m.steps[1]!.tool?.name, "web.search");
    assert.equal(m.steps[1]!.detail, "Found 18 results and kept 12");
    assert.deepEqual(m.steps[2]!.progress, { done: 7, total: 12 });
    assert.equal(m.steps[1]!.at, "09:01");
    assert.equal(m.steps[4]!.asksFirst, true);
    const states = deriveRunSteps(m.steps, { completed: m.completed, status: m.status }).map((s) => s.state);
    assert.deepEqual(states, ["done", "done", "running", "queued", "queued"]);
  });

  it("waiting on approvals: the current step needs you", () => {
    const m = runTimeline({ status: "running", events: EVENTS, pendingApprovals: 1, clock });
    assert.equal(m.status, "needs");
  });

  it("finished, failed, cancelled and queued runs", () => {
    const done = runTimeline({ status: "succeeded", events: EVENTS, upcoming: [{ key: "x", title: "Never shown" }], clock });
    assert.equal(done.status, "done");
    assert.equal(done.steps.length, 3);

    const failed = runTimeline({
      status: "failed",
      events: [...EVENTS.slice(0, 1), { id: "e9", seq: 1, type: "note", summary: "Sync calendar", payload: { error: "Calendar access expired." }, createdAt: "2026-10-04T09:03:00.000Z" }],
      clock,
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.completed, 1);
    assert.equal(failed.steps[1]!.detail, "Calendar access expired");

    const cancelled = runTimeline({ status: "cancelled", events: EVENTS, clock });
    assert.equal(cancelled.neutral, true);
    assert.equal(cancelled.completed, 3);

    const queued = runTimeline({ status: "queued", events: [], clock });
    assert.equal(queued.status, "queued");
    assert.deepEqual(queued.steps.map((s) => s.title), ["Waiting to start"]);

    const starting = runTimeline({ status: "running", events: [], clock });
    assert.deepEqual(starting.steps.map((s) => s.title), ["Starting"]);
    assert.equal(starting.completed, 0);
  });
});

describe("missionTimeline", () => {
  const events = [
    { ts: "2026-10-04T09:00:00.000Z", actor: "mission-engine", step: "mission.genesis" },
    { ts: "2026-10-04T09:01:00.000Z", actor: "chief-strategy-agent", step: "route.1", args: { nextAgent: "planner", taskLabel: "Plan the work" } },
    { ts: "2026-10-04T09:02:00.000Z", actor: "planner", step: "exec.1", observation: { summary: "Split the task into 5 steps." } },
    { ts: "2026-10-04T09:03:00.000Z", actor: "chief-strategy-agent", step: "route.2", args: { nextAgent: "actor", taskLabel: "Sync calendar" } },
    { ts: "2026-10-04T09:04:00.000Z", actor: "actor", step: "exec.2.error", observation: { error: "Calendar access expired." } },
  ];
  const plan = [
    { key: "p1", title: "Plan", kind: "plan", executor: "planner" },
    { key: "p2", title: "Sync", kind: "execute", executor: "actor" },
    { key: "p3", title: "Approve offer launch", kind: "approval", executor: "human", tier: 2 },
    { key: "p4", title: "Publish offer", kind: "execute", executor: "scheduler", tier: 1 },
  ];

  it("each delegation is a step; the failed one is current; unreached plan steps follow", () => {
    const t = missionTimeline({ events, plan, status: "failed", clock });
    assert.deepEqual(t.steps.map((s) => s.title), ["Plan the work", "Sync calendar", "Approve offer launch", "Publish offer"]);
    assert.equal(t.completed, 1);
    assert.equal(t.steps[0]!.detail, "Planner: Split the task into 5 steps");
    assert.equal(t.steps[1]!.detail, "Operator: Calendar access expired");
    assert.equal(t.steps[2]!.asksFirst, true);
    assert.equal(t.steps[2]!.asksFirstLabel, "Needs your approval");
    assert.equal(t.steps[3]!.asksFirst, false);
    assert.equal(t.steps[3]!.detail, "Scheduler takes this step.");
    const states = deriveRunSteps(t.steps, { completed: t.completed, status: "failed" }).map((s) => s.state);
    assert.deepEqual(states, ["done", "failed", "queued", "queued"]);
  });

  it("a finished mission lists only what happened", () => {
    const t = missionTimeline({ events: events.slice(0, 3), plan, status: "done", clock });
    assert.deepEqual(t.steps.map((s) => s.title), ["Plan the work"]);
  });

  it("asks-first rule", () => {
    assert.equal(planStepAsksFirst({ key: "a", title: "x", kind: "approval" }), true);
    assert.equal(planStepAsksFirst({ key: "a", title: "x", kind: "execute", tier: 2 }), true);
    assert.equal(planStepAsksFirst({ key: "a", title: "x", kind: "execute", tier: 1 }), false);
  });

  it("the step still open says what it waits on", () => {
    const open = [
      { ts: "2026-10-04T09:01:00.000Z", actor: "chief-strategy-agent", step: "route.1", args: { nextAgent: "drafter", taskLabel: "Draft reminders" } },
    ];
    assert.equal(missionTimeline({ events: open, plan: [], status: "needs", clock }).steps[0]!.detail, "Writer is waiting for your approval.");
    assert.equal(missionTimeline({ events: open, plan: [], status: "running", clock }).steps[0]!.detail, "Writer is working on it.");
  });
});
