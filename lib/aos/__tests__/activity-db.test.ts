// ShapesOS — Phase 18.2 (WS=content): the Activity Monitor against real Postgres.
//   - loadProcesses lists this workspace's runs (sub-agent runs nested under
//     their lead, cost so far from the run's usage events, the run budget),
//     jobs, terminal sessions — never another workspace's
//   - Stop through the EXISTING paths: a run → requestAgentRunCancel (the
//     sub-agent tree too; a queued run is cancelled outright); a queued job
//     without a run → cancelled; a running job without a run → refused; a job
//     on a run → its run stops and the run's jobs are cancelled; a terminal
//     session → ended; another workspace's process → not found
//   - who: the person who started it or an admin/owner; nobody else
//   - every Stop is audited (process_stopped)
//   - health: queue depth, the oldest waiting job, jobs out of retries
//   - the list_processes agent tool (Tier 0, read-only)
// Run (as the least-privilege app role):
//   DATABASE_URL=… npx tsx --test lib/aos/__tests__/activity-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { loadProcesses, loadSystemHealth } from "../activity.server";
import { stopProcess } from "../stop.server";
import { list_processes } from "../tools";
import { getTool, toolGroup } from "@/lib/chat/tools";

const RUN = randomUUID().slice(0, 8);
const WS = `p182a-${RUN}`;
const OTHER = `p182a-other-${RUN}`;
const ANA = `p182a-ana-${RUN}`; // editor, starts the runs
const BEN = `p182a-ben-${RUN}`; // editor
const ADM = `p182a-adm-${RUN}`; // admin
const ana = { userId: ANA, isAdmin: false };
const ben = { userId: BEN, isAdmin: false };
const adm = { userId: ADM, isAdmin: true };

const ids = { lead: "", child: "", queuedRun: "", otherRun: "", jobQueued: "", jobRunning: "", jobOnRun: "", jobRunOwner: "", terminal: "", cron: "" };

async function scoped<T>(ws: string, fn: (tx: Parameters<Parameters<typeof withWorkspaceScope>[1]>[0]) => Promise<T>): Promise<T> {
  return withWorkspaceScope(ws, fn);
}

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, OTHER] } } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ADM } });
  await prisma.workspace.create({ data: { id: OTHER, name: OTHER, ownerUserId: ADM } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ANA, role: "editor", email: `ana-${RUN}@example.test`, name: "Ana" },
      { workspaceId: WS, userId: BEN, role: "editor", email: `ben-${RUN}@example.test`, name: "Ben" },
      { workspaceId: WS, userId: ADM, role: "admin", email: `adm-${RUN}@example.test`, name: "Adm" },
    ],
  });
  await scoped(WS, async (tx) => {
    const lead = await tx.agentRun.create({ data: { workspaceId: WS, kind: "chat", status: "running", startedBy: ANA, agentKey: "lead" } });
    const child = await tx.agentRun.create({ data: { workspaceId: WS, kind: "chat", status: "running", startedBy: ANA, agentKey: "research", parentRunId: lead.id } });
    const queuedRun = await tx.agentRun.create({ data: { workspaceId: WS, kind: "mission", status: "queued", startedBy: ANA } });
    const jobRunOwner = await tx.agentRun.create({ data: { workspaceId: WS, kind: "playbook", status: "running", startedBy: BEN } });
    const old = new Date(Date.now() - 5 * 60_000);
    const jobQueued = await tx.agentJob.create({ data: { workspaceId: WS, kind: "llm_usage", payload: {}, status: "queued", runAfter: old } });
    const jobRunning = await tx.agentJob.create({ data: { workspaceId: WS, kind: "llm_batch", payload: {}, status: "running", heartbeatAt: new Date(Date.now() - 4_000) } });
    const jobOnRun = await tx.agentJob.create({ data: { workspaceId: WS, kind: "agent_run", payload: {}, status: "queued", runId: jobRunOwner.id } });
    await tx.agentJob.create({ data: { workspaceId: WS, kind: "llm_usage", payload: {}, status: "dead", lastError: "gave up" } });
    const terminal = await tx.terminalSession.create({ data: { workspaceId: WS, userId: BEN, provider: "docker", sandboxId: "sb-test", status: "active" } });
    await tx.usageEvent.createMany({
      data: [
        { workspaceId: WS, action: "llm_tokens", credits: 1, idempotencyKey: `p182a-${RUN}-1`, evidenceRef: `agent_run:${lead.id}`, llmCostMicroUsd: BigInt(120_000) },
        { workspaceId: WS, action: "llm_tokens", credits: 1, idempotencyKey: `p182a-${RUN}-2`, evidenceRef: `agent_run:${lead.id}`, llmCostMicroUsd: BigInt(30_000) },
      ],
    });
    Object.assign(ids, { lead: lead.id, child: child.id, queuedRun: queuedRun.id, jobQueued: jobQueued.id, jobRunning: jobRunning.id, jobOnRun: jobOnRun.id, jobRunOwner: jobRunOwner.id, terminal: terminal.id });
  });
  // A scheduled job run (cron_runs is system-wide).
  ids.cron = (await prisma.cronRun.create({ data: { job: `p182a-job-${RUN}`, scheduledFor: new Date(), status: "running" } })).id;
  ids.otherRun = (await scoped(OTHER, (tx) => tx.agentRun.create({ data: { workspaceId: OTHER, kind: "chat", status: "running", startedBy: ANA } }))).id;
});

