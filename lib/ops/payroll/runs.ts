// ShapesOS — Phase 12 (people): pay runs.
//
//   draft     created with a period and a pay date (free, admin, logged)
//   computed  POST …/compute: one payslip per team member whose salary
//             assignment covers the period (the rules engine +
//             the country's tax table, YTD wage bases from this year's
//             approved/posted runs); numbered PAY-0001 the first time;
//             a digest of every payslip is stored. Recompute any time
//             before approval (it clears a pending approval request).
//   approved  POST …/approve: Tier-3 money decision — the FIRST call proposes
//             an OPS_PAYROLL_APPROVE Phase 14 approval bound to the digest
//             and the totals; a person approves it (separation of duties is
//             enforced when it's decided); the SECOND call, carrying the
//             approvalId, verifies + consumes it and freezes the run.
//   posted    POST …/post: gated OPS_PAYROLL_POST the same way; executing
//             writes ONE balanced journal entry through the Phase 10 journal
//             (lib/ops/finance/posting.ts postPayRunEntry, idempotent).
//   cancelled from draft / computed / approved (nothing was posted).
// Never automated: the agent tools only PROPOSE (lib/chat/ops-payroll-tools.ts)
// and the automation kinds are Tier 3. No money moves here — net pay is a
// liability ("Net pay payable") until someone pays it outside ShapesOS.
// The database backs every rule up (CHECKs + the lifecycle trigger).

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { canonicalize } from "@/lib/authority/approvals";
import { OpsError, OpsNotFoundError, type OpsActor } from "../doctype";
import { phase14GatePort, requestOpsApproval, verifyAndConsumeOpsApproval, type OpsGatePort, type OpsGateProposal } from "../gate";
import { nextDocumentNumber } from "../finance/numbering";
import { postPayRunEntry } from "../finance/posting";
import { fmtMoney } from "../finance/money";
import { computePayslip, parseComponents, runTotals, utcDay, type ComputedPayslip, type PayFrequency, type PayType } from "./rules";
import { payrollTaxTableFor, type FilingStatus, type YtdWages } from "./tax";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

const DAY_MS = 86_400_000;
const MAX_PERIOD_DAYS = 62;

