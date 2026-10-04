// Marketr — Phase 17 slice 4: project-specific service layer.
//
// Built ON TOP of the slice-1 DocType convention (lib/ops/doctype.ts):
//   - milestones: add / complete / reopen conveniences on the milestones
//     JSON column ([{ title, dueAt?, status }]). Atomic append/set via a
//     single read-modify-write inside the caller's tx; progress is
//     computed (completed / total) rather than stored.
//   - time entries: append-only ledger (OpsTimeEntry) — log rows to
//     correct, never edit history. Durations in integer minutes.
//   - completeProject: transitions the project to completed and returns
//     the unbilled-time nudge (info only — completing with unbilled
//     time is NOT gated; the nudge is a reminder, not a block).
//   - status transitions are guarded by PROJECT_STATUS_TRANSITIONS —
//     enforced in applyPatch (lib/ops/doctype.ts) for the projects slug.
//
// customerId on OpsProject is a crm_leads.id (the lead-turned-customer);
// leadId/dealId are the Wave B canonical CRM refs. resolveCustomerNames
// is reused from lib/ops/invoices.ts.

import type { Prisma } from "@prisma/client";
import {
  OpsError,
  OpsNotFoundError,
  type OpsActor,
} from "./doctype";

type Tx = Prisma.TransactionClient;

export interface Milestone {
  title: string;
  dueAt?: string;
  status: string; // "open" | "done"
  [key: string]: unknown;
}

export interface OpsProjectRow {
  id: string;
  workspaceId: string;
  customerId: string | null;
  name: string;
  milestones: unknown;
  status: string;
  leadId: string | null;
  dealId: string | null;
  createdAt: Date | string;
  [key: string]: unknown;
}

export interface OpsTimeEntryRow {
  id: string;
  workspaceId: string;
  projectId: string;
  minutes: number;
  description: string | null;
  actor: string | null;
  occurredAt: Date | string;
  billed: boolean;
  createdAt: Date | string;
  [key: string]: unknown;
}

/** Legal status transitions. Terminal states (completed, cancelled) have none. */
export const PROJECT_STATUS_TRANSITIONS: Record<string, string[]> = {
  planning: ["active", "cancelled"],
  active: ["on_hold", "completed", "cancelled"],
  on_hold: ["active", "cancelled"],
  completed: [],
  cancelled: [],
};

/** Guard: is a status move legal? (Non-status patches are untouched.) */
export function assertLegalProjectTransition(from: string, to: string): void {
  if (from === to) return;
  const allowed = PROJECT_STATUS_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new OpsError(
      422,
      `Illegal project transition: ${from} → ${to} (allowed: ${allowed.join(", ") || "none — terminal"})`,
    );
  }
}

function delegates(tx: Tx) {
  return tx as unknown as {
    opsProject: {
      findFirst(a: unknown): Promise<OpsProjectRow | null>;
      update(a: unknown): Promise<OpsProjectRow>;
    };
    opsTimeEntry: {
      findMany(a: unknown): Promise<OpsTimeEntryRow[]>;
      create(a: unknown): Promise<OpsTimeEntryRow>;
      update(a: unknown): Promise<OpsTimeEntryRow>;
    };
  };
}

function asMilestones(raw: unknown): Milestone[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is Milestone =>
      !!m && typeof m === "object" && typeof (m as Milestone).title === "string",
  );
}

/** Load one project, workspace-scoped (404 for other workspaces' rows). */
export async function getProject(tx: Tx, actor: OpsActor, id: string): Promise<OpsProjectRow> {
  const row = await delegates(tx).opsProject.findFirst({
    where: { id, workspaceId: actor.workspaceId },
  });
  if (!row) throw new OpsNotFoundError("projects", id);
  return row;
}

async function audit(
  tx: Tx,
  actor: OpsActor,
  action: string,
  entityId: string,
  summary: string,
): Promise<void> {
  await (
    tx as unknown as { opsAuditEvent: { create(a: unknown): Promise<unknown> } }
  ).opsAuditEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      entity: "projects",
      entityId,
      action,
      actor: actor.userId,
      summary: summary.slice(0, 2000),
    },
  });
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export interface ProjectProgress {
  total: number;
  done: number;
  open: number;
  pct: number;
}

