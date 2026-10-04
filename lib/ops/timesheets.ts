// ShapesOS Phase 10 (ops-core) — project tasks, timesheet approval and
// "invoice unbilled time".
//
// Builds on lib/ops/projects.ts (the append-only OpsTimeEntry ledger) and the
// invoice DocType (lib/ops/doctype.ts opsCreate / opsPatch): billing time
// creates REAL line items on a DRAFT invoice through the same service every
// other invoice goes through (totals server-computed, audited, idempotency
// key), and marks each entry billed with that invoice id in the same
// transaction — exactly once (status-guarded claim on billed=false).
// Sending the invoice stays a gated money write.

import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { OpsError, OpsNotFoundError, auditOpsEvent, opsCreate, opsPatch, type OpsActor } from "./doctype";
import { OPS_ENTITY_MAP } from "./entities";
import { assertWorkspaceUser, listWorkspacePeople } from "./people";
import { fmtMinutes } from "./projects";

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Tasks (OPS_ENTITIES hooks)
// ---------------------------------------------------------------------------

export const TASK_STAGES = ["backlog", "todo", "in_progress", "review", "done", "cancelled"] as const;

export async function createTaskRow(tx: Tx, actor: OpsActor, body: Record<string, unknown>) {
  const project = await tx.opsProject.findFirst({ where: { id: String(body.projectId), workspaceId: actor.workspaceId } });
  if (!project) throw new OpsNotFoundError("projects", String(body.projectId));
  if (project.status === "completed" || project.status === "cancelled") {
    throw new OpsError(422, `Project "${project.name}" is ${project.status} — reopen it to add tasks`);
  }
  if (typeof body.assigneeId === "string") await assertWorkspaceUser(tx, actor.workspaceId, body.assigneeId);
  const stage = (body.stage as string | undefined) ?? "todo";
  return tx.opsTask.create({
    data: {
      workspaceId: actor.workspaceId,
      projectId: project.id,
      title: String(body.title).trim(),
      description: (body.description as string | undefined) ?? null,
      stage: stage as (typeof TASK_STAGES)[number],
      priority: ((body.priority as string | undefined) ?? "normal") as "low" | "normal" | "high" | "urgent",
      assigneeId: (body.assigneeId as string | undefined) ?? null,
      dueAt: body.dueAt ? new Date(String(body.dueAt)) : null,
      estimateMinutes: (body.estimateMinutes as number | undefined) ?? null,
      completedAt: stage === "done" ? new Date() : null,
      // Phase 10 (portal)
      clientVisible: body.clientVisible === true,
      createdBy: actor.userId,
    },
  }) as unknown as Promise<Record<string, unknown>>;
}

