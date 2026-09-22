// Marketr — scheduler guardrails (Phase B, W2).
// (Threat model T1, T6, T7: runaway loops, missed-cron stampede, cap bypass.)
//
// All functions take the Prisma client (or a test fake) first, following the
// repo's service convention. Time is injected (`now`) so the battery can
// deterministically simulate downtime.

import type { PrismaClient } from "@prisma/client";

/** Default max runs per hour per schedule (decided; admin-configurable later). */
export const DEFAULT_MAX_RUNS_PER_HOUR = 12;

/** Absolute ceiling — client values are clamped, never trusted above this. */
export const MAX_RUNS_PER_HOUR_CEILING = 60;

/** A run older than this behind schedule counts as "missed" (catch-up fires once). */
export const CATCH_UP_GRACE_MS = 5 * 60_000;

/** Default parallel-subagent concurrency per workspace (decided: 4). */
export const DEFAULT_CONCURRENCY = 4;

/** Absolute ceiling for concurrencyLimit. */
export const CONCURRENCY_CEILING = 16;

const HOUR_MS = 3_600_000;

type Db = Pick<PrismaClient, "skillRun">;

export interface RunGuard {
  allowed: boolean;
  /** Machine-readable reason when blocked (audited by the caller). */
  reason?: "cycle" | "rate_limited";
  detail?: string;
}

/**
 * Cycle detection: a run whose trigger lineage already contains this schedule
 * would re-trigger itself (event → run → same event → run …). Block + audit.
 * Lineage is server-constructed; clients can never set it.
 */
export function checkCycle(lineage: string[], scheduleId: string): RunGuard {
  if (lineage.includes(scheduleId)) {
    return {
      allowed: false,
      reason: "cycle",
      detail: `schedule ${scheduleId} already appears in the trigger lineage — self-trigger blocked`,
    };
  }
  return { allowed: true };
}

/** Count runs fired by this schedule in the trailing hour. */
export async function runsInLastHour(db: Db, scheduleId: string, now: Date): Promise<number> {
  return db.skillRun.count({
    where: {
      scheduleId,
      startedAt: { gt: new Date(now.getTime() - HOUR_MS) },
    },
  });
}

/** Max-runs-per-hour per schedule. Firing beyond the cap is dropped, never queued. */
export async function checkRateLimit(
  db: Db,
  scheduleId: string,
  now: Date,
  maxPerHour = DEFAULT_MAX_RUNS_PER_HOUR,
): Promise<RunGuard> {
  const cap = Math.min(Math.max(1, Math.floor(maxPerHour)), MAX_RUNS_PER_HOUR_CEILING);
  const count = await runsInLastHour(db, scheduleId, now);
  if (count >= cap) {
    return {
      allowed: false,
      reason: "rate_limited",
      detail: `schedule ${scheduleId} already fired ${count} times in the trailing hour (cap ${cap})`,
    };
  }
  return { allowed: true };
}

/** Clamp a client-supplied concurrencyLimit to [1, 16]; non-integers rejected. */
export function clampConcurrency(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error("concurrencyLimit must be an integer");
  return Math.min(Math.max(n, 1), CONCURRENCY_CEILING);
}

/**
 * Effective fan-out cap for a run: min(schedule limit, workspace default, ceiling).
 * (Threat model T7: cap is computed server-side from DB values, not client math.)
 */
export function effectiveConcurrency(scheduleLimit: number, workspaceDefault = DEFAULT_CONCURRENCY): number {
  return Math.min(
    Math.min(Math.max(1, scheduleLimit), CONCURRENCY_CEILING),
    Math.min(Math.max(1, workspaceDefault), CONCURRENCY_CEILING),
  );
}