after(async () => {
  await prisma.cronRun.deleteMany({ where: { job: `p182a-job-${RUN}` } });
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, OTHER] } } });
  await prisma.$disconnect();
});

describe("Activity Monitor (DB)", () => {
  it("lists this workspace's processes — nested sub-agents, cost so far, budget — and never another's", async () => {
    const rows = await loadProcesses(WS, ana);
    const keys = rows.map((r) => r.key);
    for (const k of [`run:${ids.lead}`, `run:${ids.child}`, `run:${ids.queuedRun}`, `job:${ids.jobQueued}`, `job:${ids.jobRunning}`, `terminal:${ids.terminal}`]) assert.ok(keys.includes(k), `lists ${k}`);
    assert.ok(!keys.includes(`run:${ids.otherRun}`), "never another workspace's run");
    assert.equal(keys.indexOf(`run:${ids.child}`), keys.indexOf(`run:${ids.lead}`) + 1, "the sub-agent run follows its lead");
    const lead = rows.find((r) => r.key === `run:${ids.lead}`)!;
    assert.equal(lead.costMicroUsd, 150_000, "cost so far = the run's usage events");
    assert.ok(lead.budget && lead.budget.costMicroUsd > 0 && lead.budget.ms > 0, "chat runs carry the run budget");
    assert.equal(lead.status, "running");
    assert.deepEqual(lead.stop, { allowed: true }, "Ana started it");
    const term = rows.find((r) => r.key === `terminal:${ids.terminal}`)!;
    assert.equal(term.status, null, "a person's terminal is neutral, never an agent colour");
    assert.deepEqual(term.stop, { allowed: false, reason: "not_yours" }, "Ana can't stop Ben's terminal");
    const asAdmin = await loadProcesses(WS, adm);
    assert.deepEqual(asAdmin.find((r) => r.key === `terminal:${ids.terminal}`)!.stop, { allowed: true }, "an admin can");
    assert.deepEqual(rows.find((r) => r.key === `job:${ids.jobRunning}`)!.stop, { allowed: false, reason: "not_stoppable" });
    // Scheduled jobs: admins only, neutral, not stoppable from here.
    assert.ok(!keys.includes(`cron:${ids.cron}`), "members don't see the system-wide scheduled jobs");
    const cron = asAdmin.find((r) => r.key === `cron:${ids.cron}`)!;
    assert.ok(cron, "admins do");
    assert.deepEqual([cron.status, cron.state, cron.live, cron.stop.allowed], [null, "running", true, false]);
    await assert.rejects(stopProcess(WS, adm, `cron:${ids.cron}`), /can't be stopped from here/);
  });

  it("health: queue depth, the oldest waiting job, jobs out of retries, heartbeat", async () => {
    const h = await loadSystemHealth(WS, ana);
    assert.equal(h.queueDepth, 2, "the queued llm_usage job and the queued run job");
    assert.ok(h.oldestQueuedMs !== null && h.oldestQueuedMs >= 4 * 60_000, "oldest ≈ 5 min");
    assert.equal(h.deadJobs24h, 1);
    assert.ok(h.lastHeartbeatMs !== null && h.lastHeartbeatMs < 60_000);
    assert.equal(h.cron, null, "scheduled jobs are admin-only");
    assert.equal(h.db, null, "database connections are admin-only");
    const ha = await loadSystemHealth(WS, adm);
    assert.ok(Array.isArray(ha.cron), "admins see the scheduled jobs' last runs");
    assert.ok(ha.db && ha.db.connections >= 1 && ha.db.max > 0, "and the database connections");
  });

  it("Stop a run: only its starter or an admin; the sub-agent tree stops with it; audited", async () => {
    await assert.rejects(stopProcess(WS, ben, `run:${ids.lead}`), /Only the person who started it or an admin/);
    const res = await stopProcess(WS, ana, `run:${ids.lead}`);
    assert.deepEqual(new Set(res.stopped), new Set([`run:${ids.lead}`, `run:${ids.child}`]));
    const runs = await scoped(WS, (tx) => tx.agentRun.findMany({ where: { workspaceId: WS, id: { in: [ids.lead, ids.child] } }, select: { cancelRequestedAt: true, cancelRequestedBy: true } }));
    assert.ok(runs.every((r) => r.cancelRequestedAt && r.cancelRequestedBy === ANA), "requestAgentRunCancel on both");
    await assert.rejects(stopProcess(WS, ana, `run:${ids.lead}`), /already finished/i, "a second Stop: it is already stopping");
    const rows = await loadProcesses(WS, ana);
    assert.equal(rows.find((r) => r.key === `run:${ids.lead}`)!.state, "stopping");
    // A queued run never started: cancelled outright (requestAgentRunCancel).
    await stopProcess(WS, adm, `run:${ids.queuedRun}`);
    const q = await scoped(WS, (tx) => tx.agentRun.findFirst({ where: { workspaceId: WS, id: ids.queuedRun }, select: { status: true } }));
    assert.equal(q?.status, "cancelled");
    const audits = await prisma.fileChangeLog.findMany({ where: { workspaceId: WS, action: "process_stopped" } });
    assert.equal(audits.length, 2);
    assert.ok(audits.some((a) => a.approvedBy === ANA && a.summary.includes(ids.lead)));
  });

  it("Stop a job: queued → cancelled; running without a run → refused; on a run → the run stops", async () => {
    await assert.rejects(stopProcess(WS, ana, `job:${ids.jobQueued}`), /Only the person who started it or an admin/, "system work: admins only");
    await stopProcess(WS, adm, `job:${ids.jobQueued}`);
    const j = await scoped(WS, (tx) => tx.agentJob.findFirst({ where: { workspaceId: WS, id: ids.jobQueued }, select: { status: true } }));
    assert.equal(j?.status, "cancelled");
    await assert.rejects(stopProcess(WS, adm, `job:${ids.jobRunning}`), /finishes on its own/);
    // Ben started the playbook run behind this job: he may stop it.
    const res = await stopProcess(WS, ben, `job:${ids.jobOnRun}`);
    assert.ok(res.stopped.includes(`run:${ids.jobRunOwner}`) && res.stopped.includes(`job:${ids.jobOnRun}`));
    const after = await scoped(WS, (tx) => tx.agentJob.findFirst({ where: { workspaceId: WS, id: ids.jobOnRun }, select: { status: true } }));
    assert.equal(after?.status, "cancelled", "the run's queued job is cancelled");
  });

  it("Stop a terminal session (admin) ends it; another workspace's process is not found; bad keys refused", async () => {
    await assert.rejects(stopProcess(WS, ana, `terminal:${ids.terminal}`), /Only the person who started it or an admin/);
    await stopProcess(WS, adm, `terminal:${ids.terminal}`);
    const t = await scoped(WS, (tx) => tx.terminalSession.findFirst({ where: { workspaceId: WS, id: ids.terminal } }));
    assert.equal(t?.status, "ended");
    assert.match(t?.endedReason ?? "", /Activity Monitor/);
    const ended = await prisma.fileChangeLog.findMany({ where: { workspaceId: WS, action: "terminal_session_ended" } });
    assert.equal(ended.length, 1, "the terminal's own end is audited too");
    await assert.rejects(stopProcess(WS, adm, `run:${ids.otherRun}`), /not found/i);
    await assert.rejects(stopProcess(WS, adm, "nonsense"), /Unknown process/);
    await assert.rejects(stopProcess(WS, adm, `batch:${ids.lead}`), /can't be stopped from here/);
    const other = await scoped(OTHER, (tx) => tx.agentRun.findFirst({ where: { workspaceId: OTHER, id: ids.otherRun }, select: { cancelRequestedAt: true } }));
    assert.equal(other?.cancelRequestedAt, null, "another workspace's run untouched");
  });

  it("list_processes: Tier 0, read-only, this workspace only", async () => {
    const tool = getTool("list_processes");
    assert.ok(tool, "registered in TOOLS");
    assert.equal(tool!.kind, "safe");
    assert.equal(toolGroup("list_processes"), "workspace");
    const out = await list_processes.execute({ projectId: "none", workspaceId: WS, userId: BEN, role: "editor", confirmed: false }, { live_only: false });
    assert.match(out.summary, /Queue: \d+ waiting/);
    assert.ok(out.summary.includes(`terminal:${ids.terminal}`));
    assert.ok(!out.summary.includes(ids.otherRun));
  });
});