function day(v: unknown, field: string): Date {
  const d = new Date(String(v ?? ""));
  if (Number.isNaN(d.getTime())) throw new OpsError(400, `Invalid ${field}: must be an ISO-8601 date`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function audit(tx: Tx, actor: OpsActor, id: string | null, action: string, summary: string) {
  await tx.opsAuditEvent.create({
    data: { workspaceId: actor.workspaceId, entity: "pay-runs", entityId: id, action, actor: actor.userId, summary: summary.slice(0, 2000) },
  });
}

export function payRunLabel(run: { number?: string | null; id: string }): string {
  return run.number ?? `draft ${run.id.slice(-6)}`;
}

// ---------------------------------------------------------------------------
// Create / patch (OPS_ENTITIES hooks)
// ---------------------------------------------------------------------------

export async function createPayRunRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const periodStart = day(body.periodStart, "periodStart");
  const periodEnd = day(body.periodEnd, "periodEnd");
  const payDate = day(body.payDate, "payDate");
  if (periodEnd < periodStart) throw new OpsError(400, "periodEnd must be on or after periodStart");
  if (utcDay(periodEnd) - utcDay(periodStart) + 1 > MAX_PERIOD_DAYS) throw new OpsError(400, `A pay period can be at most ${MAX_PERIOD_DAYS} days`);
  if (payDate < periodStart) throw new OpsError(400, "payDate can't be before the period starts");
  return (await tx.opsPayRun.create({
    data: {
      workspaceId: actor.workspaceId,
      periodStart,
      periodEnd,
      payDate,
      status: "draft",
      notes: (body.notes as string | undefined) ?? null,
      createdBy: actor.userId,
    },
  })) as unknown as Row;
}

export async function patchPayRunRow(tx: Tx, actor: OpsActor, id: string, patch: Row, existing: Row): Promise<Row> {
  if (existing.status === "posted" || existing.status === "cancelled") {
    throw new OpsError(409, `A ${String(existing.status)} pay run can't be edited`);
  }
  return (await tx.opsPayRun.update({ where: { id, workspaceId: actor.workspaceId }, data: { notes: (patch.notes as string | null | undefined) ?? null } })) as unknown as Row;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadPayRun(tx: Tx, workspaceId: string, id: string) {
  const run = await tx.opsPayRun.findFirst({ where: { id, workspaceId } });
  if (!run) throw new OpsNotFoundError("pay-runs", id);
  return run;
}

export async function getPayRunWithSlips(tx: Tx, workspaceId: string, id: string) {
  const run = await loadPayRun(tx, workspaceId, id);
  const payslips = await tx.opsPayslip.findMany({ where: { workspaceId, payRunId: id }, orderBy: { memberName: "asc" } });
  return { run, payslips };
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

/** sha256 over the run's period and every payslip — what an approval binds. */
export function payRunDigest(
  run: { periodStart: Date; periodEnd: Date; payDate: Date },
  slips: Array<{ memberId: string } & Pick<ComputedPayslip, "grossCents" | "preTaxDeductionCents" | "employeeTaxCents" | "postTaxDeductionCents" | "netCents" | "employerTaxCents" | "employerContribCents" | "lines">>,
): string {
  const body = {
    period: [run.periodStart.toISOString().slice(0, 10), run.periodEnd.toISOString().slice(0, 10), run.payDate.toISOString().slice(0, 10)],
    slips: [...slips]
      .sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0))
      .map((s) => ({
        m: s.memberId,
        g: s.grossCents,
        pre: s.preTaxDeductionCents,
        et: s.employeeTaxCents,
        post: s.postTaxDeductionCents,
        n: s.netCents,
        rt: s.employerTaxCents,
        rc: s.employerContribCents,
        l: s.lines.map((l) => [l.code, l.kind, l.amountCents]),
      })),
  };
  return createHash("sha256").update(canonicalize(body as unknown as Record<string, unknown>)).digest("hex");
}

/** YTD wage bases for a member from this calendar year's approved/posted runs (by pay date). */
export async function ytdWagesFor(tx: Tx, workspaceId: string, memberId: string, payDate: Date, excludeRunId: string): Promise<YtdWages> {
  const y = payDate.getUTCFullYear();
  const agg = await tx.opsPayslip.aggregate({
    where: {
      workspaceId,
      memberId,
      payRunId: { not: excludeRunId },
      payRun: { status: { in: ["approved", "posted"] }, payDate: { gte: new Date(Date.UTC(y, 0, 1)), lt: new Date(Date.UTC(y + 1, 0, 1)) } },
    },
    _sum: { ssWagesCents: true, medicareWagesCents: true, futaWagesCents: true },
  });
  return {
    ssWagesCents: agg._sum.ssWagesCents ?? 0,
    medicareWagesCents: agg._sum.medicareWagesCents ?? 0,
    futaWagesCents: agg._sum.futaWagesCents ?? 0,
  };
}

export interface ComputeResult {
  run: Awaited<ReturnType<typeof loadPayRun>>;
  payslipCount: number;
  warnings: string[];
}

export async function computePayRun(tx: Tx, actor: OpsActor, id: string): Promise<ComputeResult> {
  const ws = actor.workspaceId;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payroll-run:${ws}`}))`;
  const run = await loadPayRun(tx, ws, id);
  if (run.status !== "draft" && run.status !== "computed") {
    throw new OpsError(409, `Only a draft or computed pay run can be (re)computed — this one is ${run.status}`);
  }
  const { periodStart, periodEnd, payDate } = run;
  const assignments = await tx.opsSalaryAssignment.findMany({
    where: { workspaceId: ws, effectiveFrom: { lte: periodEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: periodStart } }] },
    include: { structure: true, member: { select: { id: true, name: true, status: true, userId: true } } },
    orderBy: [{ memberId: "asc" }, { effectiveFrom: "desc" }],
  });
  if (assignments.length === 0) throw new OpsError(422, "No one has a salary assignment covering this period — assign a salary structure first");

  // One payslip per member: the assignment in effect at the end of the period.
  const byMember = new Map<string, typeof assignments>();
  for (const a of assignments) byMember.set(a.memberId, [...(byMember.get(a.memberId) ?? []), a]);

  // Never pay the same person twice for the same days.
  const clashes = await tx.opsPayslip.findMany({
    where: {
      workspaceId: ws,
      memberId: { in: [...byMember.keys()] },
      payRunId: { not: id },
      payRun: { status: { not: "cancelled" }, periodStart: { lte: periodEnd }, periodEnd: { gte: periodStart } },
    },
    select: { memberName: true, payRun: { select: { number: true, id: true } } },
    take: 10,
  });
  if (clashes.length) {
    const list = clashes.map((c) => `${c.memberName} (${payRunLabel(c.payRun)})`).join(", ");
    throw new OpsError(409, `Already in another pay run for an overlapping period: ${list}. Cancel that run or change this period.`);
  }

  const runWarnings: string[] = [];
  const slips: Array<ComputedPayslip & { memberId: string; memberName: string; assignmentId: string; structureName: string; payType: string }> = [];
  for (const [memberId, list] of byMember) {
    const a = list[0]!; // latest effectiveFrom
    const warnings: string[] = [];
    if (list.length > 1) warnings.push("Pay changed during this period — the whole period uses the newer assignment.");
    if (a.member.status !== "active") warnings.push("This team member is inactive.");
    const s = a.structure;
    const payType = s.payType as PayType;
    let timeEntries: Array<{ minutes: number; occurredAt: Date }> = [];
    if (payType === "hourly") {
      if (!a.member.userId) warnings.push("No workspace user is linked to this team member, so no timesheet hours were found.");
      else {
        const from = new Date(Math.max(periodStart.getTime(), a.effectiveFrom.getTime()));
        const toExcl = new Date(Math.min(periodEnd.getTime(), a.effectiveTo ? a.effectiveTo.getTime() : Number.POSITIVE_INFINITY) + DAY_MS);
        timeEntries = await tx.opsTimeEntry.findMany({
          where: { workspaceId: ws, userId: a.member.userId, approvalStatus: "approved", occurredAt: { gte: from, lt: toExcl } },
          select: { minutes: true, occurredAt: true },
        });
      }
    }
    const computed = computePayslip({
      payType,
      frequency: s.payFrequency as PayFrequency,
      annualSalaryCents: a.annualSalaryCents ?? s.annualSalaryCents,
      hourlyRateCents: a.hourlyRateCents ?? s.hourlyRateCents,
      overtime: { enabled: s.overtimeEnabled, thresholdMinutes: s.overtimeThresholdMinutes, multiplierBps: s.overtimeMultiplierBps },
      components: parseComponents(s.components),
      timeEntries,
      period: { start: periodStart, end: periodEnd },
      effective: { from: a.effectiveFrom, to: a.effectiveTo },
      profile: {
        filingStatus: a.filingStatus as FilingStatus,
        w4Step2: a.w4Step2,
        dependentsCreditCents: a.dependentsCreditCents,
        otherIncomeCents: a.otherIncomeCents,
        deductionsCents: a.deductionsCents,
        extraWithholdingCents: a.extraWithholdingCents,
        stateCode: a.stateCode,
        stateRateBps: a.stateRateBps,
      },
      ytd: await ytdWagesFor(tx, ws, memberId, payDate, id),
      payDate,
      taxTable: payrollTaxTableFor(s.country, payDate),
    });
    computed.warnings.unshift(...warnings);
    slips.push({ ...computed, memberId, memberName: a.member.name, assignmentId: a.id, structureName: s.name, payType });
  }

  const totals = runTotals(slips);
  const digest = payRunDigest(run, slips);
  await tx.opsPayslip.deleteMany({ where: { workspaceId: ws, payRunId: id } });
  await tx.opsPayslip.createMany({
    data: slips.map((s) => ({
      workspaceId: ws,
      payRunId: id,
      memberId: s.memberId,
      memberName: s.memberName,
      assignmentId: s.assignmentId,
      structureName: s.structureName,
      payType: s.payType,
      regularMinutes: s.regularMinutes,
      overtimeMinutes: s.overtimeMinutes,
      grossCents: s.grossCents,
      preTaxDeductionCents: s.preTaxDeductionCents,
      taxableWagesCents: s.taxableWagesCents,
      employeeTaxCents: s.employeeTaxCents,
      postTaxDeductionCents: s.postTaxDeductionCents,
      netCents: s.netCents,
      employerTaxCents: s.employerTaxCents,
      employerContribCents: s.employerContribCents,
      ssWagesCents: s.ssWagesCents,
      medicareWagesCents: s.medicareWagesCents,
      futaWagesCents: s.futaWagesCents,
      lines: s.lines as unknown as Prisma.InputJsonValue,
      taxTable: s.taxTable,
      warnings: s.warnings as unknown as Prisma.InputJsonValue,
    })),
  });
  const number = run.number ?? (await nextDocumentNumber(tx, ws, "pay_run"));
  const moved = await tx.opsPayRun.updateMany({
    where: { id, workspaceId: ws, status: { in: ["draft", "computed"] } },
    data: {
      status: "computed",
      number,
      grossCents: totals.grossCents,
      employeeTaxCents: totals.employeeTaxCents,
      deductionCents: totals.deductionCents,
      netCents: totals.netCents,
      employerTaxCents: totals.employerTaxCents,
      employerContribCents: totals.employerContribCents,
      payslipCount: totals.payslipCount,
      computeDigest: digest,
      computedAt: new Date(),
      // A recompute invalidates any approval requested for the old numbers.
      approvalId: null,
    },
  });
  if (moved.count !== 1) throw new OpsError(409, "The pay run changed concurrently — reload");
  for (const s of slips) for (const w of s.warnings) runWarnings.push(`${s.memberName}: ${w}`);
  await audit(
    tx,
    actor,
    id,
    "compute",
    `${number} computed: ${slips.length} payslip(s), gross ${fmtMoney(totals.grossCents)}, net ${fmtMoney(totals.netCents)}, employer taxes ${fmtMoney(totals.employerTaxCents)}${run.approvalId ? " (pending approval request invalidated)" : ""}`,
  );
  return { run: await loadPayRun(tx, ws, id), payslipCount: slips.length, warnings: runWarnings };
}

