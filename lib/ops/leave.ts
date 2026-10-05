// ShapesOS Phase 10 (ops-core) — leave balances and accrual.
//
// Amounts are integer HUNDREDTHS of a day ("centidays") so half-days and
// monthly pro-rata accrual never drift through floats. A balance is COMPUTED
// from the workspace's OpsLeavePolicy (yearly entitlement accrued monthly,
// unused days carried into the next year up to a cap) and the append-only
// OpsLeaveLedger ("taken" rows posted when leave is approved, signed
// "adjustment" rows for corrections). Approving leave deducts exactly once
// (ledger row unique per leave request) and is refused when it would
// overdraw a policy-tracked balance.

import type { Prisma } from "@prisma/client";
import { OpsError, type OpsActor } from "./doctype";

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Pure maths
// ---------------------------------------------------------------------------

/** Working days (Mon–Fri) from start to end inclusive, UTC calendar days. */
export function businessDays(start: Date, end: Date): number {
  const s = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const e = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  if (e < s) return 0;
  let n = 0;
  for (let t = s; t <= e; t += 86_400_000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n += 1;
  }
  return n;
}

/**
 * Entitlement accrued in `year` up to `asOf` (inclusive of asOf's month):
 * yearlyDays / 12 per month from the later of January and the employee's
 * start month, rounded DOWN to the centiday.
 */
export function accruedCentidays(yearlyDays: number, year: number, asOf: Date, startDate: Date | null): number {
  if (asOf.getUTCFullYear() < year) return 0;
  const lastMonth = asOf.getUTCFullYear() > year ? 11 : asOf.getUTCMonth();
  let firstMonth = 0;
  if (startDate) {
    if (startDate.getUTCFullYear() > year) return 0;
    if (startDate.getUTCFullYear() === year) firstMonth = startDate.getUTCMonth();
  }
  const months = Math.max(0, lastMonth - firstMonth + 1);
  return Math.floor((yearlyDays * 100 * months) / 12);
}

export interface LedgerEntry {
  year: number;
  kind: "taken" | "adjustment";
  centidays: number;
}

export interface LeaveBalance {
  year: number;
  carriedIn: number;
  accrued: number;
  taken: number;
  adjustments: number;
  available: number;
}

/**
 * Balance for one member + leave type at `asOf`. Years before asOf accrue in
 * full; what's left (taken counted positive, adjustments signed) carries
 * forward capped at carryOverCapDays (an overdraft carries as debt).
 */
export function computeLeaveBalance(
  policy: { yearlyDays: number; carryOverCapDays: number },
  startDate: Date | null,
  ledger: LedgerEntry[],
  asOf: Date,
): LeaveBalance {
  const asOfYear = asOf.getUTCFullYear();
  const firstYear = Math.min(asOfYear, startDate ? startDate.getUTCFullYear() : asOfYear, ...ledger.map((l) => l.year));
  const cap = policy.carryOverCapDays * 100;
  let carry = 0;
  for (let y = firstYear; ; y++) {
    const rows = ledger.filter((l) => l.year === y);
    const taken = rows.filter((r) => r.kind === "taken").reduce((s, r) => s + r.centidays, 0);
    const adjustments = rows.filter((r) => r.kind === "adjustment").reduce((s, r) => s + r.centidays, 0);
    const accrued = accruedCentidays(policy.yearlyDays, y, asOf, startDate);
    const available = carry + accrued - taken + adjustments;
    if (y === asOfYear) return { year: y, carriedIn: carry, accrued, taken, adjustments, available };
    carry = Math.min(available, cap);
  }
}

export const centidaysToDays = (c: number) => Math.round(c) / 100;

// ---------------------------------------------------------------------------
// DB: balances + the approval deduction
// ---------------------------------------------------------------------------

export async function leaveBalanceFor(tx: Tx, workspaceId: string, memberId: string, type: "vacation" | "sick" | "personal", asOf = new Date()) {
  const [policy, member, ledger] = await Promise.all([
    tx.opsLeavePolicy.findFirst({ where: { workspaceId, type, active: true } }),
    tx.opsTeamMember.findFirst({ where: { id: memberId, workspaceId }, select: { startDate: true } }),
    tx.opsLeaveLedger.findMany({ where: { workspaceId, memberId, type }, select: { year: true, kind: true, centidays: true } }),
  ]);
  if (!policy || typeof policy.yearlyDays !== "number") return null;
  return computeLeaveBalance(policy, member?.startDate ? new Date(member.startDate) : null, ledger ?? [], asOf);
}

/** Balances for every active policy × member (the Team view). */
export async function leaveBalances(tx: Tx, workspaceId: string, asOf = new Date()) {
  const [policies, members, ledger] = await Promise.all([
    tx.opsLeavePolicy.findMany({ where: { workspaceId, active: true } }),
    tx.opsTeamMember.findMany({ where: { workspaceId, status: "active" }, select: { id: true, name: true, startDate: true }, take: 1000 }),
    tx.opsLeaveLedger.findMany({ where: { workspaceId }, select: { memberId: true, type: true, year: true, kind: true, centidays: true } }),
  ]);
  return members.map((m) => ({
    memberId: m.id,
    name: m.name,
    balances: policies.map((p) => ({
      type: p.type,
      ...computeLeaveBalance(p, m.startDate, ledger.filter((l) => l.memberId === m.id && l.type === p.type), asOf),
    })),
  }));
}

/**
 * Called by the leave-request approval (lib/ops/doctype.ts) in the same
 * transaction as the status move: posts ONE "taken" ledger row (unique per
 * request) and refuses to overdraw a policy-tracked balance.
 */
export async function deductApprovedLeave(tx: Tx, actor: OpsActor, request: Record<string, unknown>): Promise<void> {
  const start = new Date(String(request.startDate));
  const end = new Date(String(request.endDate));
  const type = request.type as "vacation" | "sick" | "personal";
  const days = businessDays(start, end) * 100;
  if (days === 0) return;
  const balance = await leaveBalanceFor(tx, actor.workspaceId, String(request.memberId), type, start);
  if (balance && balance.available < days) {
    throw new OpsError(422, `Not enough ${type} balance: ${centidaysToDays(days)} day(s) requested, ${centidaysToDays(balance.available)} available`);
  }
  await tx.opsLeaveLedger.create({
    data: {
      workspaceId: actor.workspaceId,
      memberId: String(request.memberId),
      type,
      year: start.getUTCFullYear(),
      kind: "taken",
      centidays: days,
      leaveRequestId: String(request.id),
      note: `approved leave ${String(request.id)}`,
      actor: actor.userId,
    },
  });
}
