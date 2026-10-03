// Marketr — scheduler service: schedule CRUD, firing, approvals, event bus.
// (Phase B, W2. Threat models T1/T3/T5/T6/T9.)
//
// All functions take the Prisma client (or a test fake) first. RBAC itself is
// enforced at the route layer (lib/authz family); this service additionally
// scopes every row access by workspaceId so a confused caller can't cross
// tenants (defense in depth, T8).

import type { PrismaClient, ScheduledSkill } from "@prisma/client";
import { parseCron, nextRunAfterInZone, CronParseError } from "./cron";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/time/zoned";
import {
  isEventSource,
  validateEventPayload,
  validateEventConfig,
  shouldFire,
  describeEvent,
  type EventSource,
} from "./events";
import {
  checkCycle,
  checkRateLimit,
  clampConcurrency,
  DEFAULT_MAX_RUNS_PER_HOUR,
  DEFAULT_CONCURRENCY,
} from "./guard";
import { executeSkillRun } from "./runner";
import { schedulerAudit } from "./audit";
import { notifyApprovalDecided, notifyApprovalNeeded } from "@/lib/notifications/producers";

export { CronParseError };

type Db = PrismaClient;

export interface CreateScheduleInput {
  workspaceId: string;
  projectId?: string | null;
  skillId: string;
  triggerType: "cron" | "event";
  cronExpr?: string | null;
  /** IANA zone the cron is read in (default UTC). Validated. */
  timezone?: string | null;
  eventSource?: string | null;
  eventConfig?: Record<string, unknown> | null;
  createdBy: string;
  approvalMode?: "supervised" | "scheduled" | "autopilot";
  concurrencyLimit?: number;
  workspaceDefaultApprovalMode?: "supervised" | "scheduled" | "autopilot";
}

export class ScheduleServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleServiceError";
  }
}

/** Validate a schedule's IANA timezone; blank/absent → UTC. */
export function normalizeScheduleTimezone(tz: unknown): string {
  if (tz == null || (typeof tz === "string" && tz.trim() === "")) return DEFAULT_TIME_ZONE;
  const trimmed = typeof tz === "string" ? tz.trim() : tz;
  if (!isValidTimeZone(trimmed)) {
    throw new ScheduleServiceError(
      `unknown timezone "${String(tz).slice(0, 64)}" (use an IANA name like America/New_York)`,
    );
  }
  return trimmed;
}

async function loadScheduleForWorkspace(db: Db, id: string, workspaceId: string) {
  const schedule = await db.scheduledSkill.findFirst({ where: { id, workspaceId } });
  if (!schedule) throw new ScheduleServiceError(`schedule not found: ${id}`);
  return schedule;
}

