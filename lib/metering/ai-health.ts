// ShapesOS — Phase 17 (observability, WS=model): AI cost & speed.
//
// Read from the SAME ledger that bills model calls — usage_events rows with
// action "llm_tokens" (lib/llm/usage.ts → meter()), which carry the tokens,
// the estimated vendor cost and (Phase 17) ttft / duration / effort / cache
// hit / service tier. No parallel table. Powers:
//   * Settings → Usage → "AI cost & speed" (GET /api/usage/ai): cost per day,
//     cache-hit %, cache-read share, p50/p95 time to first token, the most
//     expensive runs;
//   * the cache-health alert (POST /api/cron/ai-cache-health, hourly): when
//     the last 24 h's cache-read share drops below CACHE_SHARE_ALERT (60%) on
//     enough traffic to mean something, the workspace's admins get one
//     notification per day (a cache breaker shipped, or the prefix changed).

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

/** Below this 24h cache-read share the workspace's admins are told (owner, 2026-10-05: 60%). */
export const CACHE_SHARE_ALERT = 0.6;
/** The alert needs this much traffic in the window (a quiet workspace's first call always misses). */
export const CACHE_ALERT_MIN_CALLS = 10;
export const CACHE_ALERT_MIN_INPUT_TOKENS = 50_000;

export interface AiCostDay {
  /** UTC date, YYYY-MM-DD. */
  day: string;
  calls: number;
  costMicroUsd: number;
}

export interface AiExpensiveRun {
  runId: string;
  costMicroUsd: number;
  calls: number;
  kind: string | null;
  agentKey: string | null;
  label: string | null;
  createdAt: string | null;
}

export interface AiCostSpeed {
  days: number;
  calls: number;
  costMicroUsd: number;
  perDay: AiCostDay[];
  /** Share of calls that read the prompt cache (cache_read > 0); null without calls. */
  cacheHitPct: number | null;
  /** cache_read / (uncached input + cache_read + cache_write) tokens; null without input. */
  cacheReadShare: number | null;
  /** The same share over the last 24 hours (what the alert watches). */
  cacheReadShare24h: number | null;
  /** Time to first token (streamed calls), ms. */
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
  byModel: Array<{ model: string; calls: number; costMicroUsd: number; cacheHitPct: number | null }>;
  topRuns: AiExpensiveRun[];
}

const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(num(v)));

/** Share of input tokens served from the cache. PURE. */
export function cacheReadShare(t: { input: number; cacheRead: number; cacheWrite: number }): number | null {
  const total = t.input + t.cacheRead + t.cacheWrite;
  return total > 0 ? t.cacheRead / total : null;
}

/** Should the cache-health alert fire? PURE. */
export function cacheAlertDue(t: { calls: number; input: number; cacheRead: number; cacheWrite: number }): boolean {
  const total = t.input + t.cacheRead + t.cacheWrite;
  if (t.calls < CACHE_ALERT_MIN_CALLS || total < CACHE_ALERT_MIN_INPUT_TOKENS) return false;
  const share = cacheReadShare(t);
  return share !== null && share < CACHE_SHARE_ALERT;
}

async function tokenTotals(workspaceId: string, since: Date) {
  const rows = await prisma.$queryRaw<Array<{ calls: bigint; input: bigint | null; read: bigint | null; write: bigint | null }>>`
    SELECT COUNT(*) AS calls,
           SUM(COALESCE("llm_input_tokens", 0)) AS input,
           SUM(COALESCE("llm_cache_read_tokens", 0)) AS read,
           SUM(COALESCE("llm_cache_write_tokens", 0)) AS write
    FROM "usage_events"
    WHERE "workspace_id" = ${workspaceId} AND "action" = 'llm_tokens' AND "occurred_at" >= ${since}`;
  const r = rows[0];
  return { calls: num(r?.calls), input: num(r?.input), cacheRead: num(r?.read), cacheWrite: num(r?.write) };
}

