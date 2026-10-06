// Deploy PR (WS=state): what a draining process does with its agent work,
// against Postgres as the least-privilege app role.
//   DATABASE_URL=<app role> npx tsx --test lib/runtime/__tests__/agent-drain-db.test.ts
//
//   * a worker job still running at the end of the hand-off window is
//     aborted as a lease loss and RE-QUEUED AT ONCE, its attempt not charged
//     — another worker claims it immediately (no wait for the lease);
//   * a job that finishes inside the window is completed normally;
//   * inline runs (not worker jobs) are aborted with a LeaseLostError so
//     runTrackedAgentTurn hands them to the queue; worker runs are left to
//     the worker's own hand-back.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { claimAgentJobs, enqueueAgentJob, getAgentJob, releaseAgentJob } from "@/lib/agents/queue/store";
import { AgentWorker } from "@/lib/agents/queue/worker";
import type { AgentJobHandler } from "@/lib/agents/queue/handlers";
import { createAgentRun } from "@/lib/agents/runs/service";
import { isLeaseLost, registerRunAbort, releaseRunAbort } from "@/lib/agents/runs/abort";
import { drainAgentWork } from "../agent-drain";

const RUN = `deploy-drain-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  await prisma.workspace.create({ data: { id: WS, name: `drain ${WS}`, ownerUserId: "drain-owner" } });
});
after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("graceful drain of agent work", () => {
  it("releaseAgentJob re-queues a running job without charging the attempt; only its owner can", async () => {
    const job = await enqueueAgentJob({ workspaceId: WS, kind: "drain_release", payload: {} });
    const [claimed] = await claimAgentJobs(WS, "w1", 60_000, 1, ["drain_release"]);
    assert.equal(claimed?.attempts, 1);
    assert.equal(await releaseAgentJob(WS, job.id, "someone-else"), false);
    assert.equal(await releaseAgentJob(WS, job.id, "w1"), true);
    const row = await getAgentJob(WS, job.id);
    assert.equal(row?.status, "queued");
    assert.equal(row?.attempts, 0);
    assert.equal(row?.lockedBy, null);
    const [again] = await claimAgentJobs(WS, "w2", 60_000, 1, ["drain_release"]);
    assert.equal(again?.id, job.id, "claimable again at once");
    assert.equal(again?.attempts, 1);
    await withWorkspaceScope(WS, (tx) => tx.agentJob.updateMany({ where: { id: job.id }, data: { status: "succeeded" } }));
  });

  it("handBack: a quick job finishes; a long one is aborted as a lease loss and handed back", async () => {
    const seen: Array<{ id: string; leaseLost: boolean }> = [];
    const handler: AgentJobHandler = async (job, ctx) => {
      const quick = (job.payload as { quick?: boolean }).quick === true;
      if (quick) {
        await sleep(30);
        return { ok: true };
      }
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      seen.push({ id: job.id, leaseLost: isLeaseLost(ctx.signal) });
      return null;
    };
    const quick = await enqueueAgentJob({ workspaceId: WS, kind: "drain_test", payload: { quick: true } });
    const long = await enqueueAgentJob({ workspaceId: WS, kind: "drain_test", payload: { quick: false } });
    const worker = new AgentWorker({ handlers: { drain_test: handler }, kinds: ["drain_test"], pollMs: 20, log: quiet, workerId: `${RUN}-w` });
    worker.start();
    for (let i = 0; i < 100 && worker.busy < 2; i++) await sleep(20);
    assert.equal(worker.busy, 2, "both jobs running");
    const res = await worker.handBack(400);
    assert.deepEqual(res, { finished: 1, handedBack: 1 });
    assert.deepEqual(seen, [{ id: long.id, leaseLost: true }]);
    assert.equal((await getAgentJob(WS, quick.id))?.status, "succeeded");
    const back = await getAgentJob(WS, long.id);
    assert.equal(back?.status, "queued");
    assert.equal(back?.attempts, 0, "the hand-back did not cost an attempt");
    // The worker stopped claiming: nothing picked the job up again.
    await sleep(100);
    assert.equal((await getAgentJob(WS, long.id))?.status, "queued");
    await withWorkspaceScope(WS, (tx) => tx.agentJob.updateMany({ where: { id: long.id }, data: { status: "cancelled" } }));
  });

  it("drainAgentWork aborts inline runs as a lease loss and leaves the worker's runs to the worker", async () => {
    const inline = await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: "u" });
    const workerRun = await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: "u" });
    const inlineSignal = registerRunAbort(inline.id);
    const workerSignal = registerRunAbort(workerRun.id);
    const fakeWorker = {
      runIds: () => new Set([workerRun.id]),
      handBack: async () => ({ finished: 0, handedBack: 0 }),
    };
    const started = Date.now();
    const { abortedInline } = await drainAgentWork({ worker: fakeWorker, handoffMs: 150, inlineHandoff: true, log: () => undefined });
    assert.ok(Date.now() - started >= 140, "inline turns got the hand-off window first");
    assert.deepEqual(abortedInline, [inline.id]);
    assert.ok(isLeaseLost(inlineSignal), "aborted as a lease loss → runTrackedAgentTurn hands it to the queue");
    assert.equal(workerSignal.aborted, false, "the worker's own runs are its business");
    releaseRunAbort(inline.id);
    releaseRunAbort(workerRun.id);
    // With AGENT_WORKER=off there is no worker to take a turn: nothing is aborted.
    const lone = await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: "u" });
    const loneSignal = registerRunAbort(lone.id);
    const r2 = await drainAgentWork({ worker: null, handoffMs: 10, inlineHandoff: false, log: () => undefined });
    assert.deepEqual(r2.abortedInline, []);
    assert.equal(loneSignal.aborted, false);
    releaseRunAbort(lone.id);
  });
});
