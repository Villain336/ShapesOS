// ShapesOS — live signals for the status page (beta readiness, WS=legal).
//
// Reuses what the app already measures: the readiness report behind
// GET /api/health (lib/observability/health.ts) and the agent queue. The
// queue numbers are SYSTEM-WIDE: agent_jobs is FORCE RLS per workspace, so
// the read runs under the worker-discovery policy (app.agent_worker =
// 'discover', SELECT only — the same one discoverDueWorkspaces uses). Counts
// and timestamps only; no job payloads, no workspace ids leave this module.

import { prisma } from "@/lib/prisma";
import { readiness } from "@/lib/observability/health";
import { agentWorkerMode } from "@/lib/agents/queue/config";
import type { LiveSignals, QueueSignal, WorkerSignal } from "./derive";

interface QueueRow {
  depth: number;
  oldest: Date | null;
  dead: number;
  running: number;
  beat: Date | null;
}

export async function queueAndWorkerSignals(now = new Date()): Promise<{ queue: QueueSignal; worker: WorkerSignal }> {
  const [row] = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.agent_worker = 'discover'`);
    return tx.$queryRaw<QueueRow[]>`
      SELECT
        count(*) FILTER (WHERE "status" = 'queued' AND "run_after" <= ${now})::int AS depth,
        min("run_after") FILTER (WHERE "status" = 'queued' AND "run_after" <= ${now}) AS oldest,
        count(*) FILTER (WHERE "status" = 'dead' AND "updated_at" >= ${new Date(now.getTime() - 24 * 60 * 60 * 1000)})::int AS dead,
        count(*) FILTER (WHERE "status" = 'running')::int AS running,
        max("heartbeat_at") FILTER (WHERE "status" = 'running') AS beat
      FROM "agent_jobs"`;
  });
  const r = row ?? { depth: 0, oldest: null, dead: 0, running: 0, beat: null };
  return {
    queue: {
      depth: r.depth,
      oldestQueuedMs: r.oldest ? Math.max(0, now.getTime() - r.oldest.getTime()) : null,
      deadJobs24h: r.dead,
    },
    worker: {
      mode: agentWorkerMode(),
      runningJobs: r.running,
      lastHeartbeatMs: r.beat ? Math.max(0, now.getTime() - r.beat.getTime()) : null,
    },
  };
}

/** Every signal, each null on its own failure (the page then shows "unknown"). */
export async function collectLiveSignals(now = new Date()): Promise<LiveSignals> {
  const [ready, q] = await Promise.all([
    readiness().catch(() => null),
    queueAndWorkerSignals(now).catch(() => null),
  ]);
  return {
    readiness: ready ? { status: ready.status, ...(ready.draining ? { draining: true as const } : {}), checks: ready.checks } : null,
    worker: q?.worker ?? null,
    queue: q?.queue ?? null,
  };
}
