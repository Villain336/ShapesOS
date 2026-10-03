// Marketr — Wave 2 context.dev slice 1: DB-backed daily budget store.
//
// One ContextDevBudget row per workspace per UTC day. checkAndReserve is the
// gate every Context.dev call passes BEFORE the API is hit. The reserve is
// ONE conditional UPDATE (credits_used + cost <= cap_credits): N concurrent
// calls can never all see headroom and overshoot the cap. Today's row is
// created first with INSERT … ON CONFLICT DO NOTHING, so concurrent
// first-of-day calls don't race a create (no P2002).

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { decideBudget, DEFAULT_DAILY_CAP_CREDITS, type BudgetVerdict } from "./budgets";

/** UTC day key: YYYY-MM-DD. */
export function todayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export interface DailyBudget {
  day: string;
  usedToday: number;
  capCredits: number;
}

export async function getDailyBudget(workspaceId: string, day: string = todayKey()): Promise<DailyBudget> {
  const row = await prisma.contextDevBudget.findUnique({
    where: { workspaceId_day: { workspaceId, day } },
    select: { creditsUsed: true, capCredits: true },
  });
  return {
    day,
    usedToday: row?.creditsUsed ?? 0,
    capCredits: row?.capCredits ?? DEFAULT_DAILY_CAP_CREDITS,
  };
}

/** Set (or change) the workspace's daily cap. Applies from today forward. */
export async function setDailyCap(workspaceId: string, capCredits: number): Promise<DailyBudget> {
  if (!Number.isInteger(capCredits) || capCredits < 0) {
    throw new Error("contextdev: capCredits must be a non-negative integer");
  }
  const day = todayKey();
  const row = await prisma.contextDevBudget.upsert({
    where: { workspaceId_day: { workspaceId, day } },
    update: { capCredits },
    create: { workspaceId, day, creditsUsed: 0, capCredits },
    select: { creditsUsed: true, capCredits: true },
  });
  return { day, usedToday: row.creditsUsed, capCredits: row.capCredits };
}

export interface ReserveResult extends BudgetVerdict {
  budget: DailyBudget;
}

/**
 * Gate a Context.dev call: decide against today's budget, and charge the
 * estimated cost only when the verdict is "allow". Returns the verdict plus
 * the post-decision budget snapshot.
 */
export async function checkAndReserve(
  workspaceId: string,
  estimatedCost: number,
): Promise<ReserveResult> {
  const day = todayKey();
  // Bad math never reaches SQL: the pure gate turns it into needs_approval.
  if (!Number.isInteger(estimatedCost) || estimatedCost < 0) {
    const before = await getDailyBudget(workspaceId, day);
    const verdict = decideBudget({ usedToday: before.usedToday, capCredits: before.capCredits }, estimatedCost);
    return {
      ...(verdict.decision === "allow"
        ? { decision: "needs_approval" as const, reason: "Estimated cost is not a whole number of credits — approval required", remainingAfter: verdict.remainingAfter }
        : verdict),
      budget: before,
    };
  }
  // Today's row exists before we reserve against it (same default cap a
  // missing row reads as in getDailyBudget).
  await prisma.$executeRaw`
    INSERT INTO context_dev_budgets (id, workspace_id, day, credits_used, cap_credits, created_at, updated_at)
    VALUES (${randomUUID()}, ${workspaceId}, ${day}, 0, ${DEFAULT_DAILY_CAP_CREDITS}, now(), now())
    ON CONFLICT (workspace_id, day) DO NOTHING`;
  // The reserve: check and charge in one statement (row-locked by UPDATE).
  const reserved = await prisma.$queryRaw<Array<{ creditsUsed: number; capCredits: number }>>`
    UPDATE context_dev_budgets
       SET credits_used = credits_used + ${estimatedCost}, updated_at = now()
     WHERE workspace_id = ${workspaceId} AND day = ${day}
       AND cap_credits > 0 AND credits_used + ${estimatedCost} <= cap_credits
    RETURNING credits_used AS "creditsUsed", cap_credits AS "capCredits"`;
  const row = reserved[0];
  if (row) {
    return {
      decision: "allow",
      reason: "Within today's budget",
      remainingAfter: row.capCredits - row.creditsUsed,
      budget: { day, usedToday: row.creditsUsed, capCredits: row.capCredits },
    };
  }
  // Not reserved: explain against the current snapshot (always needs_approval —
  // the conditional UPDATE is the authority, not this read).
  const after = await getDailyBudget(workspaceId, day);
  const verdict = decideBudget({ usedToday: after.usedToday, capCredits: after.capCredits }, estimatedCost);
  return {
    ...(verdict.decision === "allow"
      ? { decision: "needs_approval" as const, reason: `This call (${estimatedCost} credits) would exceed today's budget — approval required`, remainingAfter: verdict.remainingAfter }
      : verdict),
    budget: after,
  };
}
