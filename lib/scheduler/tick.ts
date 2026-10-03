// Marketr — scheduler tick: cron due-firing + missed-cron catch-up.
// (Threat model T6: after a restart, a missed cron fires ONCE and is marked
// missed; the schedule jumps to the next future slot — never a replay of
// every missed window, never a stampede.)

import type { PrismaClient, ScheduledSkill } from "@prisma/client";
import { parseCron, nextFutureRunAfter, CronParseError } from "./cron";
import { CATCH_UP_GRACE_MS } from "./guard";
import { fireSchedule, type FireOptions } from "./service";
import { schedulerAudit } from "./audit";

export interface TickResult {
  claimed: number;
  fired: number;
  missed: number;
  awaitingApproval: number;
  blocked: { scheduleId: string; reason: string }[];
}

/**
 * Run one scheduler tick at `now`.
 *
 * Claims every active cron schedule with nextRunAt <= now: advances nextRunAt
 * to the next future slot in the same write that claims it (concurrent ticks
 * can't double-fire), marks the run missed when it fell behind the grace
 * window, then fires through the guarded fireSchedule path.
 *
 * When `workspaceId` is set (session-triggered tick), only that workspace is
 * swept; the CRON_SECRET service tick omits it and sweeps all workspaces.
 */
export async function runSchedulerTick(
  db: PrismaClient,
  now: Date,
  opts: {
    workspaceId?: string;
    workspaceConcurrency?: number;
    /** Test seam: the fire path (defaults to the guarded fireSchedule). */
    fire?: typeof fireSchedule;
  } = {},
): Promise<TickResult> {
  const result: TickResult = { claimed: 0, fired: 0, missed: 0, awaitingApproval: 0, blocked: [] };

  const due = await db.scheduledSkill.findMany({
    where: {
      status: "active",
      triggerType: "cron",
      nextRunAt: { lte: now },
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    },
  });

  for (const schedule of due) {
    if (!schedule.cronExpr) continue;
    // One bad schedule must never halt the sweep for every other workspace:
    // any failure is contained, the schedule is parked, and it is audited.
    try {
      await tickOne(db, schedule, now, opts, result);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "schedule tick failed";
      result.blocked.push({ scheduleId: schedule.id, reason });
      await parkSchedule(db, schedule, now, err).catch(() => {
        // Parking is best-effort; the next tick retries the row.
      });
    }
  }

  return result;
}

async function tickOne(
  db: PrismaClient,
  schedule: ScheduledSkill,
  now: Date,
  opts: { workspaceConcurrency?: number; fire?: typeof fireSchedule },
  result: TickResult,
): Promise<void> {
  // Corrupt or never-firing expression in DB (creation validates) → throws
  // CronParseError → parked (paused) + audited by the caller.
  const parsed = parseCron(schedule.cronExpr ?? "");

  const previousNext = schedule.nextRunAt ?? now;
  const wasMissed = previousNext.getTime() < now.getTime() - CATCH_UP_GRACE_MS;
  // Advance to the next FUTURE slot from the last scheduled time (catch-up
  // policy: fire once, mark missed, jump forward).
  const advanced = nextFutureRunAfter(parsed, previousNext, now);

  // Atomic claim: a concurrent tick that already advanced this row has
  // changed nextRunAt (or paused it), so count === 0 here means "lost the
  // race" and we must NOT fire — this is what prevents double-firing.
  const claimed = await db.scheduledSkill.updateMany({
    where: {
      id: schedule.id,
      status: "active",
      triggerType: "cron",
      nextRunAt: previousNext,
    },
    data: { nextRunAt: advanced },
  });
  if (claimed.count !== 1) return;
  result.claimed++;

  if (wasMissed) {
    result.missed++;
    await schedulerAudit(db, {
      projectId: schedule.projectId,
      workspaceId: schedule.workspaceId,
      action: "scheduler_run_missed",
      summary: `Missed cron window for schedule ${schedule.id.slice(0, 8)} — firing once and marked missed`,
      actorUserId: null,
    });
  }

  const fireOpts: FireOptions = {
    trigger: "cron",
    lineage: [],
    wasMissed,
    now,
    workspaceConcurrency: opts.workspaceConcurrency,
  };
  const fired = await (opts.fire ?? fireSchedule)(db, schedule, fireOpts);
  if (fired.fired) {
    result.fired++;
    if (fired.awaitingApproval) result.awaitingApproval++;
  } else {
    result.blocked.push({ scheduleId: schedule.id, reason: fired.blockedReason ?? "blocked" });
  }
}

/**
 * Contain a failed schedule. A bad expression (CronParseError — it will fail
 * the same way every tick) pauses the schedule so an owner must fix it; any
 * other failure only pushes nextRunAt an hour out when the row wasn't already
 * claimed/advanced, so a transient error can't spin every tick. Both audited.
 */
async function parkSchedule(db: PrismaClient, schedule: ScheduledSkill, now: Date, err: unknown): Promise<void> {
  const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  const previousNext = schedule.nextRunAt ?? now;
  if (err instanceof CronParseError) {
    await db.scheduledSkill.updateMany({
      where: { id: schedule.id, status: "active" },
      data: { status: "paused" },
    });
    await schedulerAudit(db, {
      projectId: schedule.projectId,
      workspaceId: schedule.workspaceId,
      action: "schedule_paused",
      summary: `Schedule ${schedule.id.slice(0, 8)} parked by the scheduler (cron "${schedule.cronExpr ?? ""}"): ${reason}`,
      actorUserId: null,
    });
    return;
  }
  await db.scheduledSkill.updateMany({
    where: { id: schedule.id, status: "active", nextRunAt: previousNext },
    data: { nextRunAt: new Date(now.getTime() + 3_600_000) },
  });
  await schedulerAudit(db, {
    projectId: schedule.projectId,
    workspaceId: schedule.workspaceId,
    action: "scheduler_run_failed",
    summary: `Schedule ${schedule.id.slice(0, 8)} failed during the scheduler tick: ${reason}`,
    actorUserId: null,
  });
}
