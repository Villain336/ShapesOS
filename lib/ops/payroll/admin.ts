// ShapesOS — Phase 12 (people): create/patch rules for salary structures and
// salary assignments (OPS_ENTITIES hooks, lib/ops/payroll/entities.ts).
//
//   structures   components validated by the rules engine; a salary
//                structure needs no hourly rate and vice versa; the country
//                must have a registered tax table; the pay type is fixed
//                once created (assign a new structure instead).
//   assignments  the member and structure are this workspace's; ranges for
//                one member never overlap (checked under a per-member
//                advisory lock, so two concurrent creates can't both pass);
//                pay overrides follow the structure's pay type.

import type { Prisma } from "@prisma/client";
import { OpsError, OpsNotFoundError, type OpsActor } from "../doctype";
import { parseComponents, type PayType } from "./rules";
import { payrollTaxTableFor } from "./tax";
import { US_STATE_CODES } from "./tax/us-state-flat";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

function assertPayFields(payType: PayType, annual: unknown, hourly: unknown) {
  if (payType === "salary" && hourly != null) throw new OpsError(400, "A salary structure takes an annual salary, not an hourly rate");
  if (payType === "hourly" && annual != null) throw new OpsError(400, "An hourly structure takes an hourly rate, not an annual salary");
}

export async function createStructureRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const payType = body.payType as PayType;
  assertPayFields(payType, body.annualSalaryCents, body.hourlyRateCents);
  const components = parseComponents(body.components);
  const country = String(body.country ?? "US");
  payrollTaxTableFor(country, new Date()); // 422 when no table is registered
  const dup = await tx.opsSalaryStructure.findFirst({ where: { workspaceId: actor.workspaceId, name: String(body.name) }, select: { id: true } });
  if (dup) throw new OpsError(409, `A salary structure named "${String(body.name)}" already exists`);
  return (await tx.opsSalaryStructure.create({
    data: {
      workspaceId: actor.workspaceId,
      name: String(body.name),
      payType,
      payFrequency: String(body.payFrequency),
      annualSalaryCents: (body.annualSalaryCents as number | undefined) ?? null,
      hourlyRateCents: (body.hourlyRateCents as number | undefined) ?? null,
      overtimeEnabled: body.overtimeEnabled !== false,
      overtimeThresholdMinutes: Number(body.overtimeThresholdMinutes ?? 2400),
      overtimeMultiplierBps: Number(body.overtimeMultiplierBps ?? 15_000),
      components: components as unknown as Prisma.InputJsonValue,
      country,
    },
  })) as unknown as Row;
}

export async function patchStructureRow(tx: Tx, actor: OpsActor, id: string, patch: Row, existing: Row): Promise<Row> {
  const data: Row = { ...patch };
  assertPayFields(
    existing.payType as PayType,
    patch.annualSalaryCents !== undefined ? patch.annualSalaryCents : existing.annualSalaryCents,
    patch.hourlyRateCents !== undefined ? patch.hourlyRateCents : existing.hourlyRateCents,
  );
  if (patch.components !== undefined) data.components = parseComponents(patch.components) as unknown as Prisma.InputJsonValue;
  if (typeof patch.name === "string" && patch.name !== existing.name) {
    const dup = await tx.opsSalaryStructure.findFirst({ where: { workspaceId: actor.workspaceId, name: patch.name, NOT: { id } }, select: { id: true } });
    if (dup) throw new OpsError(409, `A salary structure named "${patch.name}" already exists`);
  }
  return (await tx.opsSalaryStructure.update({ where: { id, workspaceId: actor.workspaceId }, data })) as unknown as Row;
}

