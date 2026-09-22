// Marketr — scheduler tick: cron due-firing + missed-cron catch-up.
// (Threat model T6: after a restart, a missed cron fires ONCE and is marked
// missed; the schedule jumps to the next future slot — never a replay of
// every missed window, never a stampede.)

import type { PrismaClient } from "@prisma/client";
import { parseCron, nextRunAfter, nextFutureRunAfter, CronParseError } from "./cron";
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
  opts: { workspaceId?: string; workspaceConcurrency?: number } = {},
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
    let parsed;
    try {
      parsed = parseCron(schedule.cronExpr);
    } catch (err) {
      // Corrupt expression in DB (shouldn't happen — creation validates):
      // park it in the future and audit instead of firing.
      const parked = nextRunAfterSafe(schedule.cronExpr, now);
      await db.scheduledSkill.update({
        where: { id: schedule.id },
        data: { nextRunAt: parked ?? new Date(now.getTime() + 3_600_000) },
      });
      result.blocked.push({ scheduleId: schedule.id, reason: err instanceof Error ? err.message : "bad cron" });
      continue;
    }

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
    if (claimed.count !== 1) continue;
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
    const fired = await fireSchedule(db, schedule, fireOpts);
    if (fired.fired) {
      result.fired++;
      if (fired.awaitingApproval) result.awaitingApproval++;
    } else {
      result.blocked.push({ scheduleId: schedule.id, reason: fired.blockedReason ?? "blocked" });
    }
  }

  return result;
}

function nextRunAfterSafe(expr: string, now: Date): Date | null {
  try {
    return nextRunAfter(parseCron(expr), now);
  } catch {
    return null;
  }
}