// ---------------------------------------------------------------------------
// Approve + post (gated, Tier 3)
// ---------------------------------------------------------------------------

type RunRow = Awaited<ReturnType<typeof loadPayRun>>;

export const approveBinding = (r: RunRow) => ({ id: r.id, approve: true, digest: r.computeDigest, grossCents: r.grossCents, netCents: r.netCents, payslips: r.payslipCount });
export const postBinding = (r: RunRow) => ({ id: r.id, post: true, digest: r.computeDigest, grossCents: r.grossCents, netCents: r.netCents });

function runSummary(r: RunRow): string {
  const d = (x: Date) => x.toISOString().slice(0, 10);
  return `${payRunLabel(r)} for ${d(r.periodStart)} to ${d(r.periodEnd)} (pay date ${d(r.payDate)}): ${r.payslipCount} payslip(s), gross ${fmtMoney(r.grossCents)}, net pay ${fmtMoney(r.netCents)}, employee taxes ${fmtMoney(r.employeeTaxCents)}, employer taxes ${fmtMoney(r.employerTaxCents)}`;
}

export type GatedRunResult =
  | { outcome: "approval_required"; approval: OpsGateProposal }
  | { outcome: "done"; run: RunRow; journalEntryId?: string | null };

export async function approvePayRun(tx: Tx, actor: OpsActor, id: string, approvalId: string | null | undefined, port: OpsGatePort = phase14GatePort): Promise<GatedRunResult> {
  const ws = actor.workspaceId;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payroll-run:${ws}`}))`;
  const run = await loadPayRun(tx, ws, id);
  if (run.status !== "computed") throw new OpsError(409, `Only a computed pay run can be approved — this one is ${run.status}`);
  if (run.payslipCount === 0 || !run.computeDigest) throw new OpsError(422, "Compute the pay run first");
  if (!approvalId) {
    const approval = await requestOpsApproval(port, {
      workspaceId: ws,
      slug: "OPS_PAYROLL_APPROVE",
      entity: "pay-runs",
      entityId: id,
      mutation: approveBinding(run),
      actor: actor.userId,
      summary: `Approve pay run ${runSummary(run)}`,
    });
    await tx.opsPayRun.updateMany({ where: { id, workspaceId: ws, status: "computed", computeDigest: run.computeDigest }, data: { approvalId: approval.id } });
    await audit(tx, actor, id, "gate_proposed", `approval ${approval.id} requested for ${payRunLabel(run)}`);
    return { outcome: "approval_required", approval };
  }
  await verifyAndConsumeOpsApproval(port, tx, {
    workspaceId: ws,
    slug: "OPS_PAYROLL_APPROVE",
    entity: "pay-runs",
    entityId: id,
    mutation: approveBinding(run),
    approvalId,
    actor: actor.userId,
  });
  const moved = await tx.opsPayRun.updateMany({
    where: { id, workspaceId: ws, status: "computed", computeDigest: run.computeDigest },
    data: { status: "approved", approvalId, approvedBy: actor.userId, approvedAt: new Date() },
  });
  if (moved.count !== 1) throw new OpsError(409, "The pay run changed concurrently — reload");
  await audit(tx, actor, id, "gate_executed", `${payRunLabel(run)} approved (approval ${approvalId}): ${runSummary(run)}`);
  return { outcome: "done", run: await loadPayRun(tx, ws, id) };
}