/** Create a schedule. Validates trigger config, computes the first nextRunAt. */
export async function createSchedule(db: Db, input: CreateScheduleInput, now = new Date()) {
  const skill = await db.skill.findFirst({
    where: { id: input.skillId, workspaceId: input.workspaceId },
  });
  if (!skill) throw new ScheduleServiceError(`skill not found in workspace: ${input.skillId}`);

  let projectId: string | null = null;
  if (input.projectId) {
    const project = await db.project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!project) throw new ScheduleServiceError(`project not found in workspace: ${input.projectId}`);
    projectId = project.id;
    // The wizard only offers project-enabled skills; enforce it server-side too.
    const binding = await db.projectSkill.findFirst({
      where: { projectId: project.id, skillId: skill.id, enabled: true },
    });
    if (!binding) {
      throw new ScheduleServiceError(`skill "${skill.name}" is not enabled for this project`);
    }
  }

  let cronExpr: string | null = null;
  let eventSource: string | null = null;
  let eventConfigJson: Record<string, unknown> | null = null;
  let nextRunAt: Date | null = null;
  const timezone = normalizeScheduleTimezone(input.timezone); // throws → 400

  if (input.triggerType === "cron") {
    const parsed = parseCron(input.cronExpr ?? ""); // throws CronParseError → 400
    cronExpr = parsed.expr;
    nextRunAt = nextRunAfterInZone(parsed, now, timezone);
  } else if (input.triggerType === "event") {
    if (!isEventSource(input.eventSource)) {
      throw new ScheduleServiceError(`unknown event source: ${String(input.eventSource)}`);
    }
    eventSource = input.eventSource;
    const config = validateEventConfig(input.eventSource, input.eventConfig ?? {});
    if (!config) throw new ScheduleServiceError(`invalid event config for ${input.eventSource}`);
    eventConfigJson = config;
  } else {
    throw new ScheduleServiceError(`triggerType must be "cron" or "event"`);
  }

  const approvalMode = input.approvalMode ?? input.workspaceDefaultApprovalMode ?? "supervised";
  if (!["supervised", "scheduled", "autopilot"].includes(approvalMode)) {
    throw new ScheduleServiceError(`approvalMode must be supervised|scheduled|autopilot`);
  }
  const concurrencyLimit = clampConcurrency(input.concurrencyLimit ?? DEFAULT_CONCURRENCY);

  const schedule = await db.scheduledSkill.create({
    data: {
      workspaceId: input.workspaceId,
      projectId,
      skillId: skill.id,
      triggerType: input.triggerType,
      cronExpr,
      timezone,
      eventSource,
      eventConfigJson: eventConfigJson ? (JSON.parse(JSON.stringify(eventConfigJson)) as never) : undefined,
      createdBy: input.createdBy,
      approvalMode,
      concurrencyLimit,
      status: "active",
      nextRunAt,
    },
  });

  await schedulerAudit(db, {
    projectId,
    workspaceId: input.workspaceId,
    action: "schedule_created",
    summary: `Schedule created: "${skill.name}" (${input.triggerType}${cronExpr ? ` ${cronExpr} ${timezone}` : ""}${eventSource ? ` ${eventSource}` : ""}, ${approvalMode})`,
    actorUserId: input.createdBy,
  });
  return schedule;
}

export interface UpdateScheduleInput {
  cronExpr?: string | null;
  /** IANA zone (cron schedules); null/blank resets to UTC. */
  timezone?: string | null;
  eventSource?: string | null;
  eventConfig?: Record<string, unknown> | null;
  approvalMode?: "supervised" | "scheduled" | "autopilot";
  concurrencyLimit?: number;
  status?: "active" | "paused";
}

/** Edit a schedule (workspace-scoped). Recomputes nextRunAt when the cron changes. */
export async function updateSchedule(
  db: Db,
  id: string,
  workspaceId: string,
  patch: UpdateScheduleInput,
  actorId: string,
  now = new Date(),
) {
  const schedule = await loadScheduleForWorkspace(db, id, workspaceId);
  const data: Record<string, unknown> = {};
  let statusChanged = false;

  if (patch.cronExpr !== undefined || patch.timezone !== undefined) {
    if (schedule.triggerType !== "cron") {
      throw new ScheduleServiceError(
        patch.cronExpr !== undefined
          ? "cannot set cronExpr on an event schedule"
          : "cannot set timezone on an event schedule",
      );
    }
    const timezone =
      patch.timezone !== undefined ? normalizeScheduleTimezone(patch.timezone) : schedule.timezone;
    const parsed = parseCron(patch.cronExpr !== undefined ? (patch.cronExpr ?? "") : (schedule.cronExpr ?? ""));
    data.cronExpr = parsed.expr;
    data.timezone = timezone;
    data.nextRunAt = nextRunAfterInZone(parsed, now, timezone);
  }
  if (patch.eventSource !== undefined || patch.eventConfig !== undefined) {
    if (schedule.triggerType !== "event") {
      throw new ScheduleServiceError("cannot set event config on a cron schedule");
    }
    const source = (patch.eventSource ?? schedule.eventSource) as EventSource;
    if (!isEventSource(source)) throw new ScheduleServiceError(`unknown event source: ${String(patch.eventSource)}`);
    const config = validateEventConfig(source, patch.eventConfig ?? schedule.eventConfigJson ?? {});
    if (!config) throw new ScheduleServiceError(`invalid event config for ${source}`);
    data.eventSource = source;
    data.eventConfigJson = config;
  }
  if (patch.approvalMode !== undefined) {
    if (!["supervised", "scheduled", "autopilot"].includes(patch.approvalMode)) {
      throw new ScheduleServiceError("approvalMode must be supervised|scheduled|autopilot");
    }
    data.approvalMode = patch.approvalMode;
  }
  if (patch.concurrencyLimit !== undefined) {
    data.concurrencyLimit = clampConcurrency(patch.concurrencyLimit);
  }
  if (patch.status !== undefined && patch.status !== schedule.status) {
    if (!["active", "paused"].includes(patch.status)) throw new ScheduleServiceError("status must be active|paused");
    data.status = patch.status;
    statusChanged = true;
  }

  const updated = await db.scheduledSkill.update({ where: { id: schedule.id }, data });
  await schedulerAudit(db, {
    projectId: schedule.projectId,
    workspaceId,
    action: statusChanged
      ? patch.status === "paused"
        ? "schedule_paused"
        : "schedule_resumed"
      : "schedule_updated",
    summary: `Schedule ${statusChanged ? (patch.status === "paused" ? "paused" : "resumed") : "updated"}: "${schedule.id.slice(0, 8)}"`,
    actorUserId: actorId,
  });
  return updated;
}