function day(v: unknown, field: string): Date {
  const d = new Date(String(v ?? ""));
  if (Number.isNaN(d.getTime())) throw new OpsError(400, `Invalid ${field}: must be an ISO-8601 date`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Ranges [aFrom, aTo] and [bFrom, bTo] (null = open) share a day. */
export function rangesOverlap(aFrom: Date, aTo: Date | null, bFrom: Date, bTo: Date | null): boolean {
  const aEnd = aTo ? aTo.getTime() : Number.POSITIVE_INFINITY;
  const bEnd = bTo ? bTo.getTime() : Number.POSITIVE_INFINITY;
  return aFrom.getTime() <= bEnd && bFrom.getTime() <= aEnd;
}

async function lockMember(tx: Tx, workspaceId: string, memberId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payroll-assign:${workspaceId}:${memberId}`}))`;
}

async function assertNoOverlap(tx: Tx, workspaceId: string, memberId: string, from: Date, to: Date | null, exceptId?: string) {
  const others = await tx.opsSalaryAssignment.findMany({
    where: { workspaceId, memberId, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true, effectiveFrom: true, effectiveTo: true },
  });
  const clash = others.find((o) => rangesOverlap(from, to, o.effectiveFrom, o.effectiveTo));
  if (clash) {
    throw new OpsError(
      409,
      `This overlaps the assignment from ${clash.effectiveFrom.toISOString().slice(0, 10)}${clash.effectiveTo ? ` to ${clash.effectiveTo.toISOString().slice(0, 10)}` : " (open-ended)"} — end that one first`,
    );
  }
}

function assertState(code: unknown) {
  if (code == null) return;
  if (!US_STATE_CODES.includes(String(code))) throw new OpsError(400, `Unknown state code "${String(code)}"`);
}

export async function createAssignmentRow(tx: Tx, actor: OpsActor, body: Row): Promise<Row> {
  const ws = actor.workspaceId;
  const member = await tx.opsTeamMember.findFirst({ where: { id: String(body.memberId), workspaceId: ws }, select: { id: true } });
  if (!member) throw new OpsNotFoundError("team-members", String(body.memberId));
  const structure = await tx.opsSalaryStructure.findFirst({ where: { id: String(body.structureId), workspaceId: ws } });
  if (!structure) throw new OpsNotFoundError("salary-structures", String(body.structureId));
  if (!structure.active) throw new OpsError(422, `Salary structure "${structure.name}" is inactive`);
  assertPayFields(structure.payType as PayType, body.annualSalaryCents, body.hourlyRateCents);
  assertState(body.stateCode);
  const from = day(body.effectiveFrom, "effectiveFrom");
  const to = body.effectiveTo != null ? day(body.effectiveTo, "effectiveTo") : null;
  if (to && to < from) throw new OpsError(400, "effectiveTo must be on or after effectiveFrom");
  await lockMember(tx, ws, member.id);
  await assertNoOverlap(tx, ws, member.id, from, to);
  return (await tx.opsSalaryAssignment.create({
    data: {
      workspaceId: ws,
      memberId: member.id,
      structureId: structure.id,
      effectiveFrom: from,
      effectiveTo: to,
      annualSalaryCents: (body.annualSalaryCents as number | null | undefined) ?? null,
      hourlyRateCents: (body.hourlyRateCents as number | null | undefined) ?? null,
      filingStatus: (body.filingStatus as string | undefined) ?? "single",
      w4Step2: body.w4Step2 === true,
      dependentsCreditCents: Number(body.dependentsCreditCents ?? 0),
      otherIncomeCents: Number(body.otherIncomeCents ?? 0),
      deductionsCents: Number(body.deductionsCents ?? 0),
      extraWithholdingCents: Number(body.extraWithholdingCents ?? 0),
      stateCode: (body.stateCode as string | null | undefined) ?? null,
      stateRateBps: (body.stateRateBps as number | null | undefined) ?? null,
      createdBy: actor.userId,
    },
  })) as unknown as Row;
}

export async function patchAssignmentRow(tx: Tx, actor: OpsActor, id: string, patch: Row, existing: Row): Promise<Row> {
  const ws = actor.workspaceId;
  const data: Row = { ...patch };
  const structure = await tx.opsSalaryStructure.findFirst({ where: { id: String(existing.structureId), workspaceId: ws }, select: { payType: true } });
  assertPayFields(
    (structure?.payType ?? "salary") as PayType,
    patch.annualSalaryCents !== undefined ? patch.annualSalaryCents : existing.annualSalaryCents,
    patch.hourlyRateCents !== undefined ? patch.hourlyRateCents : existing.hourlyRateCents,
  );
  assertState(patch.stateCode);
  if (patch.effectiveTo !== undefined) {
    const from = existing.effectiveFrom as Date;
    const to = patch.effectiveTo === null ? null : day(patch.effectiveTo, "effectiveTo");
    if (to && to < from) throw new OpsError(400, "effectiveTo must be on or after effectiveFrom");
    await lockMember(tx, ws, String(existing.memberId));
    await assertNoOverlap(tx, ws, String(existing.memberId), from, to, id);
    data.effectiveTo = to;
  }
  return (await tx.opsSalaryAssignment.update({ where: { id, workspaceId: ws }, data })) as unknown as Row;
}