export async function postPayRun(tx: Tx, actor: OpsActor, id: string, approvalId: string | null | undefined, port: OpsGatePort = phase14GatePort): Promise<GatedRunResult> {
  const ws = actor.workspaceId;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payroll-run:${ws}`}))`;
  const run = await loadPayRun(tx, ws, id);
  if (run.status === "posted") return { outcome: "done", run, journalEntryId: run.journalEntryId };
  if (run.status !== "approved") throw new OpsError(409, `Only an approved pay run can be posted — this one is ${run.status}`);
  if (!approvalId) {
    const approval = await requestOpsApproval(port, {
      workspaceId: ws,
      slug: "OPS_PAYROLL_POST",
      entity: "pay-runs",
      entityId: id,
      mutation: postBinding(run),
      actor: actor.userId,
      summary: `Post pay run to the books: ${runSummary(run)}`,
    });
    await audit(tx, actor, id, "gate_proposed", `posting approval ${approval.id} requested for ${payRunLabel(run)}`);
    return { outcome: "approval_required", approval };
  }
  await verifyAndConsumeOpsApproval(port, tx, {
    workspaceId: ws,
    slug: "OPS_PAYROLL_POST",
    entity: "pay-runs",
    entityId: id,
    mutation: postBinding(run),
    approvalId,
    actor: actor.userId,
  });
  const slips = await tx.opsPayslip.aggregate({
    where: { workspaceId: ws, payRunId: id },
    _sum: { preTaxDeductionCents: true, postTaxDeductionCents: true },
  });
  const posted = await postPayRunEntry(tx, actor, {
    ...run,
    preTaxDeductionCents: slips._sum.preTaxDeductionCents ?? 0,
    postTaxDeductionCents: slips._sum.postTaxDeductionCents ?? 0,
  });
  const moved = await tx.opsPayRun.updateMany({
    where: { id, workspaceId: ws, status: "approved" },
    data: { status: "posted", journalEntryId: posted.entry.id, postedAt: new Date() },
  });
  if (moved.count !== 1) throw new OpsError(409, "The pay run changed concurrently — reload");
  await audit(tx, actor, id, "gate_executed", `${payRunLabel(run)} posted (approval ${approvalId}): journal entry ${posted.entry.id} (${fmtMoney(posted.entry.totalCents)})`);
  return { outcome: "done", run: await loadPayRun(tx, ws, id), journalEntryId: posted.entry.id };
}

export async function cancelPayRun(tx: Tx, actor: OpsActor, id: string): Promise<RunRow> {
  const ws = actor.workspaceId;
  const run = await loadPayRun(tx, ws, id);
  if (!["draft", "computed", "approved"].includes(run.status)) throw new OpsError(409, `A ${run.status} pay run can't be cancelled`);
  const moved = await tx.opsPayRun.updateMany({ where: { id, workspaceId: ws, status: run.status }, data: { status: "cancelled" } });
  if (moved.count !== 1) throw new OpsError(409, "The pay run changed concurrently — reload");
  await audit(tx, actor, id, "cancel", `${payRunLabel(run)} cancelled (was ${run.status})`);
  return loadPayRun(tx, ws, id);
}
