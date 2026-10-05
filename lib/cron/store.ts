// ShapesOS — Postgres side of the in-app cron runner (Phase 6 runtime).
//
// claimDue runs inside one short transaction guarded by
// pg_try_advisory_xact_lock: exactly one replica per tick reads the latest
// run per job, decides what is due (planTick) and inserts the "running"
// claim rows; COMMIT releases the lock. See lib/cron/runner.ts for why this
// is a per-tick transaction lock and not a leader's session lock.
//
// cron_runs is host-wide (no workspace_id, no RLS). Rows older than
// CRON_RUN_RETENTION_DAYS are pruned by the lock holder at most once an hour.

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { CRON_JOBS, type CronJob } from "./jobs";
import { planTick, slotFor, type ClaimArgs, type ClaimedRun, type CronRunStatus, type CronStore, type LastRun, type RunResult } from "./runner";

/**
 * Advisory lock id, two-int form (namespace, id). 0x5348 is "SH"; nothing
 * else in the app takes advisory locks (grep pg_.*advisory before adding one).
 */
export const CRON_LOCK_NAMESPACE = 0x5348;
export const CRON_LOCK_ID = 1;

export const CRON_RUN_RETENTION_DAYS = 7;
const PRUNE_EVERY_MS = 60 * 60_000;

interface LatestRow {
  id: string;
  job: string;
  scheduled_for: Date;
  started_at: Date;
  status: CronRunStatus;
}

export function prismaCronStore(db: PrismaClient = defaultPrisma): CronStore {
  let lastPruneAt = 0;
  return {
    async claimDue(args: ClaimArgs): Promise<ClaimedRun[] | null> {
      const { jobs, now, baseline, localRunning } = args;
      return db.$transaction(
        async (tx) => {
          const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${CRON_LOCK_NAMESPACE}::int, ${CRON_LOCK_ID}::int) AS locked`;
          if (!lock?.locked) return null;

          const keys = jobs.map((j) => j.key);
          const rows = keys.length
            ? await tx.$queryRaw<LatestRow[]>`
                SELECT r.id, r.job, r.scheduled_for, r.started_at, r.status::text AS status
                  FROM unnest(${keys}::text[]) AS k(job)
                  CROSS JOIN LATERAL (
                    SELECT c.id, c.job, c.scheduled_for, c.started_at, c.status
                      FROM cron_runs c
                     WHERE c.job = k.job
                     ORDER BY c.started_at DESC
                     LIMIT 1
                  ) r`
            : [];
          const latest = new Map<string, LastRun>(
            rows.map((r) => [r.job, { runId: r.id, scheduledFor: r.scheduled_for, startedAt: r.started_at, status: r.status }]),
          );
          const plan = planTick(jobs, latest, now, baseline, localRunning);

          if (plan.stale.length) {
            await tx.cronRun.updateMany({
              where: { id: { in: plan.stale }, status: "running" },
              data: { status: "timeout", finishedAt: now, error: "No result recorded: the runner that claimed this run stopped" },
            });
          }

          const claimed: ClaimedRun[] = [];
          const scheduledFor = slotFor(now);
          for (const job of plan.due) {
            const row = await tx.cronRun.create({
              data: { job: job.key, scheduledFor, startedAt: now, status: "running" },
              select: { id: true },
            });
            claimed.push({ runId: row.id, job, scheduledFor });
          }

          if (now.getTime() - lastPruneAt >= PRUNE_EVERY_MS) {
            lastPruneAt = now.getTime();
            await tx.cronRun.deleteMany({
              where: {
                startedAt: { lt: new Date(now.getTime() - CRON_RUN_RETENTION_DAYS * 86_400_000) },
                status: { not: "running" },
              },
            });
          }
          return claimed;
        },
        { maxWait: 5_000, timeout: 15_000 },
      );
    },

    async finish(runId: string, result: RunResult, finishedAt: Date): Promise<void> {
      await db.cronRun.updateMany({
        where: { id: runId },
        data: {
          status: result.status,
          httpStatus: result.httpStatus,
          durationMs: result.durationMs,
          error: result.error,
          finishedAt,
        },
      });
    },
  };
}

export interface JobStatusView {
  key: string;
  path: string;
  cron: string;
  source: CronJob["source"];
  last: {
    status: CronRunStatus;
    startedAt: string;
    finishedAt: string | null;
    httpStatus: number | null;
    durationMs: number | null;
    error: string | null;
  } | null;
}

/** Last run per job, for the platform-operator view (Settings → Providers). */
export async function lastRunPerJob(db: PrismaClient = defaultPrisma): Promise<JobStatusView[]> {
  const keys = CRON_JOBS.map((j) => j.key);
  const rows = await db.$queryRaw<
    { job: string; status: CronRunStatus; started_at: Date; finished_at: Date | null; http_status: number | null; duration_ms: number | null; error: string | null }[]
  >`
    SELECT r.job, r.status::text AS status, r.started_at, r.finished_at, r.http_status, r.duration_ms, r.error
      FROM unnest(${keys}::text[]) AS k(job)
      CROSS JOIN LATERAL (
        SELECT * FROM cron_runs c WHERE c.job = k.job ORDER BY c.started_at DESC LIMIT 1
      ) r`;
  const byJob = new Map(rows.map((r) => [r.job, r]));
  return CRON_JOBS.map((j) => {
    const r = byJob.get(j.key);
    return {
      key: j.key,
      path: j.path,
      cron: j.cron,
      source: j.source,
      last: r
        ? {
            status: r.status,
            startedAt: r.started_at.toISOString(),
            finishedAt: r.finished_at?.toISOString() ?? null,
            httpStatus: r.http_status,
            durationMs: r.duration_ms,
            error: r.error,
          }
        : null,
    };
  });
}
