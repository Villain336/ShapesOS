// Marketr — Wave 2 context.dev slice 1: DB-backed daily budget store.
//
// One ContextDevBudget row per workspace per UTC day; a new day's row starts
// with the latest earlier day's cap (a configured cap carries forward).
// checkAndReserve is the gate every Context.dev call passes BEFORE the API is hit. The reserve is
// ONE conditional UPDATE (credits_used + cost <= cap_credits): N concurrent
// calls can never all see headroom and overshoot the cap. Today's row is
// created first with INSERT … ON CONFLICT DO NOTHING, so concurrent
// first-of-day calls don't race a create (no P2002).

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { decideBudget, DEFAULT_DAILY_CAP_CREDITS, type BudgetVerdict } from "./budgets";
import { contextDevKeySource } from "./keys";
import { CONTEXTDEV_PLATFORM_CREDITS_PER_VENDOR_CREDIT } from "@/lib/metering/credits";

/** Phase 15.1: meter a platform-key Context.dev call (no-op on the workspace's own key). */
async function chargePlatformContextDev(
  workspaceId: string,
  vendorCredits: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (vendorCredits <= 0) return { ok: true };
  if ((await contextDevKeySource(workspaceId)) !== "platform") return { ok: true };
  const { meter } = await import("@/lib/metering/service");
  const r = await meter({
    workspaceId,
    action: "contextdev_call",
    credits: vendorCredits * CONTEXTDEV_PLATFORM_CREDITS_PER_VENDOR_CREDIT,
    keySource: "platform",
    idempotencyKey: `contextdev:${workspaceId}:${randomUUID()}`,
    evidenceRef: `contextdev:${vendorCredits}`,
  });
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

/** UTC day key: YYYY-MM-DD. */
export function todayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export interface DailyBudget {
  day: string;
  usedToday: number;
  capCredits: number;
}

/**
 * The cap a day without its own row starts with: the most recent earlier
 * day's cap (a configured cap carries forward), else the default. Without
 * this every new UTC day silently reset a configured cap to the default.
 */
export async function carriedCap(workspaceId: string, day: string = todayKey()): Promise<number> {
  const prev = await prisma.contextDevBudget.findFirst({
    where: { workspaceId, day: { lt: day } },
    orderBy: { day: "desc" },
    select: { capCredits: true },
  });
  return prev?.capCredits ?? DEFAULT_DAILY_CAP_CREDITS;
}

export async function getDailyBudget(workspaceId: string, day: string = todayKey()): Promise<DailyBudget> {
  const row = await prisma.contextDevBudget.findUnique({
    where: { workspaceId_day: { workspaceId, day } },
    select: { creditsUsed: true, capCredits: true },
  });
  return {
    day,
    usedToday: row?.creditsUsed ?? 0,
    capCredits: row ? row.capCredits : await carriedCap(workspaceId, day),
  };
}

/** Set (or change) the workspace's daily cap. Applies from today forward (later days carry it). */
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
  // Today's row exists before we reserve against it, seeded with the cap a
  // missing row reads as in getDailyBudget: the latest earlier day's cap
  // (carried forward), else the default.
  await prisma.$executeRaw`
    INSERT INTO context_dev_budgets (id, workspace_id, day, credits_used, cap_credits, created_at, updated_at)
    SELECT ${randomUUID()}, ${workspaceId}, ${day}, 0,
           COALESCE(
             (SELECT prev.cap_credits FROM context_dev_budgets prev
               WHERE prev.workspace_id = ${workspaceId} AND prev.day < ${day}
               ORDER BY prev.day DESC LIMIT 1),
             ${DEFAULT_DAILY_CAP_CREDITS}),
           now(), now()
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
    // Phase 15.1: a call on the PLATFORM key is charged in credits here, at
    // the gate, before the vendor is asked (a capped workspace is refused and
    // its daily reservation released). The workspace's own key is free.
    const charge = await chargePlatformContextDev(workspaceId, estimatedCost);
    if (!charge.ok) {
      await prisma.$executeRaw`
        UPDATE context_dev_budgets
           SET credits_used = GREATEST(0, credits_used - ${estimatedCost}), updated_at = now()
         WHERE workspace_id = ${workspaceId} AND day = ${day}`;
      const after = await getDailyBudget(workspaceId, day);
      return {
        decision: "needs_approval",
        reason: charge.message,
        remainingAfter: Math.max(0, after.capCredits - after.usedToday),
        budget: after,
      };
    }
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
