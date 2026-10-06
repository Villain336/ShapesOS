// ShapesOS — Phase 18.2 (WS=comms): Reminders — personal to-dos.
//
// No new task model: a reminder is an OpsTask with NO project, assigned to
// its owner (assignee = created_by = the member). It has an optional due
// time, an optional simple repeat (daily / weekly / monthly — in the
// member's time zone, so 9:00 stays 9:00 across DST) and is done or not.
//
//   - Completing a repeating reminder rolls it to its next occurrence (the
//     completion time is kept in completed_at); a one-off one is "done".
//   - Due → one `reminder_due` notification through the existing producers
//     (lib/notifications/producers.ts notifyReminderDue), so focus / do not
//     disturb holds it and the member's channel preferences filter it.
//     reminder_notified_at marks the occurrence as notified (idempotent
//     sweeps; a new occurrence clears it).
//   - Personal: every read and write here is keyed to the member (a
//     teammate never sees or changes your reminders), and the generic ops
//     task list never lists project-less tasks (lib/ops/entities.ts).
//
// ops_tasks is FORCE RLS: every call takes the withWorkspaceScope client.

import type { Prisma, PrismaClient } from "@prisma/client";
import { HttpError } from "@/lib/api/errors";
import { addMonthsClamped, resolveTimeZone, zonedParts, zonedTimeToUtc } from "@/lib/time/zoned";

type Db = Prisma.TransactionClient | PrismaClient;

export const REPEAT_RULES = ["daily", "weekly", "monthly"] as const;
export type RepeatRule = (typeof REPEAT_RULES)[number];

export function isRepeatRule(v: unknown): v is RepeatRule {
  return typeof v === "string" && (REPEAT_RULES as readonly string[]).includes(v);
}

export const REMINDER_TITLE_MAX = 300;
export const REMINDER_NOTES_MAX = 5000;

/** A refusal the route shows as-is (HttpError → its status). */
export class ReminderError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "ReminderError";
  }
}

export interface ReminderView {
  id: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  repeat: RepeatRule | null;
  done: boolean;
  completedAt: string | null;
  /** Past due and not done. */
  overdue: boolean;
  sourceRef: string | null;
  createdAt: string;
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  dueAt: Date | null;
  repeatRule: string | null;
  stage: string;
  completedAt: Date | null;
  sourceRef: string | null;
  createdAt: Date;
}

const SELECT = {
  id: true,
  title: true,
  description: true,
  dueAt: true,
  repeatRule: true,
  stage: true,
  completedAt: true,
  sourceRef: true,
  createdAt: true,
} as const;