/** The "AI cost & speed" numbers for one workspace over the last `days` days. */
export async function getAiCostSpeed(workspaceId: string, opts: { days?: number; now?: Date } = {}): Promise<AiCostSpeed> {
  const days = Math.max(1, Math.min(90, Math.floor(opts.days ?? 14)));
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const since24h = new Date(now.getTime() - 86_400_000);
  const where = Prisma.sql`"workspace_id" = ${workspaceId} AND "action" = 'llm_tokens' AND "occurred_at" >= ${since}`;

  const [perDayRows, statRows, byModelRows, runRows, totals, totals24h] = await Promise.all([
    prisma.$queryRaw<Array<{ day: string; calls: bigint; cost: bigint | null }>>`
      SELECT to_char(date_trunc('day', "occurred_at"), 'YYYY-MM-DD') AS day,
             COUNT(*) AS calls, SUM(COALESCE("llm_cost_micro_usd", 0)) AS cost
      FROM "usage_events" WHERE ${where}
      GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<Array<{ calls: bigint; cost: bigint | null; hits: bigint; hit_known: bigint; ttft50: number | null; ttft95: number | null; dur50: number | null; dur95: number | null }>>`
      SELECT COUNT(*) AS calls,
             SUM(COALESCE("llm_cost_micro_usd", 0)) AS cost,
             COUNT(*) FILTER (WHERE COALESCE("llm_cache_read_tokens", 0) > 0) AS hits,
             COUNT(*) FILTER (WHERE "llm_input_tokens" IS NOT NULL) AS hit_known,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY "llm_ttft_ms") FILTER (WHERE "llm_ttft_ms" IS NOT NULL) AS ttft50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY "llm_ttft_ms") FILTER (WHERE "llm_ttft_ms" IS NOT NULL) AS ttft95,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY "llm_duration_ms") FILTER (WHERE "llm_duration_ms" IS NOT NULL) AS dur50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY "llm_duration_ms") FILTER (WHERE "llm_duration_ms" IS NOT NULL) AS dur95
      FROM "usage_events" WHERE ${where}`,
    prisma.$queryRaw<Array<{ model: string | null; calls: bigint; cost: bigint | null; hits: bigint }>>`
      SELECT "llm_model" AS model, COUNT(*) AS calls, SUM(COALESCE("llm_cost_micro_usd", 0)) AS cost,
             COUNT(*) FILTER (WHERE COALESCE("llm_cache_read_tokens", 0) > 0) AS hits
      FROM "usage_events" WHERE ${where}
      GROUP BY 1 ORDER BY 3 DESC LIMIT 10`,
    prisma.$queryRaw<Array<{ ref: string; calls: bigint; cost: bigint | null }>>`
      SELECT "evidence_ref" AS ref, COUNT(*) AS calls, SUM(COALESCE("llm_cost_micro_usd", 0)) AS cost
      FROM "usage_events" WHERE ${where} AND "evidence_ref" LIKE 'agent_run:%'
      GROUP BY 1 ORDER BY 3 DESC LIMIT 5`,
    tokenTotals(workspaceId, since),
    tokenTotals(workspaceId, since24h),
  ]);

  const stat = statRows[0];
  const calls = num(stat?.calls);
  const runIds = runRows.map((r) => r.ref.slice("agent_run:".length));
  const runs = runIds.length
    ? await withWorkspaceScope(workspaceId, (tx) =>
        tx.agentRun.findMany({
          where: { workspaceId, id: { in: runIds } },
          select: { id: true, kind: true, agentKey: true, agentState: true, createdAt: true },
        }),
      ).catch(() => [])
    : [];
  const byId = new Map(runs.map((r) => [r.id, r]));

  return {
    days,
    calls,
    costMicroUsd: num(stat?.cost),
    perDay: perDayRows.map((r) => ({ day: r.day, calls: num(r.calls), costMicroUsd: num(r.cost) })),
    cacheHitPct: num(stat?.hit_known) > 0 ? num(stat?.hits) / num(stat?.hit_known) : null,
    cacheReadShare: cacheReadShare(totals),
    cacheReadShare24h: cacheReadShare(totals24h),
    ttftP50Ms: numOrNull(stat?.ttft50),
    ttftP95Ms: numOrNull(stat?.ttft95),
    durationP50Ms: numOrNull(stat?.dur50),
    durationP95Ms: numOrNull(stat?.dur95),
    byModel: byModelRows.map((r) => ({
      model: r.model ?? "unknown",
      calls: num(r.calls),
      costMicroUsd: num(r.cost),
      cacheHitPct: num(r.calls) > 0 ? num(r.hits) / num(r.calls) : null,
    })),
    topRuns: runRows.map((r) => {
      const id = r.ref.slice("agent_run:".length);
      const run = byId.get(id);
      const state = (run?.agentState ?? null) as { prompt?: unknown; task?: unknown; skill?: unknown } | null;
      const label = typeof state?.prompt === "string" ? state.prompt : typeof state?.task === "string" ? state.task : typeof state?.skill === "string" ? state.skill : null;
      return {
        runId: id,
        costMicroUsd: num(r.cost),
        calls: num(r.calls),
        kind: run?.kind ?? null,
        agentKey: run?.agentKey ?? null,
        label: label ? label.slice(0, 120) : null,
        createdAt: run?.createdAt?.toISOString() ?? null,
      };
    }),
  };
}

/** Workspaces with model calls in the last 24 h (the cron's sweep list). */
export async function workspacesWithLlmCalls(now: Date = new Date()): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ workspace_id: string }>>`
    SELECT DISTINCT "workspace_id" FROM "usage_events"
    WHERE "action" = 'llm_tokens' AND "occurred_at" >= ${new Date(now.getTime() - 86_400_000)}
    LIMIT 1000`;
  return rows.map((r) => r.workspace_id);
}

export interface CacheHealthResult {
  workspaceId: string;
  share24h: number | null;
  calls24h: number;
  alerted: boolean;
}

/** Check one workspace's last 24 h and notify its admins (once per UTC day) when the share is low. */
export async function sweepCacheHealth(workspaceId: string, now: Date = new Date()): Promise<CacheHealthResult> {
  const t = await tokenTotals(workspaceId, new Date(now.getTime() - 86_400_000));
  const share = cacheReadShare(t);
  if (!cacheAlertDue(t)) return { workspaceId, share24h: share, calls24h: t.calls, alerted: false };
  const { notifyCacheShareLow } = await import("@/lib/notifications/producers");
  const created = await notifyCacheShareLow({ workspaceId, share: share ?? 0, calls: t.calls, day: now.toISOString().slice(0, 10) });
  return { workspaceId, share24h: share, calls24h: t.calls, alerted: created > 0 };
}
