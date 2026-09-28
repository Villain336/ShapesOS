// Marketr — Phase 14 slice 10: Composio tool-call metering + budget guard.
//
// Composio is hosted (Marketr holds the key), so every tool call is metered
// through the existing credit ledger (action: composio_tool_call, 1 credit)
// and counted against the hosted free-tier budget. Warnings are advisory —
// they never block an approved action (the credit ledger's own caps handle
// enforcement).

import { prisma } from "@/lib/prisma";
import type { Prisma, PrismaClient } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { creditsFor } from "@/lib/metering/credits";
import { meter } from "@/lib/metering/service";
import { emitAlert } from "@/lib/alerts/evaluate";

type TxClient = Prisma.TransactionClient | PrismaClient;

/** Composio hosted free tier: action executions per calendar month. */
export const COMPOSIO_HOSTED_MONTHLY_FREE_CALLS = 1000;
/** Warn when the platform crosses this share of the free tier. */
export const BUDGET_WARN_RATIO = 0.8;

export function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** "2026-09" — the ComposioPlatformUsage primary key. */
export function periodKeyUtc(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export interface ComposioUsage {
  /** Executed calls (success + failed) in the period. */
  calls: number;
  byApp: Record<string, number>;
  byStatus: Record<string, number>;
  /** Ledger credits attributable to these calls. */
  credits: number;
  periodStart: string;
}

/** Per-workspace Composio usage for the current calendar month. */
export async function getComposioUsage(workspaceId: string, since = monthStartUtc()): Promise<ComposioUsage> {
  const logs = await withWorkspaceScope(workspaceId, (tx) =>
    tx.composioActionLog.findMany({
      where: {
        workspaceId,
        createdAt: { gte: since },
        status: { in: ["success", "failed"] },
      },
      select: { appKey: true, status: true },
    }),
  );
  const byApp: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const l of logs) {
    byApp[l.appKey] = (byApp[l.appKey] ?? 0) + 1;
    byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
  }
  return {
    calls: logs.length,
    byApp,
    byStatus,
    credits: logs.length * creditsFor("composio_tool_call"),
    periodStart: since.toISOString(),
  };
}

/**
 * Platform-wide executed calls this month. Reads the ComposioPlatformUsage
 * counter (a direct count on composio_action_logs is impossible — FORCE RLS
 * hides every row from sessions without a workspace scope).
 */
export async function getPlatformComposioCalls(now = new Date()): Promise<number> {
  const row = await prisma.composioPlatformUsage.findUnique({
    where: { periodKey: periodKeyUtc(now) },
    select: { calls: true },
  });
  return row?.calls ?? 0;
}

/**
 * Atomically bump the platform counter. Runs inside the caller's (workspace-
 * scoped) transaction — the counter table has no RLS, so the GUC is harmless.
 * Only executed calls (success/failed) are counted.
 */
export async function bumpPlatformComposioCalls(tx: TxClient, now = new Date()): Promise<void> {
  const periodKey = periodKeyUtc(now);
  await tx.composioPlatformUsage.upsert({
    where: { periodKey },
    create: { periodKey, calls: 1 },
    update: { calls: { increment: 1 } },
  });
}

export interface BudgetCheck {
  calls: number;
  allowance: number;
  pct: number;
  warn: boolean;
  over: boolean;
  periodStart: string;
}

/**
 * Platform budget check. Advisory only — callers surface the warning, they
 * never block on it.
 */
export async function checkComposioBudget(): Promise<BudgetCheck> {
  const since = monthStartUtc();
  const calls = await getPlatformComposioCalls(since);
  const allowance = COMPOSIO_HOSTED_MONTHLY_FREE_CALLS;
  const pct = Math.min(999, Math.round((calls / allowance) * 100));
  return {
    calls,
    allowance,
    pct,
    warn: calls >= allowance * BUDGET_WARN_RATIO,
    over: calls >= allowance,
    periodStart: since.toISOString(),
  };
}

/**
 * Advisory pre-execution budget warning. Returns the warning text when the
 * hosted free-tier budget is past 80% (or exceeded), and fires the
 * composio_budget_warning alert. Never throws — a failed check must not
 * block an action.
 */
export async function getComposioBudgetWarning(input: {
  workspaceId: string;
  toolName: string;
}): Promise<string | undefined> {
  try {
    const budget = await checkComposioBudget();
    if (!budget.warn) return undefined;
    const warning =
      `Composio hosted budget ${budget.over ? "exceeded" : "past 80%"}: ` +
      `${budget.calls}/${budget.allowance} free-tier calls used this month. ` +
      `Overage bills to Marketr's hosted Composio key.`;
    void emitAlert({
      trigger: "composio_budget_warning",
      workspaceId: input.workspaceId,
      severity: budget.over ? "critical" : "warn",
      title: `Composio hosted budget ${budget.over ? "exceeded" : "past 80%"}`,
      body: `${budget.calls}/${budget.allowance} free-tier Composio calls used this month. ` +
        `Overage bills to Marketr's hosted Composio key.`,
      dedupKey: `composio-budget:${budget.periodStart.slice(0, 7)}`,
    }).catch((e) => console.error("[composio] budget alert failed", e instanceof Error ? e.message : e));
    return warning;
  } catch (e) {
    console.error("[composio] budget check failed (non-blocking)", e instanceof Error ? e.message : e);
    return undefined;
  }
}

/**
 * Meter one executed Composio call through the credit ledger. Never throws —
 * metering must not break the audit log write it follows.
 */
export async function meterComposioCall(input: {
  workspaceId: string;
  logId: string;
  executedBy: string;
}): Promise<void> {
  try {
    await meter({
      workspaceId: input.workspaceId,
      actorId: input.executedBy.startsWith("agent:") ? null : input.executedBy,
      action: "composio_tool_call",
      idempotencyKey: `composio-log:${input.logId}`,
      evidenceRef: `composio_action_logs/${input.logId}`,
    });
  } catch (e) {
    console.error("[composio] metering failed (non-blocking)", e instanceof Error ? e.message : e);
  }
}
