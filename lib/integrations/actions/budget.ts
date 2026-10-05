// Marketr — Phase 14 slice 10: Composio tool-call metering + budget guard.
//
// Composio is hosted (Marketr holds the key), so every tool call is metered
// through the existing credit ledger (action: composio_tool_call, 1 credit)
// and counted against the hosted free-tier budget. Warnings are advisory —
// they never block an approved action (the credit ledger's own caps handle
// enforcement).
//
// Phase 15 slice 4 (spec §5) adds PER-WORKSPACE call budgets below: a soft
// cap (default 80% alert, fire-once per billing month — never blocks) or a
// hard cap (executeApproved refuses fail-closed when the monthly budget is
// exhausted), plus per-toolkit cost attribution from ComposioActionLog.

import { prisma } from "@/lib/prisma";
import type { Prisma, PrismaClient } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { creditsFor } from "@/lib/metering/credits";
import { meter } from "@/lib/metering/service";
import { emitAlert } from "@/lib/alerts/evaluate";
import { BadRequestError } from "@/lib/api/errors";

type TxClient = Prisma.TransactionClient | PrismaClient;

/** Composio hosted free tier: action executions per calendar month.
 * Per PHASE14-COMPOSIO-UNIVER-SPEC.md: "free tier is genuinely usable
 * (20K calls/mo, no card)". Re-verify at build time — pricing moves fast. */
export const COMPOSIO_HOSTED_MONTHLY_FREE_CALLS = 20_000;
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
      `Overage bills to ShapesOS's hosted Composio key.`;
    void emitAlert({
      trigger: "composio_budget_warning",
      workspaceId: input.workspaceId,
      severity: budget.over ? "critical" : "warn",
      title: `Composio hosted budget ${budget.over ? "exceeded" : "past 80%"}`,
      body: `${budget.calls}/${budget.allowance} free-tier Composio calls used this month. ` +
        `Overage bills to ShapesOS's hosted Composio key.`,
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

// ─────────────────────────────────────────────────────────────────────
// Phase 15 slice 4: per-workspace call budgets + per-toolkit attribution
// (spec §5; locked: no packs — there is no pack-level attribution).
// ─────────────────────────────────────────────────────────────────────

/** Default alert threshold: warn when the workspace crosses 80% of budget. */
export const WORKSPACE_BUDGET_ALERT_THRESHOLD_PCT = 80;
/** Logs with no toolkitSlug (pre-slice rows, unresolvable tools) land here. */
export const TOOLKIT_ATTRIBUTION_UNKNOWN = "unknown";

export interface WorkspaceBudgetSettings {
  monthlyCallBudget: number | null;
  hardCap: boolean;
  alertThresholdPct: number;
  lastAlertedPct: number | null;
}

export interface SetWorkspaceBudgetInput {
  /** Monthly tool-call budget; null clears the budget (no workspace cap). */
  monthlyCallBudget?: number | null;
  /** true → hard cap: executeApproved refuses fail-closed when exhausted. */
  hardCap?: boolean;
  /** Alert threshold percent (1–100). */
  alertThresholdPct?: number;
}

const DEFAULT_WORKSPACE_BUDGET: WorkspaceBudgetSettings = {
  monthlyCallBudget: null,
  hardCap: false,
  alertThresholdPct: WORKSPACE_BUDGET_ALERT_THRESHOLD_PCT,
  lastAlertedPct: null,
};

/** Per-workspace budget settings. No row → defaults (no budget configured). */
export async function getWorkspaceBudget(workspaceId: string): Promise<WorkspaceBudgetSettings> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceActionBudget.findUnique({ where: { workspaceId } }),
  );
  if (!row) return { ...DEFAULT_WORKSPACE_BUDGET };
  return {
    monthlyCallBudget: row.monthlyCallBudget,
    hardCap: row.hardCap,
    alertThresholdPct: row.alertThresholdPct,
    lastAlertedPct: row.lastAlertedPct,
  };
}

/**
 * Create/update the workspace's Composio call budget. Fail-closed on
 * invalid config (bad input throws, never silently clamps).
 */
export async function setWorkspaceBudget(
  workspaceId: string,
  input: SetWorkspaceBudgetInput,
): Promise<WorkspaceBudgetSettings> {
  const current = await getWorkspaceBudget(workspaceId);
  const monthlyCallBudget =
    input.monthlyCallBudget === undefined ? current.monthlyCallBudget : input.monthlyCallBudget;
  const hardCap = input.hardCap === undefined ? current.hardCap : input.hardCap;
  const alertThresholdPct =
    input.alertThresholdPct === undefined ? current.alertThresholdPct : input.alertThresholdPct;
  if (monthlyCallBudget !== null) {
    if (!Number.isInteger(monthlyCallBudget) || monthlyCallBudget < 1) {
      throw new BadRequestError("monthlyCallBudget must be a positive integer or null");
    }
  }
  if (!Number.isInteger(alertThresholdPct) || alertThresholdPct < 1 || alertThresholdPct > 100) {
    throw new BadRequestError("alertThresholdPct must be an integer between 1 and 100");
  }
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceActionBudget.upsert({
      where: { workspaceId },
      create: { workspaceId, monthlyCallBudget, hardCap, alertThresholdPct },
      update: { monthlyCallBudget, hardCap, alertThresholdPct },
    }),
  );
  return {
    monthlyCallBudget: row.monthlyCallBudget,
    hardCap: row.hardCap,
    alertThresholdPct: row.alertThresholdPct,
    lastAlertedPct: row.lastAlertedPct,
  };
}