export function projectProgress(raw: unknown): ProjectProgress {
  const ms = asMilestones(raw);
  const done = ms.filter((m) => m.status === "done").length;
  const total = ms.length;
  return { total, done, open: total - done, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export async function addMilestone(
  tx: Tx,
  actor: OpsActor,
  projectId: string,
  input: { title: string; dueAt?: string },
): Promise<{ project: OpsProjectRow; progress: ProjectProgress }> {
  const title = input.title.trim();
  if (!title || title.length > 200) throw new OpsError(400, "Milestone title must be 1–200 characters");
  if (input.dueAt && Number.isNaN(new Date(input.dueAt).getTime())) {
    throw new OpsError(400, "Invalid dueAt date");
  }
  const project = await getProject(tx, actor, projectId);
  const ms = asMilestones(project.milestones);
  if (ms.length >= 200) throw new OpsError(422, "Project already has 200 milestones");
  ms.push({ title, ...(input.dueAt ? { dueAt: input.dueAt } : {}), status: "open" });
  const row = await delegates(tx).opsProject.update({
    where: { id: projectId, workspaceId: actor.workspaceId },
    data: { milestones: ms },
  });
  await audit(tx, actor, "milestone_added", projectId, `milestone added to "${project.name}": ${title}`);
  return { project: row, progress: projectProgress(ms) };
}

export async function setMilestoneStatus(
  tx: Tx,
  actor: OpsActor,
  projectId: string,
  index: number,
  status: "done" | "open",
): Promise<{ project: OpsProjectRow; progress: ProjectProgress }> {
  const project = await getProject(tx, actor, projectId);
  const ms = asMilestones(project.milestones);
  if (!Number.isInteger(index) || index < 0 || index >= ms.length) {
    throw new OpsError(404, `Milestone ${index} not found (project has ${ms.length})`);
  }
  ms[index] = { ...ms[index], status };
  const row = await delegates(tx).opsProject.update({
    where: { id: projectId, workspaceId: actor.workspaceId },
    data: { milestones: ms },
  });
  await audit(
    tx,
    actor,
    status === "done" ? "milestone_completed" : "milestone_reopened",
    projectId,
    `milestone ${status === "done" ? "completed" : "reopened"} on "${project.name}": ${ms[index].title}`,
  );
  return { project: row, progress: projectProgress(ms) };
}

// ---------------------------------------------------------------------------
// Time entries (append-only ledger, integer minutes)
// ---------------------------------------------------------------------------

export async function logTimeEntry(
  tx: Tx,
  actor: OpsActor,
  projectId: string,
  input: {
    minutes: number;
    description?: string;
    actor?: string;
    occurredAt?: string;
    // Phase 10 (ops-core): whose time (defaults to the acting user), the
    // billing rate in cents/hour (null = project rate), task, billable flag.
    userId?: string;
    rateCents?: number;
    taskId?: string;
    billable?: boolean;
  },
): Promise<OpsTimeEntryRow> {
  const project = await getProject(tx, actor, projectId);
  const userId = input.userId ?? (actor.userId.startsWith("agent:") ? undefined : actor.userId);
  if (input.userId && input.userId !== actor.userId) {
    const { assertWorkspaceUser } = await import("./people");
    await assertWorkspaceUser(tx, actor.workspaceId, input.userId);
  }
  if (input.rateCents !== undefined && (!Number.isInteger(input.rateCents) || input.rateCents < 0 || input.rateCents > 100_000_000)) {
    throw new OpsError(400, "rateCents must be a non-negative integer (cents per hour)");
  }
  if (input.taskId) {
    const task = await (tx as unknown as { opsTask: { findFirst(a: unknown): Promise<{ id: string } | null> } }).opsTask.findFirst({
      where: { id: input.taskId, projectId, workspaceId: actor.workspaceId },
    });
    if (!task) throw new OpsNotFoundError("tasks", input.taskId);
  }
  if (!Number.isInteger(input.minutes) || input.minutes <= 0 || input.minutes > 24 * 60 * 31) {
    throw new OpsError(400, "minutes must be a positive integer (max: one month)");
  }
  const description = (input.description ?? "").trim().slice(0, 2000) || null;
  let occurredAt: Date | undefined;
  if (input.occurredAt) {
    const d = new Date(input.occurredAt);
    if (Number.isNaN(d.getTime())) throw new OpsError(400, "Invalid occurredAt date");
    if (d.getTime() > Date.now() + 3600_000) throw new OpsError(400, "occurredAt cannot be in the future");
    occurredAt = d;
  }
  const entry = await delegates(tx).opsTimeEntry.create({
    data: {
      workspaceId: actor.workspaceId,
      projectId,
      minutes: input.minutes,
      description,
      actor: (input.actor ?? actor.userId).slice(0, 200),
      ...(occurredAt ? { occurredAt } : {}),
      ...(userId ? { userId } : {}),
      ...(input.rateCents !== undefined ? { rateCents: input.rateCents } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.billable !== undefined ? { billable: input.billable } : {}),
    },
  });
  await audit(
    tx,
    actor,
    "time_logged",
    projectId,
    `${input.minutes} min logged on "${project.name}"${description ? `: ${description.slice(0, 120)}` : ""}`,
  );
  return entry;
}

export interface TimeTotals {
  totalMinutes: number;
  billedMinutes: number;
  unbilledMinutes: number;
  entries: number;
}

export async function projectTimeTotals(tx: Tx, actor: OpsActor, projectId: string): Promise<TimeTotals> {
  await getProject(tx, actor, projectId);
  const entries = await delegates(tx).opsTimeEntry.findMany({
    where: { workspaceId: actor.workspaceId, projectId },
  });
  const totalMinutes = entries.reduce((s, e) => s + e.minutes, 0);
  const billedMinutes = entries.filter((e) => e.billed).reduce((s, e) => s + e.minutes, 0);
  return {
    totalMinutes,
    billedMinutes,
    unbilledMinutes: totalMinutes - billedMinutes,
    entries: entries.length,
  };
}

export async function listTimeEntries(
  tx: Tx,
  actor: OpsActor,
  projectId: string,
): Promise<OpsTimeEntryRow[]> {
  await getProject(tx, actor, projectId);
  return delegates(tx).opsTimeEntry.findMany({
    where: { workspaceId: actor.workspaceId, projectId },
    orderBy: { occurredAt: "desc" },
    take: 200,
  });
}

export async function markTimeEntryBilled(
  tx: Tx,
  actor: OpsActor,
  projectId: string,
  entryId: string,
): Promise<OpsTimeEntryRow> {
  await getProject(tx, actor, projectId);
  const d = delegates(tx);
  const existing = await (
    d as unknown as { opsTimeEntry: { findFirst(a: unknown): Promise<OpsTimeEntryRow | null> } }
  ).opsTimeEntry.findFirst({
    where: { id: entryId, projectId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new OpsNotFoundError("time-entries", entryId);
  const row = await d.opsTimeEntry.update({ where: { id: entryId }, data: { billed: true } });
  await audit(tx, actor, "time_billed", projectId, `time entry marked billed (${existing.minutes} min)`);
  return row;
}

// ---------------------------------------------------------------------------
// Complete with unbilled-time nudge (info only — never a gate)
// ---------------------------------------------------------------------------

export interface CompleteProjectResult {
  project: OpsProjectRow;
  unbilledMinutes: number;
  nudge: string | null;
}

export function fmtMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Transition a project to completed. Free logged write (no money moves
 * here — never gated). If unbilled time exists, the result carries an
 * info-only nudge: a reminder, not a block.
 */
export async function completeProject(
  tx: Tx,
  actor: OpsActor,
  projectId: string,
): Promise<CompleteProjectResult> {
  const project = await getProject(tx, actor, projectId);
  assertLegalProjectTransition(project.status, "completed");
  const totals = await projectTimeTotals(tx, actor, projectId);
  const row = await delegates(tx).opsProject.update({
    where: { id: projectId, workspaceId: actor.workspaceId },
    data: { status: "completed" },
  });
  const nudge =
    totals.unbilledMinutes > 0
      ? `Project completed with ${fmtMinutes(totals.unbilledMinutes)} of unbilled time — invoice it or mark it billed before closing the books.`
      : null;
  await audit(
    tx,
    actor,
    "completed",
    projectId,
    `project "${project.name}" completed${nudge ? ` (${fmtMinutes(totals.unbilledMinutes)} unbilled)` : ""}`,
  );
  return { project: row, unbilledMinutes: totals.unbilledMinutes, nudge };
}

export { OpsError, OpsNotFoundError };
