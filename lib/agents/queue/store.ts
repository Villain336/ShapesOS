// ShapesOS — Phase 8: the agent job queue (agent_jobs).
//
// Durable background work for the agent runtime: a chat turn handed off by
// its request, a mission launch. Rows are workspace-scoped and FORCE RLS
// (migration 20261009100000_p8_runtime_agent_jobs), so every write runs under
// the job's own tenant GUC (withWorkspaceScope).
//
// Claiming reuses the shared SKIP LOCKED helper (lib/jobs/claim.ts, the
// clip-job pattern): one UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP
// LOCKED) per workspace, so two workers never claim the same row. A claim
// takes a lease (lease_until); the worker extends it on a heartbeat. A row
// still `running` after its lease passed belongs to a worker that died: it is
// claimable again, until max_attempts claims — then the reaper marks it
// `dead` and fails its run.
//
// Finding work across workspaces: a worker sets app.agent_worker='discover'
// for ONE read-only query (the SELECT-only discovery policy) that lists the
// workspaces with due rows; everything after that is tenant-scoped.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { claimRows, SQL_NOW_UTC } from "@/lib/jobs/claim";
import { agentWorkerConfig } from "./config";

// Phase 16 (deleg): subagent_run (one delegated child), delegation_tick (start
// held-back tasks / arm a plan), delegation_join (the parent's continuation).
// Phase 17 (latency): llm_usage (one model call's metering, written by the
// call as an outbox row — lib/llm/usage.ts).
export type AgentJobKind = "chat_turn" | "mission" | "subagent_run" | "delegation_tick" | "delegation_join" | "llm_usage" | (string & {});

export interface EnqueueAgentJobInput {
  workspaceId: string;
  kind: AgentJobKind;
  payload: unknown;
  runId?: string | null;
  maxAttempts?: number;
  /** Not claimable before this. */
  runAfter?: Date;
}

export interface ClaimedAgentJob {
  id: string;
  workspaceId: string;
  kind: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  runId: string | null;
}

export async function enqueueAgentJob(input: EnqueueAgentJobInput): Promise<{ id: string }> {
  return withWorkspaceScope(input.workspaceId, (tx) =>
    tx.agentJob.create({
      data: {
        workspaceId: input.workspaceId,
        kind: input.kind,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        runId: input.runId ?? null,
        maxAttempts: input.maxAttempts ?? agentWorkerConfig().maxAttempts,
        ...(input.runAfter ? { runAfter: input.runAfter } : {}),
      },
      select: { id: true },
    }),
  );
}

const ms = (n: number) => Prisma.sql`(${Math.max(0, Math.round(n))}::int * interval '1 millisecond')`;

/** Due = queued and runnable now, or running with an expired lease (orphaned). */
const DUE = Prisma.sql`(("status" = 'queued' AND "run_after" <= ${SQL_NOW_UTC})
  OR ("status" = 'running' AND "lease_until" < ${SQL_NOW_UTC}))`;

/** Phase 16 (deleg): restrict to some job kinds (null = every kind). */
const kindFilter = (kinds?: readonly string[] | null) =>
  kinds && kinds.length ? Prisma.sql` AND "kind" IN (${Prisma.join([...kinds])})` : Prisma.empty;