/** Delete a schedule. Runs keep their history (scheduleId → null). */
export async function deleteSchedule(db: Db, id: string, workspaceId: string, actorId: string) {
  const schedule = await loadScheduleForWorkspace(db, id, workspaceId);
  await db.scheduledSkill.delete({ where: { id: schedule.id } });
  await schedulerAudit(db, {
    projectId: schedule.projectId,
    workspaceId,
    action: "schedule_deleted",
    summary: `Schedule deleted: "${schedule.id.slice(0, 8)}" (skill ${schedule.skillId.slice(0, 8)})`,
    actorUserId: actorId,
  });
}

// --- Firing ---------------------------------------------------------------

export interface FireOptions {
  trigger: "cron" | "event" | "manual";
  eventPayload?: Record<string, unknown> | null;
  /** Server-constructed trigger lineage (schedule ids, oldest first). */
  lineage?: string[];
  actorId?: string | null;
  wasMissed?: boolean;
  now?: Date;
  maxRunsPerHour?: number;
  workspaceConcurrency?: number;
}

export interface FireResult {
  fired: boolean;
  runId?: string;
  awaitingApproval?: boolean;
  blockedReason?: string;
}

/**
 * Fire one schedule: guardrails (cycle, rate limit) → create the SkillRun →
 * supervised holds for approval, otherwise execute. Returns the outcome;
 * blocked firings are audited, never thrown (except unexpected DB errors).
 */
export async function fireSchedule(db: Db, schedule: ScheduledSkill, opts: FireOptions): Promise<FireResult> {
  const now = opts.now ?? new Date();
  if (schedule.status !== "active") return { fired: false, blockedReason: "schedule is paused" };

  const lineage = opts.lineage ?? [];
  const cycle = checkCycle(lineage, schedule.id);
  if (!cycle.allowed) {
    await schedulerAudit(db, {
      projectId: schedule.projectId,
      workspaceId: schedule.workspaceId,
      action: "scheduler_cycle_blocked",
      summary: cycle.detail ?? "cycle blocked",
      actorUserId: opts.actorId ?? null,
    });
    return { fired: false, blockedReason: cycle.detail };
  }

  const rate = await checkRateLimit(db, schedule.id, now, opts.maxRunsPerHour ?? DEFAULT_MAX_RUNS_PER_HOUR);
  if (!rate.allowed) {
    await schedulerAudit(db, {
      projectId: schedule.projectId,
      workspaceId: schedule.workspaceId,
      action: "scheduler_run_failed",
      summary: `Run dropped: ${rate.detail}`,
      actorUserId: opts.actorId ?? null,
    });
    return { fired: false, blockedReason: rate.detail };
  }

  const awaitingApproval = schedule.approvalMode === "supervised";
  const run = await db.skillRun.create({
    data: {
      scheduleId: schedule.id,
      workspaceId: schedule.workspaceId,
      projectId: schedule.projectId,
      skillId: schedule.skillId,
      trigger: opts.trigger,
      lineage: [...lineage, schedule.id],
      eventPayload: opts.eventPayload ? JSON.parse(JSON.stringify(opts.eventPayload)) : undefined,
      status: awaitingApproval ? "awaiting_approval" : "pending",
      wasMissed: opts.wasMissed ?? false,
      startedAt: now,
    },
  });

  await db.scheduledSkill.update({
    where: { id: schedule.id },
    data: { lastRunAt: now },
  });

  if (awaitingApproval) {
    // T9: supervised runs execute NOTHING until a human approves.
    await schedulerAudit(db, {
      projectId: schedule.projectId,
      workspaceId: schedule.workspaceId,
      action: "scheduler_run_proposed",
      summary: `Supervised run proposed: schedule ${schedule.id.slice(0, 8)} (trigger ${opts.trigger}) — waiting for approval`,
      actorUserId: opts.actorId ?? null,
    });
    // Phase 3 (J): best-effort "needs you" notification (never throws).
    // Deciding needs skills.install (admin+ always holds it).
    await notifyApprovalNeeded({
      workspaceId: schedule.workspaceId,
      source: "scheduler",
      sourceId: run.id,
      title: `Supervised run (${opts.trigger}) is waiting for approval`,
      href: schedule.projectId
        ? `/dashboard/projects/${encodeURIComponent(schedule.projectId)}/automations/schedules/runs/${encodeURIComponent(run.id)}`
        : undefined,
      requestedBy: opts.actorId ?? null,
      decideRole: "admin",
    });
    return { fired: true, runId: run.id, awaitingApproval: true };
  }

  await executeSkillRun(db, run.id, { workspaceConcurrency: opts.workspaceConcurrency });
  return { fired: true, runId: run.id };
}

