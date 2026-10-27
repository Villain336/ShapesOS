// ShapesOS — Phase 8: the durable agent queue + resume, against Postgres.
//
//   1. Claim under concurrency: two workers polling at once never claim the
//      same job (FOR UPDATE SKIP LOCKED via lib/jobs/claim.ts).
//   2. Lease expiry: a job whose worker stops heartbeating is claimed again
//      (attempts +1, the old owner's heartbeat now fails); after its last
//      attempt the reaper dead-letters it. A failing handler requeues with
//      backoff, then dead-letters.
//   3. Resume: a run handed back after a "crash" continues from its saved
//      transcript (agent_run_transcripts) on another worker and never re-runs
//      a tool whose result was saved.
//   4. Mission → job → run: a launch queues a job; the worker runs the plan's
//      steps as sub-agent loops (child runs inside each executor's allow-list)
//      up to the first human step, with the hash-chained mission audit.
//   5. RLS: another workspace sees none of it.
// Runs as the least-privilege app role (scripts/test/db-tests.txt).
// Run: DATABASE_URL=… npx tsx --test lib/agents/queue/__tests__/agent-queue-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { MockLlmProvider } from "@/lib/llm/mock";
import { registerExtraTool, type ToolDef } from "@/lib/chat/tools";
import { createAgentRun, getAgentRun } from "@/lib/agents/runs/service";
import { prismaTranscriptStore } from "@/lib/agents/runs/transcript";
import { runAgentLoop, type LoopState } from "@/lib/agents/loop";
import {
  claimAgentJobs,
  enqueueAgentJob,
  getAgentJob,
  heartbeatAgentJob,
  reapExpiredJobs,
} from "../store";
import { AgentWorker } from "../worker";
import type { AgentJobHandler } from "../handlers";
import { enqueueMissionLaunch, runMissionJob, type MissionJobPayload } from "@/lib/agents/mission-runtime";
import { approveMissionPlan, startMission } from "@/lib/missions/engine";
import { createPrismaMissionStore } from "@/lib/missions/prisma-store";
import { isWorkspaceFrozen } from "@/lib/orchestrator/killswitch";
import { executorGrant } from "@/lib/orchestrator/executor-grants";

const RUN = `p8q-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sideEffects = 0;
const t_side_effect: ToolDef = {
  name: "t_queue_side_effect",
  description: "A tool with a side effect (counts its runs).",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    sideEffects++;
    return { summary: `side effect #${sideEffects}` };
  },
};

before(async () => {
  registerExtraTool(t_side_effect);
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.create({ data: { id, name: `P8 ${id}`, ownerUserId: USER } });
  }
  await prisma.project.create({ data: { workspaceId: WS_A, domain: `${RUN}.example` } });
});

