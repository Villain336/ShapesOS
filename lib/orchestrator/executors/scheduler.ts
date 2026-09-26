// Marketr — Phase 9 M2: Scheduler executor (SPEC §P9A).
//
// Mission timelines, reminders, checkpoint scheduling. NO external side
// effects: reminders are returned as PROPOSALS (data), never dispatched;
// checkpoint scheduling produces timeline entries, never fires anything.
// Tools: mission.timeline.read, checkpoint.schedule, reminder.propose.

import { withWorkspaceScope } from "../../substrate/graph/rls";
import type { MissionPlan } from "./planner";
import {
  assertToolAllowed,
  checkKillSwitchesFirst,
  estimateCostCents,
  type GuardDeps,
} from "./_guard";

export const SCHEDULER_TOOLS = Object.freeze([
  "mission.timeline.read",
  "checkpoint.schedule",
  "reminder.propose",
]) as readonly string[];

export interface TimelineEvent {
  step: string | null;
  actor: string;
  tool: string | null;
  ts: Date;
}

export interface ScheduledCheckpoint {
  checkpointId: string;
  afterStep: string;
  kind: string;
  condition: string;
  /** ISO timestamp — proposed, not armed. Arming is M4. */
  scheduledAt: string;
}

export interface ReminderProposal {
  id: string;
  forCheckpoint: string;
  message: string;
  /** ISO timestamp — proposed, not sent. Sending is out of scope. */
  proposedAt: string;
}

export interface SchedulerInput {
  workspaceId: string;
  missionId?: string | null;
  plan: MissionPlan;
  /** ISO start; defaults to now. */
  startAt?: string;
  /** Days between checkpoints when the plan gives no timing. */
  checkpointSpacingDays?: number;
}

export interface SchedulerDeps extends GuardDeps {
  readTimeline?: (
    workspaceId: string,
    missionId: string,
  ) => Promise<TimelineEvent[]>;
}

export interface SchedulerResult {
  executor: "scheduler";
  checkpoints: ScheduledCheckpoint[];
  reminders: ReminderProposal[];
  summary: string;
  costCents: number;
}

async function defaultReadTimeline(
  workspaceId: string,
  missionId: string,
): Promise<TimelineEvent[]> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.missionEvent.findMany({
      where: { missionId, workspaceId },
      orderBy: { ts: "asc" },
      take: 200,
      select: { step: true, actor: true, tool: true, ts: true },
    }),
  );
}

export async function runScheduler(
  input: SchedulerInput,
  deps: SchedulerDeps = {},
): Promise<SchedulerResult> {
  await checkKillSwitchesFirst(input, deps);
  assertToolAllowed("scheduler", SCHEDULER_TOOLS, "mission.timeline.read");

  const startAt = input.startAt ? new Date(input.startAt) : new Date();
  if (Number.isNaN(startAt.getTime())) throw new Error("scheduler: startAt is not a valid date.");
  const spacingDays = input.checkpointSpacingDays ?? 3;

  // Read-only timeline context (mission.timeline.read).
  let timeline: TimelineEvent[] = [];
  if (input.missionId) {
    const readTimeline = deps.readTimeline ?? defaultReadTimeline;
    timeline = await readTimeline(input.workspaceId, input.missionId);
  }

  // Schedule checkpoints as data — proposed, never armed or fired.
  assertToolAllowed("scheduler", SCHEDULER_TOOLS, "checkpoint.schedule");
  const checkpoints: ScheduledCheckpoint[] = input.plan.checkpoints.map((c, i) => {
    const at = new Date(startAt.getTime() + (i + 1) * spacingDays * 86_400_000);
    return {
      checkpointId: c.id,
      afterStep: c.afterStep,
      kind: c.kind,
      condition: c.condition,
      scheduledAt: at.toISOString(),
    };
  });

  // Reminders as proposals — described, never sent.
  assertToolAllowed("scheduler", SCHEDULER_TOOLS, "reminder.propose");
  const reminders: ReminderProposal[] = checkpoints.map((c) => ({
    id: `rem_${c.checkpointId}`,
    forCheckpoint: c.checkpointId,
    message: `Reminder (proposed, not sent): checkpoint "${c.checkpointId}" (${c.kind}) is scheduled for ${c.scheduledAt}.`,
    proposedAt: new Date(
      new Date(c.scheduledAt).getTime() - 86_400_000,
    ).toISOString(),
  }));
  const summary =
    `Scheduled ${checkpoints.length} checkpoint(s) and proposed ${reminders.length} reminder(s) ` +
    `for plan "${input.plan.goal.slice(0, 80)}" starting ${startAt.toISOString()}. ` +
    `Timeline has ${timeline.length} event(s). All entries are proposals — nothing was armed, sent, or fired.`;

  return {
    executor: "scheduler",
    checkpoints,
    reminders,
    summary,
    costCents: estimateCostCents(JSON.stringify(input.plan).length, summary.length),
  };
}