/** Approve a supervised run → it executes. Rejects anything not awaiting approval. */
export async function approveRun(db: Db, runId: string, workspaceId: string, approverId: string) {
  const run = await db.skillRun.findFirst({
    where: { id: runId, workspaceId },
    include: { skill: true, schedule: { select: { createdBy: true } } },
  });
  if (!run) throw new ScheduleServiceError(`run not found: ${runId}`);
  if (run.status !== "awaiting_approval") {
    throw new ScheduleServiceError(`run is not awaiting approval (status ${run.status})`);
  }
  await db.skillRun.update({
    where: { id: run.id },
    data: { status: "approved", approvedBy: approverId, approvedAt: new Date() },
  });
  await schedulerAudit(db, {
    projectId: run.projectId,
    workspaceId,
    action: "scheduler_run_approved",
    summary: `Supervised run approved: "${run.skill.name}" (run ${run.id.slice(0, 8)})`,
    actorUserId: approverId,
  });
  // Phase 4a: best-effort "decided" notification to the schedule's owner
  // (never throws — the decision already landed).
  await notifyScheduledRunDecided(run, "approved", approverId);
  await executeSkillRun(db, run.id);
  return run.id;
}

/** Reject a supervised run → it never executes. */
export async function rejectRun(db: Db, runId: string, workspaceId: string, approverId: string) {
  const run = await db.skillRun.findFirst({
    where: { id: runId, workspaceId },
    include: { skill: true, schedule: { select: { createdBy: true } } },
  });
  if (!run) throw new ScheduleServiceError(`run not found: ${runId}`);
  if (run.status !== "awaiting_approval") {
    throw new ScheduleServiceError(`run is not awaiting approval (status ${run.status})`);
  }
  await db.skillRun.update({ where: { id: run.id }, data: { status: "rejected", finishedAt: new Date(), approvedBy: approverId, approvedAt: new Date() } });
  await schedulerAudit(db, {
    projectId: run.projectId,
    workspaceId,
    action: "scheduler_run_rejected",
    summary: `Supervised run rejected: run ${run.id.slice(0, 8)}`,
    actorUserId: approverId,
  });
  await notifyScheduledRunDecided(run, "denied", approverId);
}