/** Executed Composio tool calls (success + failed) for the workspace this period. */
export async function countExecutedCalls(
  workspaceId: string,
  since = monthStartUtc(),
): Promise<number> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.composioActionLog.count({
      where: {
        workspaceId,
        createdAt: { gte: since },
        status: { in: ["success", "failed"] },
      },
    }),
  );
}

export interface ToolkitAttribution {
  /** Executed calls this period. */
  total: number;
  /** Executed calls per toolkitSlug ("unknown" when the log has none). */
  byToolkit: Record<string, number>;
  periodStart: string;
}

/**
 * Per-toolkit cost attribution: executed calls per billing month broken
 * down by toolkitSlug — the "HubSpot ate 40% of your calls" view.
 * Attribution sums to total (unattributed logs fall in the "unknown"
 * bucket).
 */
export async function getUsageByToolkit(
  workspaceId: string,
  since = monthStartUtc(),
): Promise<ToolkitAttribution> {
  const logs = await withWorkspaceScope(workspaceId, (tx) =>
    tx.composioActionLog.findMany({
      where: {
        workspaceId,
        createdAt: { gte: since },
        status: { in: ["success", "failed"] },
      },
      select: { toolkitSlug: true },
    }),
  );
  const byToolkit: Record<string, number> = {};
  for (const l of logs) {
    const slug = l.toolkitSlug ?? TOOLKIT_ATTRIBUTION_UNKNOWN;
    byToolkit[slug] = (byToolkit[slug] ?? 0) + 1;
  }
  return { total: logs.length, byToolkit, periodStart: since.toISOString() };
}

export interface WorkspaceBudgetCheck {
  /** Executed calls this billing month (0 when no budget configured). */
  usage: number;
  /** Monthly call budget, null when not configured. */
  budget: number | null;
  /** usage / budget as a percent (capped at 999), 0 without a budget. */
  pct: number;
  /** True exactly once per period when usage crosses the alert threshold. */
  alertDue: boolean;
  hardCap: boolean;
  /** True when a hard cap is set and the budget is exhausted. */
  blocked: boolean;
  /** Human-readable warning when over the alert threshold (soft cap). */
  warning?: string;
  periodStart: string;
}

/**
 * Workspace budget check with fire-once alert semantics. When usage
 * crosses alertThresholdPct the first time this billing month, alertDue is
 * true and the composio_workspace_budget_alert alert fires (best-effort,
 * never throws); lastAlertedPct is recorded so subsequent calls do not
 * re-fire. When usage drops back below the threshold (e.g. a new month),
 * the alert re-arms. Never throws — enforcement reads `blocked` and
 * handles the refusal; alerting must not break execution.
 */
export async function checkBudget(workspaceId: string): Promise<WorkspaceBudgetCheck> {
  const since = monthStartUtc();
  const settings = await getWorkspaceBudget(workspaceId);
  const budget = settings.monthlyCallBudget;
  if (budget == null || budget < 1) {
    return {
      usage: 0,
      budget: null,
      pct: 0,
      alertDue: false,
      hardCap: settings.hardCap,
      blocked: false,
      periodStart: since.toISOString(),
    };
  }
  const usage = await countExecutedCalls(workspaceId, since);
  const pct = Math.min(999, Math.round((usage / budget) * 100));
  const threshold = settings.alertThresholdPct;
  let alertDue = false;
  if (usage >= Math.ceil((budget * threshold) / 100)) {
    if (settings.lastAlertedPct == null || settings.lastAlertedPct < threshold) {
      alertDue = true;
      // Fire-once: record BEFORE emitting so a concurrent check cannot
      // double-fire the alert.
      await withWorkspaceScope(workspaceId, (tx) =>
        tx.workspaceActionBudget.update({
          where: { workspaceId },
          data: { lastAlertedPct: pct },
        }),
      );
      const body = `${usage}/${budget} Composio tool calls used this month (${pct}% of the workspace budget).`;
      void emitAlert({
        trigger: "composio_workspace_budget_alert",
        workspaceId,
        severity: pct >= 100 ? "critical" : "warn",
        title: `Composio call budget past ${threshold}%`,
        body,
        dedupKey: `composio-workspace-budget:${workspaceId}:${since.toISOString().slice(0, 7)}`,
      }).catch((e) => console.error("[composio] workspace budget alert failed", e instanceof Error ? e.message : e));
    }
  } else if (settings.lastAlertedPct != null) {
    // Usage dropped below the threshold (month turnover) — re-arm.
    await withWorkspaceScope(workspaceId, (tx) =>
      tx.workspaceActionBudget.update({
        where: { workspaceId },
        data: { lastAlertedPct: null },
      }),
    );
  }
  const blocked = settings.hardCap && usage >= budget;
  const overThreshold = usage >= Math.ceil((budget * threshold) / 100);
  return {
    usage,
    budget,
    pct,
    alertDue,
    hardCap: settings.hardCap,
    blocked,
    warning: overThreshold
      ? `Workspace Composio budget ${pct >= 100 ? "exhausted" : `past ${threshold}%`}: ` +
        `${usage}/${budget} tool calls used this month.`
      : undefined,
    periodStart: since.toISOString(),
  };
}