after(async () => {
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

async function jobsOf(ws: string, kind: string) {
  return withWorkspaceScope(ws, (tx) => tx.agentJob.findMany({ where: { workspaceId: ws, kind }, orderBy: { createdAt: "asc" } }));
}

describe("agent queue (Postgres, app role)", () => {
  it("two workers polling at once never claim the same job", async () => {
    const N = 12;
    for (let i = 0; i < N; i++) await enqueueAgentJob({ workspaceId: WS_A, kind: "concurrency", payload: { i } });
    // Many concurrent claim transactions from two workers, interleaved.
    const claimed: string[][] = [[], []];
    await Promise.all(
      [0, 1, 0, 1, 0, 1].map(async (w) => {
        for (let round = 0; round < N; round++) {
          const got = await claimAgentJobs(WS_A, `worker-${w}`, 60_000, 2);
          claimed[w]!.push(...got.filter((j) => j.kind === "concurrency").map((j) => j.id));
          if (got.length === 0) break;
        }
      }),
    );
    const all = [...claimed[0]!, ...claimed[1]!];
    assert.equal(all.length, N, "every job claimed");
    assert.equal(new Set(all).size, N, "no job claimed twice");
    const rows = await jobsOf(WS_A, "concurrency");
    assert.ok(rows.every((r) => r.status === "running" && r.attempts === 1 && r.leaseUntil));
    // Leave nothing claimable for the next tests.
    await withWorkspaceScope(WS_A, (tx) => tx.agentJob.updateMany({ where: { workspaceId: WS_A, kind: "concurrency" }, data: { status: "succeeded" } }));
  });

  it("an expired lease is claimed again; the old owner loses it; the last attempt is dead-lettered", async () => {
    const job = await enqueueAgentJob({ workspaceId: WS_A, kind: "lease", payload: {}, maxAttempts: 2 });
    const [first] = await claimAgentJobs(WS_A, "w-old", 150);
    assert.equal(first?.id, job.id);
    assert.equal(first?.attempts, 1);
    assert.deepEqual(await claimAgentJobs(WS_A, "w-new", 60_000), [], "not claimable while the lease holds");
    await sleep(300);
    const [second] = await claimAgentJobs(WS_A, "w-new", 150);
    assert.equal(second?.id, job.id, "requeued after the lease expired");
    assert.equal(second?.attempts, 2);
    assert.equal(await heartbeatAgentJob(WS_A, job.id, "w-old", 60_000), false, "the old worker lost the job");
    await sleep(300);
    assert.deepEqual(await claimAgentJobs(WS_A, "w-third", 60_000), [], "no attempts left");
    const dead = await reapExpiredJobs(WS_A);
    assert.deepEqual(dead.map((d) => d.id), [job.id]);
    assert.equal((await getAgentJob(WS_A, job.id))?.status, "dead");
  });

  it("a failing handler requeues with backoff, then dead-letters; the worker completes good jobs", async () => {
    const bad = await enqueueAgentJob({ workspaceId: WS_A, kind: "always_fails", payload: {}, maxAttempts: 2 });
    const good = await enqueueAgentJob({ workspaceId: WS_A, kind: "works", payload: { n: 1 } });
    const handlers: Record<string, AgentJobHandler> = {
      async always_fails() {
        throw new Error("boom");
      },
      async works(j) {
        return { echoed: (j.payload as { n: number }).n };
      },
    };
    const w = new AgentWorker({ handlers, log: quiet, concurrency: 4, leaseMs: 30_000, heartbeatMs: 5_000 });
    await w.tick();
    await w.drain();
    let b = await getAgentJob(WS_A, bad.id);
    assert.equal(b?.status, "queued");
    assert.equal(b?.attempts, 1);
    assert.match(b?.lastError ?? "", /boom/);
    assert.ok(b!.runAfter.getTime() > Date.now(), "retry waits (backoff)");
    const g = await getAgentJob(WS_A, good.id);
    assert.equal(g?.status, "succeeded");
    assert.deepEqual(g?.result, { echoed: 1 });
    // Make the retry due now; the second failure is the last attempt.
    await withWorkspaceScope(WS_A, (tx) => tx.agentJob.update({ where: { id: bad.id }, data: { runAfter: new Date(Date.now() - 1000) } }));
    await w.tick();
    await w.drain();
    b = await getAgentJob(WS_A, bad.id);
    assert.equal(b?.status, "dead");
    assert.equal(b?.attempts, 2);
  });

  it("resumes from the saved transcript on another worker without re-running a finished tool", async () => {
    sideEffects = 0;
    const run = await createAgentRun({ workspaceId: WS_A, kind: "chat", startedBy: USER, agentKey: "lead" });
    const job = await enqueueAgentJob({ workspaceId: WS_A, kind: "resumable_loop", runId: run.id, payload: {} });
    const provider = new MockLlmProvider({
      chatScript: [
        { content: [{ type: "tool_use", id: "tu_side", name: "t_queue_side_effect", input: {} }] },
        (req) => {
          const last = req.messages[req.messages.length - 1]!;
          assert.equal(last.role, "user", "resumed with the saved tool result");
          return { content: [{ type: "text", text: "Finished on the second worker." }] };
        },
      ],
    });
    const loopCtx = (signal: AbortSignal) => ({
      projectId: "",
      workspaceId: WS_A,
      userId: USER,
      role: "editor" as const,
      confirmed: false,
      agentKey: "lead" as const,
      grant: null,
      runId: run.id,
      signal,
    });

    // Worker 1 claims, runs one step (the tool ran, its result saved) and
    // "crashes": it stops without completing the job or heartbeating.
    const [claimed] = await claimAgentJobs(WS_A, "worker-crashes", 200);
    assert.equal(claimed?.id, job.id);
    const first = await runAgentLoop({
      ctx: loopCtx(new AbortController().signal),
      system: "You are a test agent.",
      messages: [{ role: "user", content: "do it" }],
      handoffAt: 0, // stop right after the first step, as a crash would
      deps: { provider, store: prismaTranscriptStore, persistEvents: false },
    });
    assert.equal(first.status, "handoff");
    assert.equal(sideEffects, 1);
    const saved = (await prismaTranscriptStore.load(WS_A, run.id)) as LoopState;
    assert.ok(saved.toolResults.tu_side, "the tool result is saved in agent_run_transcripts");

    // The lease expires; worker 2 picks the job up and resumes the run.
    await sleep(350);
    const w2 = new AgentWorker({
      workerId: "worker-2",
      log: quiet,
      leaseMs: 30_000,
      heartbeatMs: 5_000,
      handlers: {
        async resumable_loop(j, c) {
          const res = await runAgentLoop({ ctx: loopCtx(c.signal), deps: { provider, store: prismaTranscriptStore, persistEvents: false } });
          return { status: res.status, text: res.finalText };
        },
      },
    });
    await w2.tick();
    const [outcome] = await w2.drain();
    assert.equal(outcome?.status, "succeeded");
    const done = await getAgentJob(WS_A, job.id);
    assert.equal(done?.status, "succeeded");
    assert.equal(done?.attempts, 2, "claimed twice: the crash, then the resume");
    assert.deepEqual(done?.result, { status: "done", text: "Finished on the second worker." });
    assert.equal(sideEffects, 1, "the finished tool was never re-run");
    const after = (await prismaTranscriptStore.load(WS_A, run.id)) as LoopState;
    assert.equal(after.outcome?.status, "done");
  });

  it("mission launch → job → runs: each step is a sub-agent loop inside its executor's allow-list", async () => {
    const deps = {
      store: createPrismaMissionStore(),
      isWorkspaceFrozen,
      isMissionPaused: async () => false,
    };
    const mission = await startMission(deps, {
      workspaceId: WS_A,
      userId: USER,
      templateId: "home-services.booked-job-growth",
      goal: { metric: "booked_jobs", targetValue: 40, timeframeDays: 90 },
      name: "P8 queue test",
    });
    // The whole-plan gate: launching is refused while the plan is unapproved.
    await assert.rejects(
      enqueueMissionLaunch({ missionId: mission.id, workspaceId: WS_A, userId: USER }),
      /awaiting/,
    );
    // A person approves the drafted plan, then the launch is queued.
    await approveMissionPlan(deps, mission.id, WS_A, USER);
    const launch = await enqueueMissionLaunch({ missionId: mission.id, workspaceId: WS_A, userId: USER });
    // Retry-safe + idempotent: a repeat launch returns the same run and job
    // instead of double-starting the worker.
    const retryLaunch = await enqueueMissionLaunch({ missionId: mission.id, workspaceId: WS_A, userId: USER });
    assert.equal(retryLaunch.runId, launch.runId, "same launch run on retry");
    assert.equal(retryLaunch.jobId, launch.jobId, "same queued job on retry");

    // True-parallel launches converge: the mission-row lock serializes the
    // check+create, so both callers adopt the one launch run and job.
    const [c1, c2] = await Promise.all([
      enqueueMissionLaunch({ missionId: mission.id, workspaceId: WS_A, userId: USER }),
      enqueueMissionLaunch({ missionId: mission.id, workspaceId: WS_A, userId: USER }),
    ]);
    assert.equal(c1.runId, launch.runId, "concurrent launch adopts the existing run");
    assert.equal(c2.runId, launch.runId, "concurrent launch adopts the existing run");
    assert.equal((await jobsOf(WS_A, "mission")).length, 1, "still exactly one mission job");

    // Failure after the run was created but before the job: a retry adopts
    // the orphaned run and queues its job instead of starting a second run.
    const mission2 = await startMission(deps, {
      workspaceId: WS_A,
      userId: USER,
      templateId: "home-services.booked-job-growth",
      goal: { metric: "booked_jobs", targetValue: 40, timeframeDays: 90 },
      name: "P8 orphan-run retry",
    });
    await approveMissionPlan(deps, mission2.id, WS_A, USER);
    const orphan = await createAgentRun({
      workspaceId: WS_A,
      kind: "mission",
      startedBy: USER,
      missionId: mission2.id,
      agentKey: "lead",
      agentState: { missionId: mission2.id },
    });
    const resumed = await enqueueMissionLaunch({ missionId: mission2.id, workspaceId: WS_A, userId: USER });
    assert.equal(resumed.runId, orphan.id, "retry adopts the orphaned launch run");
    assert.ok(resumed.jobId, "retry queues the missing job");
    const runs = await jobsOf(WS_A, "mission");
    assert.equal(runs.filter((j) => j.runId === orphan.id).length, 1, "one job for the adopted run");
    const [job] = (await jobsOf(WS_A, "mission")).filter((j) => j.runId === launch.runId);
    assert.ok(job, "the launch queued a mission job");
    assert.equal(job!.status, "queued");

    const instructions: string[] = [];
    const provider = new MockLlmProvider({
      chatScript: [
        (req) => {
          const sys = typeof req.system === "string" ? req.system : (req.system ?? []).map((b) => b.text).join("\n");
          instructions.push(sys);
          return { content: [{ type: "text", text: `Step report ${instructions.length}.` }] };
        },
      ],
    });
    const w = new AgentWorker({
      log: quiet,
      leaseMs: 60_000,
      heartbeatMs: 10_000,
      handlers: {
        // The real mission handler with the sub-agent loop forced on (the
        // test has no live model key) and a scripted mock model.
        async mission(j, c) {
          return runMissionJob(j.payload as MissionJobPayload, { signal: c.signal, runId: j.runId, live: true, loopDeps: { provider } });
        },
      },
    });
    await w.tick();
    const outcomes = await w.drain();
    assert.ok(outcomes.some((o) => o.jobId === job!.id && o.status === "succeeded"), JSON.stringify(outcomes));

    const parent = await getAgentRun(WS_A, launch.runId);
    assert.equal(parent?.status, "succeeded");
    assert.equal(parent?.kind, "mission");
    const children = await withWorkspaceScope(WS_A, (tx) =>
      tx.agentRun.findMany({ where: { workspaceId: WS_A, parentRunId: launch.runId }, orderBy: { createdAt: "asc" } }),
    );
    assert.deepEqual(children.map((c) => c.agentKey), ["researcher", "planner", "drafter"], "steps up to the first human approval");
    for (const c of children) {
      assert.equal(c.status, "succeeded");
      assert.equal(c.missionId, mission.id);
      assert.deepEqual(c.allowedTools, executorGrant(c.agentKey as "researcher").groups, "the executor's allow-list as tool groups");
    }
    assert.deepEqual(children.find((c) => c.agentKey === "drafter")?.allowedTools, ["workspace", "content"]);
    assert.ok(instructions[0]!.includes("Researcher sub-agent") || instructions[0]!.includes("Role: Researcher"));

    // Hash-chained mission audit: routing + execution per step, then the human wait.
    const events = await withWorkspaceScope(WS_A, (tx) =>
      tx.missionEvent.findMany({ where: { missionId: mission.id, workspaceId: WS_A }, orderBy: { ts: "asc" } }),
    );
    const steps = events.map((e) => e.step);
    assert.ok(steps.includes("route.1") && steps.includes("exec.3"), steps.join(","));
    assert.ok(steps.includes("mission.awaiting_human"));
    for (let i = 1; i < events.length; i++) assert.equal(events[i]!.prevHash, events[i - 1]!.eventHash, "chain intact");

    // A re-run of the same job never repeats finished steps.
    const before = children.length;
    await withWorkspaceScope(WS_A, (tx) => tx.agentRun.update({ where: { id: launch.runId }, data: { status: "running", endedAt: null } }));
    await runMissionJob({ missionId: mission.id, workspaceId: WS_A, userId: USER }, { runId: launch.runId, live: true, loopDeps: { provider } });
    const again = await withWorkspaceScope(WS_A, (tx) => tx.agentRun.count({ where: { workspaceId: WS_A, parentRunId: launch.runId } }));
    assert.equal(again, before, "steps already done are skipped");
  });

  it("RLS: another workspace sees no jobs or transcripts and cannot claim them", async () => {
    const job = await enqueueAgentJob({ workspaceId: WS_A, kind: "rls", payload: { secret: 1 } });
    assert.equal(await getAgentJob(WS_B, job.id), null);
    const leaked = await withWorkspaceScope(WS_B, (tx) => tx.agentJob.count({ where: { id: job.id } }));
    assert.equal(leaked, 0);
    const transcripts = await withWorkspaceScope(WS_B, (tx) => tx.agentRunTranscript.count());
    assert.equal(transcripts, 0);
    const stolen = await claimAgentJobs(WS_B, "intruder", 60_000, 10);
    assert.ok(!stolen.some((j) => j.id === job.id));
    // Without any GUC the table is invisible (fail-closed).
    const bare = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "agent_jobs"`);
    assert.equal(bare[0]!.n, 0);
  });
});