/** "Your supervised run was approved/rejected" → the schedule's creator. Never throws. */
async function notifyScheduledRunDecided(
  run: { id: string; workspaceId: string; projectId: string | null; skill: { name: string }; schedule: { createdBy: string } | null },
  decision: "approved" | "denied",
  decidedBy: string,
): Promise<void> {
  await notifyApprovalDecided({
    workspaceId: run.workspaceId,
    source: "scheduler",
    sourceId: run.id,
    title: `Supervised run of "${run.skill.name}"`,
    decision,
    decidedBy,
    requestedBy: run.schedule?.createdBy ?? null,
    href: run.projectId
      ? `/dashboard/projects/${encodeURIComponent(run.projectId)}/automations/schedules/runs/${encodeURIComponent(run.id)}`
      : undefined,
  });
}

/** Manual trigger (testing / ad-hoc). Same guards and approval-mode handling as cron/event. */
export async function triggerManual(
  db: Db,
  scheduleId: string,
  workspaceId: string,
  actorId: string,
  opts: Partial<FireOptions> = {},
): Promise<FireResult> {
  const schedule = await loadScheduleForWorkspace(db, scheduleId, workspaceId);
  return fireSchedule(db, schedule, { trigger: "manual", lineage: [], actorId, ...opts });
}

// --- Event bus ---------------------------------------------------------------

export interface InjectEventInput {
  workspaceId: string;
  projectId?: string | null;
  source: string;
  payload: unknown;
  /** Server-side lineage when the injector is itself a run (cycle guard). Never client-settable on the route. */
  lineage?: string[];
  actorId?: string | null;
  now?: Date;
}

export interface InjectEventResult {
  accepted: boolean;
  error?: string;
  fired: { scheduleId: string; runId?: string; awaitingApproval?: boolean }[];
  skipped: { scheduleId: string; reason: string }[];
}

/**
 * Inject an event into the bus. Validates the payload (T5), finds matching
 * active event schedules in the workspace, evaluates per-source fire
 * conditions, and fires them through the same guarded path as cron.
 */
export async function injectEvent(db: Db, input: InjectEventInput): Promise<InjectEventResult> {
  if (!isEventSource(input.source)) {
    return { accepted: false, error: `unknown event source: ${input.source}`, fired: [], skipped: [] };
  }
  const payload = validateEventPayload(input.source, input.payload);
  if (!payload) {
    return { accepted: false, error: `payload failed validation for ${input.source}`, fired: [], skipped: [] };
  }

  // Workspace scoping: the event's project (if any) must live in this workspace.
  let projectId: string | null = null;
  if (input.projectId) {
    const project = await db.project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!project) {
      return { accepted: false, error: "event project is not in this workspace", fired: [], skipped: [] };
    }
    projectId = project.id;
  }

  const schedules = await db.scheduledSkill.findMany({
    where: {
      workspaceId: input.workspaceId,
      status: "active",
      triggerType: "event",
      eventSource: input.source,
    },
  });

  const fired: InjectEventResult["fired"] = [];
  const skipped: InjectEventResult["skipped"] = [];
  const lineage = input.lineage ?? [];

  for (const schedule of schedules) {
    // Project scoping: workspace-wide schedules fire for any in-workspace
    // event; project-scoped schedules fire only for their own project's events.
    if (schedule.projectId !== null && schedule.projectId !== projectId) {
      skipped.push({ scheduleId: schedule.id, reason: "event is for a different project" });
      continue;
    }
    const config = (schedule.eventConfigJson ?? {}) as Record<string, unknown>;
    if (!shouldFire(input.source, config, payload)) {
      skipped.push({ scheduleId: schedule.id, reason: "fire condition not met" });
      continue;
    }
    const result = await fireSchedule(db, schedule, {
      trigger: "event",
      eventPayload: { source: input.source, projectId, ...payload },
      lineage,
      actorId: input.actorId,
      now: input.now,
    });
    if (result.fired) {
      fired.push({ scheduleId: schedule.id, runId: result.runId, awaitingApproval: result.awaitingApproval });
      await schedulerAudit(db, {
        projectId: schedule.projectId,
        workspaceId: input.workspaceId,
        action: "event_fired",
        summary: `Event fired schedule ${schedule.id.slice(0, 8)}: ${describeEvent(input.source, payload)}`,
        actorUserId: input.actorId ?? null,
      });
    } else {
      skipped.push({ scheduleId: schedule.id, reason: result.blockedReason ?? "blocked" });
    }
  }

  return { accepted: true, fired, skipped };
}