export async function patchTaskRow(tx: Tx, actor: OpsActor, id: string, patch: Record<string, unknown>, existing: Record<string, unknown>) {
  const data: Record<string, unknown> = { ...patch };
  if (typeof patch.assigneeId === "string") await assertWorkspaceUser(tx, actor.workspaceId, patch.assigneeId);
  if (patch.dueAt !== undefined) data.dueAt = patch.dueAt === null ? null : new Date(String(patch.dueAt));
  if (typeof patch.stage === "string" && patch.stage !== existing.stage) {
    data.completedAt = patch.stage === "done" ? new Date() : null;
  }
  return tx.opsTask.update({ where: { id, workspaceId: actor.workspaceId }, data }) as unknown as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Billing maths (pure)
// ---------------------------------------------------------------------------

/** Integer cents for `minutes` at `rateCents` per hour (half-up). */
export function billableAmountCents(minutes: number, rateCents: number): number {
  return Math.round((minutes * rateCents) / 60);
}

export interface BillableEntry {
  id: string;
  minutes: number;
  userId: string | null;
  rateCents: number | null;
}

export interface TimeInvoiceLine {
  description: string;
  qty: number;
  priceCents: number;
  entryIds: string[];
}

/**
 * Group approved, unbilled entries into invoice lines: one line per
 * (person, effective rate). An entry with no rate uses the project rate;
 * entries with neither are refused (422) — never billed at $0 silently.
 */
export function timeInvoiceLines(
  projectName: string,
  entries: BillableEntry[],
  projectRateCents: number | null,
  nameOf: (userId: string | null) => string,
): TimeInvoiceLine[] {
  const groups = new Map<string, { userId: string | null; rate: number; minutes: number; ids: string[] }>();
  const missing: string[] = [];
  for (const e of entries) {
    const rate = e.rateCents ?? projectRateCents;
    if (rate == null) {
      missing.push(e.id);
      continue;
    }
    const k = `${e.userId ?? ""}|${rate}`;
    const g = groups.get(k) ?? { userId: e.userId, rate, minutes: 0, ids: [] };
    g.minutes += e.minutes;
    g.ids.push(e.id);
    groups.set(k, g);
  }
  if (missing.length > 0) {
    throw new OpsError(422, `${missing.length} time entr${missing.length === 1 ? "y has" : "ies have"} no rate — set the project's hourly rate or log time with a rate`);
  }
  return [...groups.values()].map((g) => ({
    description: `${projectName} — ${nameOf(g.userId)}: ${fmtMinutes(g.minutes)} @ $${(g.rate / 100).toFixed(2)}/h`.slice(0, 500),
    qty: 1,
    priceCents: billableAmountCents(g.minutes, g.rate),
    entryIds: g.ids,
  }));
}

// ---------------------------------------------------------------------------
// Timesheet approval
// ---------------------------------------------------------------------------

export interface TimesheetDecisionResult {
  updated: number;
  skipped: string[];
}

/**
 * Approve or reject pending entries. Only pending → approved/rejected moves
 * (status-guarded per entry); billed entries are never touched. Records who
 * decided and when, and audits once per decision batch.
 */
export async function decideTimesheet(
  tx: Tx,
  actor: OpsActor,
  entryIds: string[],
  decision: "approved" | "rejected",
): Promise<TimesheetDecisionResult> {
  const now = new Date();
  const skipped: string[] = [];
  let updated = 0;
  for (const id of [...new Set(entryIds)]) {
    const r = await tx.opsTimeEntry.updateMany({
      where: { id, workspaceId: actor.workspaceId, approvalStatus: "pending", billed: false },
      data: { approvalStatus: decision, approvedBy: actor.userId, approvedAt: now },
    });
    if (r.count === 1) updated += 1;
    else skipped.push(id);
  }
  await auditOpsEvent(tx, OPS_ENTITY_MAP["projects"]!, actor, `timesheet_${decision}`, null, `${updated} time entr${updated === 1 ? "y" : "ies"} ${decision}${skipped.length ? ` (${skipped.length} skipped: not pending)` : ""}`);
  return { updated, skipped };
}

export async function listTimesheet(
  tx: Tx,
  actor: OpsActor,
  filter: { status?: string; userId?: string; projectId?: string } = {},
) {
  return tx.opsTimeEntry.findMany({
    where: {
      workspaceId: actor.workspaceId,
      ...(filter.status ? { approvalStatus: filter.status as "pending" | "approved" | "rejected" } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: 500,
  });
}

// ---------------------------------------------------------------------------
// Invoice unbilled time
// ---------------------------------------------------------------------------

export interface InvoiceTimeResult {
  invoice: Record<string, unknown>;
  lines: TimeInvoiceLine[];
  billedEntries: number;
  appended: boolean;
}

export async function invoiceUnbilledTime(
  tx: Tx,
  actor: OpsActor,
  projectId: string,
  opts: { invoiceId?: string } = {},
): Promise<InvoiceTimeResult> {
  const project = await tx.opsProject.findFirst({ where: { id: projectId, workspaceId: actor.workspaceId } });
  if (!project) throw new OpsNotFoundError("projects", projectId);
  const entries = await tx.opsTimeEntry.findMany({
    where: { workspaceId: actor.workspaceId, projectId, billed: false, billable: true, approvalStatus: "approved" },
    orderBy: { occurredAt: "asc" },
  });
  if (entries.length === 0) throw new OpsError(422, "No approved, unbilled time on this project");
  const people = new Map((await listWorkspacePeople(tx, actor.workspaceId)).map((p) => [p.userId, p.name]));
  const lines = timeInvoiceLines(project.name, entries, project.hourlyRateCents, (u) => (u ? people.get(u) ?? "Team member" : "Team"));
  const lineItems = lines.map(({ description, qty, priceCents }) => ({ description, qty, priceCents }));

  let invoice: Record<string, unknown>;
  let appended = false;
  const invoices = OPS_ENTITY_MAP["invoices"]!;
  if (opts.invoiceId) {
    const existing = await tx.opsInvoice.findFirst({ where: { id: opts.invoiceId, workspaceId: actor.workspaceId } });
    if (!existing) throw new OpsNotFoundError("invoices", opts.invoiceId);
    if (existing.status !== "draft") throw new OpsError(409, "Time can only be added to a draft invoice");
    const merged = [...((existing.lineItems as unknown as typeof lineItems) ?? []), ...lineItems];
    const r = await opsPatch(tx, invoices, actor, { id: existing.id, lineItems: merged });
    if (r.outcome !== "done") throw new OpsError(409, "Invoice edit needs approval — not expected for a draft");
    invoice = r.row;
    appended = true;
  } else {
    // The idempotency key is the exact entry set: a concurrent duplicate
    // resolves to the same draft, and the billed claim below fails closed.
    const key = `time:${projectId}:${createHash("sha256").update(entries.map((e) => e.id).sort().join(",")).digest("hex").slice(0, 32)}`;
    const r = await opsCreate(tx, invoices, actor, {
      ...(project.customerId ? { customerId: project.customerId } : {}),
      lineItems,
      idempotencyKey: key,
    });
    if (r.outcome !== "done") throw new OpsError(409, "Invoice draft needs approval — not expected");
    invoice = r.row;
  }

  // Claim every entry exactly once: billed=false → billed + invoice id.
  const ids = entries.map((e) => e.id);
  const claimed = await tx.opsTimeEntry.updateMany({
    where: { id: { in: ids }, workspaceId: actor.workspaceId, billed: false },
    data: { billed: true, invoiceId: String(invoice.id) },
  });
  if (claimed.count !== ids.length) {
    throw new OpsError(409, "Some of this time was billed concurrently — reload and retry");
  }
  const totalMinutes = entries.reduce((s, e) => s + e.minutes, 0);
  await auditOpsEvent(tx, OPS_ENTITY_MAP["projects"]!, actor, "time_invoiced", projectId, `${fmtMinutes(totalMinutes)} (${ids.length} entries) billed on invoice ${String(invoice.id)}${appended ? " (appended)" : ""}`);
  return { invoice, lines, billedEntries: ids.length, appended };
}