export function toReminderView(r: TaskRow, now = new Date()): ReminderView {
  const done = r.stage === "done" || r.stage === "cancelled";
  return {
    id: r.id,
    title: r.title,
    notes: r.description,
    dueAt: r.dueAt ? r.dueAt.toISOString() : null,
    repeat: isRepeatRule(r.repeatRule) ? r.repeatRule : null,
    done,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    overdue: !done && !!r.dueAt && r.dueAt.getTime() < now.getTime(),
    sourceRef: r.sourceRef,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * The next occurrence after `due` for a repeat rule, at the same LOCAL wall
 * time in `timeZone` (DST-safe: stepping is done on local dates). Monthly
 * clamps the day (Jan 31 → Feb 28/29). PURE.
 */
export function nextOccurrence(due: Date, rule: RepeatRule, timeZone: string): Date {
  const tz = resolveTimeZone(timeZone);
  const p = zonedParts(due, tz);
  if (rule === "monthly") {
    const m = addMonthsClamped(p.year, p.month, p.day, 1);
    return zonedTimeToUtc(m.year, m.month, m.day, p.minutes, tz).date;
  }
  const days = rule === "daily" ? 1 : 7;
  // Day overflow normalizes like Date.UTC (day 32 → next month).
  return zonedTimeToUtc(p.year, p.month, p.day + days, p.minutes, tz).date;
}

/**
 * The next occurrence strictly after `now` (a reminder completed late does
 * not leave a trail of past occurrences). Bounded, PURE.
 */
export function nextOccurrenceAfter(due: Date, rule: RepeatRule, timeZone: string, now: Date): Date {
  let next = nextOccurrence(due, rule, timeZone);
  for (let i = 0; i < 1000 && next.getTime() <= now.getTime(); i++) next = nextOccurrence(next, rule, timeZone);
  return next;
}

export interface ReminderInput {
  title: string;
  notes?: string | null;
  dueAt?: Date | null;
  repeat?: RepeatRule | null;
  sourceRef?: string | null;
}

/** The first problem with a reminder, or null. PURE. */
export function validateReminder(input: { title?: unknown; notes?: unknown; dueAt?: unknown; repeat?: unknown }): string | null {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) return "Write what to remember.";
  if (title.length > REMINDER_TITLE_MAX) return `Keep it under ${REMINDER_TITLE_MAX} characters.`;
  if (input.notes !== undefined && input.notes !== null && (typeof input.notes !== "string" || input.notes.length > REMINDER_NOTES_MAX)) {
    return `Keep notes under ${REMINDER_NOTES_MAX} characters.`;
  }
  if (input.dueAt !== undefined && input.dueAt !== null && !(input.dueAt instanceof Date && !Number.isNaN(input.dueAt.getTime()))) {
    return "Pick a valid due time.";
  }
  if (input.repeat !== undefined && input.repeat !== null && !isRepeatRule(input.repeat)) return "Repeat is daily, weekly or monthly.";
  if (input.repeat && !input.dueAt) return "A repeating reminder needs a due time.";
  return null;
}

/** A member's reminders: open ones first by due time, then the recently done. */
export async function listReminders(
  db: Db,
  opts: { workspaceId: string; userId: string; includeDone?: boolean; limit?: number; now?: Date },
): Promise<ReminderView[]> {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const mine = { workspaceId: opts.workspaceId, projectId: null, assigneeId: opts.userId };
  const open = await db.opsTask.findMany({
    where: { ...mine, workspaceId: opts.workspaceId, stage: { notIn: ["done", "cancelled"] } },
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: limit,
    select: SELECT,
  });
  const done = opts.includeDone
    ? await db.opsTask.findMany({
        where: { ...mine, workspaceId: opts.workspaceId, stage: "done" },
        orderBy: { completedAt: "desc" },
        take: 50,
        select: SELECT,
      })
    : [];
  return [...open, ...done].map((r) => toReminderView(r, now));
}

async function ownReminder(db: Db, workspaceId: string, userId: string, id: string) {
  const row = await db.opsTask.findFirst({
    where: { id, workspaceId, projectId: null, assigneeId: userId },
    select: { ...SELECT, workspaceId: true },
  });
  if (!row) throw new ReminderError(404, "Reminder not found.");
  return row;
}

export async function getReminder(db: Db, opts: { workspaceId: string; userId: string; id: string; now?: Date }): Promise<ReminderView> {
  return toReminderView(await ownReminder(db, opts.workspaceId, opts.userId, opts.id), opts.now);
}

export async function createReminder(
  db: Db,
  opts: { workspaceId: string; userId: string; now?: Date } & ReminderInput,
): Promise<ReminderView> {
  const problem = validateReminder(opts);
  if (problem) throw new ReminderError(400, problem);
  const row = await db.opsTask.create({
    data: {
      workspaceId: opts.workspaceId,
      projectId: null,
      assigneeId: opts.userId,
      createdBy: opts.userId,
      title: opts.title.trim(),
      description: opts.notes?.trim() || null,
      dueAt: opts.dueAt ?? null,
      repeatRule: opts.repeat ?? null,
      sourceRef: opts.sourceRef ?? null,
      stage: "todo",
    },
    select: SELECT,
  });
  return toReminderView(row, opts.now);
}

export interface ReminderPatch {
  title?: string;
  notes?: string | null;
  dueAt?: Date | null;
  repeat?: RepeatRule | null;
  done?: boolean;
}

/** Edit / complete / reopen one of the member's own reminders. */
export async function updateReminder(
  db: Db,
  opts: { workspaceId: string; userId: string; id: string; patch: ReminderPatch; timeZone?: string | null; now?: Date },
): Promise<ReminderView> {
  const now = opts.now ?? new Date();
  const existing = await ownReminder(db, opts.workspaceId, opts.userId, opts.id);
  const p = opts.patch;
  const merged = {
    title: p.title ?? existing.title,
    notes: p.notes === undefined ? existing.description : p.notes,
    dueAt: p.dueAt === undefined ? existing.dueAt : p.dueAt,
    repeat: p.repeat === undefined ? (isRepeatRule(existing.repeatRule) ? existing.repeatRule : null) : p.repeat,
  };
  const problem = validateReminder(merged);
  if (problem) throw new ReminderError(400, problem);
  const data: Prisma.OpsTaskUncheckedUpdateInput = {
    title: merged.title.trim(),
    description: merged.notes?.trim() || null,
    dueAt: merged.dueAt,
    repeatRule: merged.repeat,
  };
  // A moved due time is a new occurrence: it may notify again.
  if (p.dueAt !== undefined && (p.dueAt?.getTime() ?? null) !== (existing.dueAt?.getTime() ?? null)) data.reminderNotifiedAt = null;
  if (p.done === true && existing.stage !== "done") {
    if (merged.repeat && merged.dueAt) {
      // Repeating: roll to the next occurrence, keep it open.
      data.dueAt = nextOccurrenceAfter(merged.dueAt, merged.repeat, opts.timeZone ?? "UTC", now);
      data.reminderNotifiedAt = null;
      data.completedAt = now;
      data.stage = "todo";
    } else {
      data.stage = "done";
      data.completedAt = now;
    }
  } else if (p.done === false && existing.stage === "done") {
    data.stage = "todo";
    data.completedAt = null;
    data.reminderNotifiedAt = null;
  }
  const row = await db.opsTask.update({ where: { id: existing.id, workspaceId: opts.workspaceId }, data, select: SELECT });
  return toReminderView(row, now);
}

export async function removeReminder(db: Db, opts: { workspaceId: string; userId: string; id: string }): Promise<void> {
  const existing = await ownReminder(db, opts.workspaceId, opts.userId, opts.id);
  await db.opsTask.delete({ where: { id: existing.id, workspaceId: opts.workspaceId } });
}

/** Open reminders due at or before `now` that have not been notified for this occurrence. */
export async function dueReminders(db: Db, opts: { workspaceId?: string | null; now?: Date; limit?: number }) {
  const now = opts.now ?? new Date();
  return db.opsTask.findMany({
    where: {
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      projectId: null,
      assigneeId: { not: null },
      stage: { notIn: ["done", "cancelled"] },
      dueAt: { lte: now },
      reminderNotifiedAt: null,
    },
    orderBy: { dueAt: "asc" },
    take: Math.min(Math.max(opts.limit ?? 500, 1), 2000),
    select: { id: true, workspaceId: true, assigneeId: true, title: true, dueAt: true },
  });
}

/** Mark one occurrence notified (only if still un-notified: concurrent sweeps notify once). */
export async function markReminderNotified(db: Db, workspaceId: string, id: string, now = new Date()): Promise<boolean> {
  const r = await db.opsTask.updateMany({ where: { id, workspaceId, reminderNotifiedAt: null }, data: { reminderNotifiedAt: now } });
  return r.count === 1;
}