/** Workspaces that have due jobs (one read-only discovery query). */
export async function discoverDueWorkspaces(limit = 50, kinds?: readonly string[] | null): Promise<string[]> {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.agent_worker = 'discover'`);
    return tx.$queryRaw<Array<{ workspace_id: string }>>`
      SELECT DISTINCT "workspace_id" FROM "agent_jobs" WHERE ${DUE}${kindFilter(kinds)} LIMIT ${Math.max(1, limit)}`;
  });
  return rows.map((r) => r.workspace_id);
}

/**
 * Claim up to `limit` due jobs of one workspace (SKIP LOCKED: concurrent
 * workers never get the same row). An orphaned row is claimable only while
 * it has attempts left; the reaper dead-letters the rest.
 */
export async function claimAgentJobs(
  workspaceId: string,
  workerId: string,
  leaseMs: number,
  limit = 1,
  kinds?: readonly string[] | null,
): Promise<ClaimedAgentJob[]> {
  return claimRows<ClaimedAgentJob>({
    workspaceId,
    table: "agent_jobs",
    where: Prisma.sql`(("status" = 'queued' AND "run_after" <= ${SQL_NOW_UTC})
      OR ("status" = 'running' AND "lease_until" < ${SQL_NOW_UTC} AND "attempts" < "max_attempts"))${kindFilter(kinds)}`,
    orderBy: Prisma.sql`"run_after" ASC, "created_at" ASC`,
    set: Prisma.sql`"status" = 'running', "attempts" = "attempts" + 1, "locked_by" = ${workerId},
      "heartbeat_at" = ${SQL_NOW_UTC}, "lease_until" = ${SQL_NOW_UTC} + ${ms(leaseMs)}, "updated_at" = ${SQL_NOW_UTC}`,
    returning: Prisma.sql`"id", "workspace_id" AS "workspaceId", "kind", "payload", "attempts",
      "max_attempts" AS "maxAttempts", "run_id" AS "runId"`,
    limit,
  });
}

/**
 * Phase 17: claim ONE specific queued job (the usage outbox row the writer
 * processes at once). Atomic like claimAgentJobs — a worker that claimed it
 * first wins and this returns null.
 */
export async function claimAgentJobById(workspaceId: string, jobId: string, workerId: string, leaseMs: number): Promise<ClaimedAgentJob | null> {
  const rows = await claimRows<ClaimedAgentJob>({
    workspaceId,
    table: "agent_jobs",
    where: Prisma.sql`"id" = ${jobId} AND "status" = 'queued' AND "run_after" <= ${SQL_NOW_UTC}`,
    orderBy: Prisma.sql`"created_at" ASC`,
    set: Prisma.sql`"status" = 'running', "attempts" = "attempts" + 1, "locked_by" = ${workerId},
      "heartbeat_at" = ${SQL_NOW_UTC}, "lease_until" = ${SQL_NOW_UTC} + ${ms(leaseMs)}, "updated_at" = ${SQL_NOW_UTC}`,
    returning: Prisma.sql`"id", "workspace_id" AS "workspaceId", "kind", "payload", "attempts",
      "max_attempts" AS "maxAttempts", "run_id" AS "runId"`,
    limit: 1,
  });
  return rows[0] ?? null;
}

/** Extend the lease. False = this worker no longer owns the job (stop working on it). */
export async function heartbeatAgentJob(workspaceId: string, jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
  const n = await withWorkspaceScope(workspaceId, (tx) =>
    tx.$executeRaw`
      UPDATE "agent_jobs"
         SET "heartbeat_at" = ${SQL_NOW_UTC}, "lease_until" = ${SQL_NOW_UTC} + ${ms(leaseMs)}, "updated_at" = ${SQL_NOW_UTC}
       WHERE "id" = ${jobId} AND "workspace_id" = ${workspaceId}
         AND "status" = 'running' AND "locked_by" = ${workerId}`,
  );
  return n > 0;
}

/** The job finished. False when this worker had lost it meanwhile. */
export async function completeAgentJob(workspaceId: string, jobId: string, workerId: string, result?: unknown): Promise<boolean> {
  const res = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentJob.updateMany({
      where: { id: jobId, workspaceId, status: "running", lockedBy: workerId },
      data: {
        status: "succeeded",
        finishedAt: new Date(),
        leaseUntil: null,
        ...(result === undefined ? {} : { result: result as Prisma.InputJsonValue }),
      },
    }),
  );
  return res.count > 0;
}

/**
 * Phase 17: drop a finished transient row this worker owns (the usage
 * outbox: once the ledger row exists the outbox row is noise — one per model
 * call would otherwise pile up). False when this worker no longer owned it.
 */
export async function deleteOwnedAgentJob(workspaceId: string, jobId: string, workerId: string): Promise<boolean> {
  const res = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentJob.deleteMany({ where: { id: jobId, workspaceId, status: "running", lockedBy: workerId } }),
  );
  return res.count > 0;
}

/**
 * The handler threw: retry later while attempts remain (exponential backoff),
 * else dead-letter. Returns the new status (null when this worker had lost it).
 */
export async function failAgentJob(
  workspaceId: string,
  jobId: string,
  workerId: string,
  error: string,
  opts: { retryable?: boolean; backoffMs?: number } = {},
): Promise<"queued" | "dead" | null> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const job = await tx.agentJob.findFirst({
      where: { id: jobId, workspaceId, status: "running", lockedBy: workerId },
      select: { attempts: true, maxAttempts: true },
    });
    if (!job) return null;
    const retry = opts.retryable !== false && job.attempts < job.maxAttempts;
    const backoff = opts.backoffMs ?? Math.min(5 * 60_000, 2_000 * 2 ** Math.max(0, job.attempts - 1));
    await tx.agentJob.update({
      where: { id: jobId, workspaceId },
      data: retry
        ? { status: "queued", lastError: error.slice(0, 2000), lockedBy: null, leaseUntil: null, runAfter: new Date(Date.now() + backoff) }
        : { status: "dead", lastError: error.slice(0, 2000), leaseUntil: null, finishedAt: new Date() },
    });
    return retry ? "queued" : "dead";
  });
}

/**
 * Deploy PR: hand a running job back on shutdown — queued again at once, and
 * the attempt is NOT charged (the work did not fail; this process is going
 * away). The run's transcript was saved at its last step, so whichever worker
 * claims it next continues from there. False when this worker no longer
 * owned the job.
 */
export async function releaseAgentJob(workspaceId: string, jobId: string, workerId: string): Promise<boolean> {
  const n = await withWorkspaceScope(workspaceId, (tx) =>
    tx.$executeRaw`
      UPDATE "agent_jobs"
         SET "status" = 'queued', "locked_by" = NULL, "lease_until" = NULL,
             "attempts" = GREATEST("attempts" - 1, 0), "run_after" = ${SQL_NOW_UTC}, "updated_at" = ${SQL_NOW_UTC}
       WHERE "id" = ${jobId} AND "workspace_id" = ${workspaceId}
         AND "status" = 'running' AND "locked_by" = ${workerId}`,
  );
  return n > 0;
}

/**
 * Dead-letter orphaned jobs that used up their attempts (their lease expired
 * on the last allowed claim). Returns them so the caller can fail their runs.
 */
export async function reapExpiredJobs(workspaceId: string): Promise<Array<{ id: string; runId: string | null; kind: string }>> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.$queryRaw<Array<{ id: string; runId: string | null; kind: string }>>`
      UPDATE "agent_jobs"
         SET "status" = 'dead', "finished_at" = ${SQL_NOW_UTC}, "updated_at" = ${SQL_NOW_UTC}, "lease_until" = NULL,
             "last_error" = 'Lease expired on the last allowed attempt (the worker stopped heartbeating).'
       WHERE "workspace_id" = ${workspaceId} AND "status" = 'running'
         AND "lease_until" < ${SQL_NOW_UTC} AND "attempts" >= "max_attempts"
      RETURNING "id", "run_id" AS "runId", "kind"`,
  );
}

/** Cancel a run's queued / running jobs (Stop on a handed-off turn). */
export async function cancelAgentJobsForRun(workspaceId: string, runId: string): Promise<number> {
  const res = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentJob.updateMany({
      where: { workspaceId, runId, status: "queued" },
      data: { status: "cancelled", finishedAt: new Date() },
    }),
  );
  return res.count;
}

export async function getAgentJob(workspaceId: string, jobId: string) {
  return withWorkspaceScope(workspaceId, (tx) => tx.agentJob.findFirst({ where: { id: jobId, workspaceId } }));
}
