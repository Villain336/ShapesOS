// ShapesOS — Phase 18.2 (WS=content): the Activity Monitor's model (PURE,
// client-safe). The rows come from lib/aos/activity.server.ts loadProcesses()
// — the same activity source as the sidebar and Home, extended — and the page
// and its SSE stream (app/api/activity/stream) render exactly this shape.
//
// Every process the workspace has in one list: agent runs (with their
// delegated sub-agent runs nested under them), queued/running agent jobs
// (incl. the llm_usage outbox and the llm_batch state machine), Message
// Batches, code sandboxes and terminal sessions. Status colour + shape only
// for AGENT work (runs, jobs, batches, sandboxes); a person's terminal and the
// cron jobs are neutral (DESIGN.md: colour means agent state).

import type { AosStatus } from "./status";

export type ProcessType = "run" | "job" | "batch" | "sandbox" | "terminal";

export interface ProcessRow {
  /** "<type>:<id>" — stable across refreshes. */
  key: string;
  type: ProcessType;
  id: string;
  title: string;
  subtitle: string | null;
  /** Agent work: an agent state. Null = a neutral state (terminal, finished non-agent rows). */
  status: AosStatus | null;
  /** The raw state word ("running", "cancelled", "dead", …) for neutral badges and filters. */
  state: string;
  live: boolean;
  startedAt: string;
  endedAt: string | null;
  /** Estimated model cost so far (usage events), micro-USD; null = not measured for this type. */
  costMicroUsd: number | null;
  /** The run's limits (AGENT_MAX_RUN_COST_MICRO_USD / AGENT_MAX_RUN_MINUTES). */
  budget: { costMicroUsd: number; ms: number } | null;
  startedBy: string | null;
  /** A delegated sub-agent run's lead run key. */
  parentKey: string | null;
  href: string | null;
  /** Can THIS viewer stop it, and if not, why (shown as the button's reason). */
  stop: { allowed: true } | { allowed: false; reason: "finished" | "not_yours" | "not_stoppable" };
}

export interface CronLastRun {
  job: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  error: string | null;
}

export interface SystemHealth {
  /** Agent jobs waiting (this workspace). */
  queueDepth: number;
  /** Age of the oldest waiting job, ms (null = none waiting). */
  oldestQueuedMs: number | null;
  /** Jobs that ran out of attempts in the last 24 h. */
  deadJobs24h: number;
  /** Most recent worker heartbeat on this workspace's running jobs, ms ago (null = nothing running). */
  lastHeartbeatMs: number | null;
  /** internal | external | off (lib/agents/queue/config.ts). */
  workerMode: string;
  /** Phase 17: share of prompt tokens read from the cache in the last 24 h (0..1), null = no calls. */
  cacheReadShare24h: number | null;
  /** Phase 17: calls that hit the cache (0..1). */
  cacheHitPct: number | null;
  /** Admins only (system-wide): the latest run of each cron job. */
  cron: CronLastRun[] | null;
  /** Admins only: database connections in use / allowed (cheap pg_stat_activity count). */
  db: { connections: number; max: number } | null;
  generatedAt: string;
}

export interface ProcessSnapshot {
  processes: ProcessRow[];
  health: SystemHealth;
}

/** Elapsed ms of a row at `now` (ended rows: their duration). */
export function elapsedMs(row: Pick<ProcessRow, "startedAt" | "endedAt">, now: number): number {
  const start = Date.parse(row.startedAt);
  const end = row.endedAt ? Date.parse(row.endedAt) : now;
  return Math.max(0, end - start);
}

/** "3m 12s", "1h 4m", "45s". */
export function formatElapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Micro-USD → "$0.42" (cents shown below $10, whole dollars above). */
export function formatCost(micro: number | null): string {
  if (micro === null || !Number.isFinite(micro)) return "—";
  const usd = micro / 1_000_000;
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(usd < 10 ? 2 : 0)}`;
}

/** 0..1 of the budget used (cost, else time); null without a budget. */
export function budgetUsed(row: Pick<ProcessRow, "budget" | "costMicroUsd" | "startedAt" | "endedAt">, now: number): number | null {
  if (!row.budget) return null;
  const byCost = row.costMicroUsd !== null && row.budget.costMicroUsd > 0 ? row.costMicroUsd / row.budget.costMicroUsd : 0;
  const byTime = row.budget.ms > 0 ? elapsedMs(row, now) / row.budget.ms : 0;
  return Math.min(1, Math.max(byCost, byTime));
}

/** Live first (by status priority), then the newest. Sub-agent runs follow their lead. */
export function orderProcesses(rows: ProcessRow[]): ProcessRow[] {
  const rank = (r: ProcessRow) => (r.live ? 0 : 1);
  const top = rows.filter((r) => !r.parentKey || !rows.some((p) => p.key === r.parentKey));
  top.sort((a, b) => rank(a) - rank(b) || Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const out: ProcessRow[] = [];
  const childrenOf = (key: string) =>
    rows.filter((r) => r.parentKey === key).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const visit = (r: ProcessRow, depth: number) => {
    out.push(r);
    if (depth < 4) for (const c of childrenOf(r.key)) visit(c, depth + 1);
  };
  for (const r of top) visit(r, 0);
  return out;
}

/** Who may stop a process: the person who started it, or an admin/owner. */
export function canStopProcess(input: { live: boolean; stoppable: boolean; startedBy: string | null; viewerId: string; viewerIsAdmin: boolean }): ProcessRow["stop"] {
  if (!input.live) return { allowed: false, reason: "finished" };
  if (!input.stoppable) return { allowed: false, reason: "not_stoppable" };
  if (input.viewerIsAdmin || (input.startedBy && input.startedBy === input.viewerId)) return { allowed: true };
  return { allowed: false, reason: "not_yours" };
}
