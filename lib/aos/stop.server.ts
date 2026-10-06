// ShapesOS — Phase 18.2 (WS=content): Stop from the Activity Monitor.
//
// Every Stop goes through the EXISTING stop path of its kind — nothing new
// is invented here:
//   run      a chat run: lib/chat/agent.ts stopThreadRuns (drops the thread's
//            pending proposals too); any other run: requestAgentRunCancel +
//            abortRun (lib/agents/runs) — the sub-agent tree stops with it
//            and its sandbox is destroyed
//   job      on a run: that run's Stop; queued without a run: cancelled
//            (never claimed); running without a run: not stoppable (it
//            finishes or its lease expires) — the monitor says so
//   sandbox  releaseRunSandbox(force) (lib/sandbox)
//   terminal the person's terminal session ends (lib/terminal/service.ts)
// Who: the person who started it, or an admin/owner (canStopProcess) —
// checked here against the database row, never trusted from the client.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { ForbiddenError, NotFoundError, ConflictError, BadRequestError } from "@/lib/api/errors";
import { auditEvent } from "@/lib/auditlog";
import { canStopProcess } from "./processes";
import type { ProcessViewer } from "./activity.server";

export interface StopResult {
  stopped: string[];
}

function deny(reason: "finished" | "not_yours" | "not_stoppable"): never {
  if (reason === "finished") throw new ConflictError("It already finished.");
  if (reason === "not_stoppable") throw new ConflictError("This can't be stopped from here; it finishes on its own.");
  throw new ForbiddenError("Only the person who started it or an admin can stop it.");
}

async function stopRun(workspaceId: string, viewer: ProcessViewer, runId: string): Promise<string[]> {
  const run = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRun.findFirst({ where: { id: runId, workspaceId }, select: { id: true, status: true, startedBy: true, threadId: true, cancelRequestedAt: true } }),
  );
  if (!run) throw new NotFoundError("Run not found.");
  const live = ["queued", "running", "awaiting_confirmation"].includes(run.status) && !run.cancelRequestedAt;
  const verdict = canStopProcess({ live, stoppable: true, startedBy: run.startedBy, viewerId: viewer.userId, viewerIsAdmin: viewer.isAdmin });
  if (!verdict.allowed) deny(verdict.reason);
  if (run.threadId) {
    const { stopThreadRuns } = await import("@/lib/chat/agent");
    return stopThreadRuns({ workspaceId, threadId: run.threadId, userId: viewer.userId, runId: run.id });
  }
  const { requestAgentRunCancel } = await import("@/lib/agents/runs/service");
  const { abortRun } = await import("@/lib/agents/runs/abort");
  const res = await requestAgentRunCancel(workspaceId, run.id, viewer.userId);
  const ids = res?.runIds ?? [];
  for (const id of ids) abortRun(id);
  return ids;
}

/** Stop one process by its Activity Monitor key ("run:<id>", "job:<id>", …). */
export async function stopProcess(workspaceId: string, viewer: ProcessViewer, key: string): Promise<StopResult> {
  const m = /^(run|job|batch|sandbox|terminal|cron):([A-Za-z0-9_-]{1,64})$/.exec(key ?? "");
  if (!m) throw new BadRequestError("Unknown process.");
  const [, type, id] = m as unknown as [string, string, string];
  let stopped: string[] = [];
  if (type === "run") {
    stopped = (await stopRun(workspaceId, viewer, id)).map((r) => `run:${r}`);
  } else if (type === "job") {
    const job = await withWorkspaceScope(workspaceId, (tx) => tx.agentJob.findFirst({ where: { id, workspaceId }, select: { id: true, status: true, runId: true } }));
    if (!job) throw new NotFoundError("Job not found.");
    if (job.runId) {
      stopped = (await stopRun(workspaceId, viewer, job.runId)).map((r) => `run:${r}`);
      const { cancelAgentJobsForRun } = await import("@/lib/agents/queue/store");
      await cancelAgentJobsForRun(workspaceId, job.runId);
      stopped.push(`job:${job.id}`);
    } else {
      const live = job.status === "queued" || job.status === "running";
      const verdict = canStopProcess({ live, stoppable: job.status === "queued", startedBy: null, viewerId: viewer.userId, viewerIsAdmin: viewer.isAdmin });
      if (!verdict.allowed) deny(verdict.reason);
      const res = await withWorkspaceScope(workspaceId, (tx) =>
        tx.agentJob.updateMany({ where: { id: job.id, workspaceId, status: "queued" }, data: { status: "cancelled", finishedAt: new Date() } }),
      );
      if (res.count === 0) deny("finished");
      stopped = [`job:${job.id}`];
    }
  } else if (type === "sandbox") {
    const row = await withWorkspaceScope(workspaceId, (tx) =>
      tx.agentRunSandbox.findFirst({ where: { id, workspaceId }, select: { id: true, runId: true, status: true, run: { select: { startedBy: true } } } }),
    );
    if (!row) throw new NotFoundError("Sandbox not found.");
    const verdict = canStopProcess({ live: row.status === "active", stoppable: true, startedBy: row.run.startedBy, viewerId: viewer.userId, viewerIsAdmin: viewer.isAdmin });
    if (!verdict.allowed) deny(verdict.reason);
    const { releaseRunSandbox } = await import("@/lib/sandbox");
    await releaseRunSandbox(workspaceId, row.runId, "stopped from the Activity Monitor", { force: true });
    stopped = [`sandbox:${row.id}`];
  } else if (type === "terminal") {
    const { endTerminalSession, getTerminalSession } = await import("@/lib/terminal/service");
    const s = await getTerminalSession(workspaceId, id);
    if (!s) throw new NotFoundError("Terminal session not found.");
    const verdict = canStopProcess({ live: s.status === "active", stoppable: true, startedBy: s.userId, viewerId: viewer.userId, viewerIsAdmin: viewer.isAdmin });
    if (!verdict.allowed) deny(verdict.reason);
    await endTerminalSession(workspaceId, id, viewer.userId, "stopped from the Activity Monitor");
    stopped = [`terminal:${id}`];
  } else {
    deny("not_stoppable");
  }
  await auditEvent({
    workspaceId,
    projectId: null,
    action: "process_stopped",
    summary: `Activity Monitor: stopped ${stopped.join(", ") || key}`,
    actorUserId: viewer.userId,
  }).catch(() => undefined);
  return { stopped };
}
