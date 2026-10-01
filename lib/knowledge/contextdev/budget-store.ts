// Marketr — Wave 2 context.dev slice 1: DB-backed daily budget store.
//
// One ContextDevBudget row per workspace per UTC day. recordSpend increments
// atomically (upsert + increment) so concurrent calls cannot double-spend
// the budget. checkAndReserve is the gate every Context.dev call passes
// BEFORE the API is hit: it returns the pure decideBudget verdict, and only
// charges when the verdict is "allow".

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
  const before = await getDailyBudget(workspaceId, day);
  const verdict = decideBudget({ usedToday: before.usedToday, capCredits: before.capCredits }, estimatedCost);
  if (verdict.decision !== "allow") {
    return { ...verdict, budget: before };
  }
  const row = await prisma.contextDevBudget.upsert({
    where: { workspaceId_day: { workspaceId, day } },
    update: { creditsUsed: { increment: estimatedCost } },
    create: { workspaceId, day, creditsUsed: estimatedCost, capCredits: before.capCredits },
    select: { creditsUsed: true, capCredits: true },
  });
  return {
    ...verdict,
    budget: { day, usedToday: row.creditsUsed, capCredits: row.capCredits },
  };
}
