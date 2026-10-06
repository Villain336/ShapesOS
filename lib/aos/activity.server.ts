// ShapesOS — live agent activity for one workspace (server only).
//
// Reads the rows the agent surfaces are drawn from — Mission (+ its
// orchestrator delegation events and pending approvals), AgentRun and
// SkillRun — inside the tenant scope (missions, agent_runs and friends are
// FORCE RLS; every query also filters by workspaceId as defense in depth),
// then derives the lead → sub-agent tree with lib/aos/agents.ts.
//
// Bounded on purpose: this runs on every dashboard render (sidebar) and on
// the sidebar's poll, so it reads only live or recent work.

import { cache } from "react";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { checkCap } from "@/lib/metering/service";
import { deriveAgentTree, type AgentRunInput, type AgentTree, type MissionInput } from "./agents";
import { runPrompt } from "./runs";
import { fromAgentRunStatus, fromSkillRunStatus, type AosStatus } from "./status";
// Phase 18.2 (WS=content): the Activity Monitor model (see the section at the end).
import { canStopProcess, orderProcesses, type CronLastRun, type ProcessRow, type ProcessSnapshot, type SystemHealth } from "./processes";
import { readDelegation } from "@/lib/agents/delegation/store";
import { delegationProgress } from "@/lib/agents/delegation/plan";

/** Phase 16: "done of total" across a run's delegation plans (null = it delegated nothing). */
export function delegationSummary(agentState: unknown): { done: number; total: number } | null {
  const d = readDelegation(agentState);
  if (!d || d.plans.length === 0) return null;
  const p = delegationProgress(d.plans.flatMap((x) => x.tasks));
  return { done: p.done, total: p.total };
}

const DAY_MS = 86_400_000;
const MAX_MISSIONS = 12;
const MAX_EVENTS = 600;
const MAX_RUNS = 30;
const MAX_SKILL_RUNS = 12;

export interface ScheduleWork {
  id: string;
  /** Skill name. */
  name: string;
  description: string;
  tools: string[];
  status: AosStatus;
  /** Latest run id, when there is one. */
  runId: string | null;
  /** Where the latest run (or the schedule) opens. */
  href: string;
  updatedAt: string;
  error: string | null;
  credits: number;
}

export interface AgentActivity {
  tree: AgentTree | null;
  /** Scheduled skills with live or recent runs. */
  schedules: ScheduleWork[];
  generatedAt: string;
}

export interface UsageMeter {
  used: number;
  cap: number;
  /** 0..100, rounded. */
  pct: number;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function planTotal(planSnapshot: unknown): number {
  const steps = (planSnapshot as { steps?: unknown } | null)?.steps;
  return Array.isArray(steps) ? steps.length : 0;
}

function missionName(goal: unknown, template: string): string {
  const label = (goal as { label?: unknown } | null)?.label;
  return typeof label === "string" && label.trim() ? label.trim() : template;
}

const TOOL_NAMES: Record<string, string> = {
  "web-search": "Web search",
  search: "Web search",
  email: "Email",
  gmail: "Email",
  calendar: "Calendar",
  "google-calendar": "Calendar",
  files: "Files",
  filesystem: "Files",
  memory: "Memory",
  code: "Code runner",
};

/** "google-search-console.query" → a user-facing chip name (best effort). */
function toolChip(declared: string): string | null {
  const head = declared.split(".")[0]!.toLowerCase();
  return TOOL_NAMES[head] ?? null;
}

export async function loadAgentActivity(workspaceId: string, now = new Date()): Promise<AgentActivity> {
  const since = new Date(now.getTime() - DAY_MS);
  return withWorkspaceScope(workspaceId, async (tx) => {
    const missions = await tx.mission.findMany({
      where: {
        workspaceId,
        OR: [{ status: { in: ["planned", "active", "paused"] } }, { status: "complete", updatedAt: { gte: since } }],
      },
      orderBy: { updatedAt: "desc" },
      take: MAX_MISSIONS,
      select: { id: true, template: true, goal: true, status: true, planSnapshot: true, createdAt: true, updatedAt: true },
    });
    const missionIds = missions.map((m) => m.id);
    const [events, approvals, runs, skillRuns] = await Promise.all([
      missionIds.length
        ? tx.missionEvent.findMany({
            where: { workspaceId, missionId: { in: missionIds } },
            orderBy: { ts: "desc" },
            take: MAX_EVENTS,
            select: { missionId: true, ts: true, actor: true, step: true, args: true, observation: true },
          })
        : Promise.resolve([]),
      missionIds.length
        ? tx.missionApproval.groupBy({
            by: ["missionId"],
            where: { workspaceId, missionId: { in: missionIds }, status: "pending" },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      tx.agentRun.findMany({
        where: {
          workspaceId,
          OR: [{ status: { in: ["queued", "running", "awaiting_confirmation"] } }, { createdAt: { gte: since } }],
        },
        orderBy: { createdAt: "desc" },
        take: MAX_RUNS,
        select: { id: true, kind: true, status: true, missionId: true, createdAt: true, endedAt: true, agentKey: true, agentState: true, parentRunId: true },
      }),
      tx.skillRun.findMany({
        where: {
          workspaceId,
          scheduleId: { not: null },
          OR: [{ status: { in: ["pending", "awaiting_approval", "approved", "running"] } }, { startedAt: { gte: since } }],
        },
        orderBy: { startedAt: "desc" },
        take: MAX_SKILL_RUNS,
        select: {
          id: true,
          scheduleId: true,
          projectId: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          error: true,
          creditsUsed: true,
          skill: { select: { name: true, description: true, declaredTools: true } },
        },
      }),
    ]);

    const pendingBy = new Map(approvals.map((a) => [a.missionId, a._count._all]));
    const eventsBy = new Map<string, MissionInput["events"]>();
    for (const e of events) {
      const list = eventsBy.get(e.missionId) ?? [];
      list.push({ ts: e.ts.toISOString(), actor: e.actor, step: e.step, args: e.args, observation: e.observation });
      eventsBy.set(e.missionId, list);
    }
    const missionInputs: MissionInput[] = missions.map((m) => ({
      id: m.id,
      name: missionName(m.goal, m.template),
      status: m.status,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
      planTotal: planTotal(m.planSnapshot),
      pendingApprovals: pendingBy.get(m.id) ?? 0,
      events: eventsBy.get(m.id) ?? [],
    }));
    const runInputs: AgentRunInput[] = runs.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      missionId: r.missionId,
      createdAt: r.createdAt.toISOString(),
      endedAt: iso(r.endedAt),
      agentKey: r.agentKey,
      task: runPrompt(r.agentState),
      // Phase 16: nest chat delegation and say how far the sub-agents are.
      parentRunId: r.parentRunId,
      delegation: delegationSummary(r.agentState),
    }));

    // One card per schedule: its latest run.
    const seen = new Set<string>();
    const schedules: ScheduleWork[] = [];
    for (const r of skillRuns) {
      if (!r.scheduleId || seen.has(r.scheduleId)) continue;
      seen.add(r.scheduleId);
      const status = fromSkillRunStatus(r.status);
      if (!status) continue;
      const tools = [...new Set(r.skill.declaredTools.map(toolChip).filter((t): t is string => !!t))].slice(0, 3);
      schedules.push({
        id: r.scheduleId,
        name: r.skill.name,
        description: r.skill.description,
        tools,
        status,
        runId: r.id,
        href: r.projectId ? `/dashboard/projects/${r.projectId}/automations/schedules/runs/${r.id}` : "/dashboard/settings/skills",
        updatedAt: (r.finishedAt ?? r.startedAt).toISOString(),
        error: r.error ? r.error.slice(0, 200) : null,
        credits: r.creditsUsed,
      });
    }

    return {
      tree: deriveAgentTree({ missions: missionInputs, runs: runInputs, now }),
      schedules,
      generatedAt: now.toISOString(),
    };
  });
}

/** Credits used this billing period against the cap (sidebar meter). Null when there is no metered pool. */
export async function loadUsageMeter(workspaceId: string): Promise<UsageMeter | null> {
  const cap = await checkCap(workspaceId);
  if (!cap.capCredits || cap.capCredits <= 0) return null;
  const pct = Math.min(100, Math.max(0, Math.round((cap.used / cap.capCredits) * 100)));
  return { used: cap.used, cap: cap.capCredits, pct };
}

/**
 * Never let the sidebar take the page down: activity is best effort.
 * Deduped per request (the layout's sidebar and the Overview share one read).
 */
export const safeAgentActivity = cache(async (workspaceId: string): Promise<AgentActivity | null> => {
  try {
    return await loadAgentActivity(workspaceId);
  } catch {
    return null;
  }
});

export const safeUsageMeter = cache(async (workspaceId: string): Promise<UsageMeter | null> => {
  try {
    return await loadUsageMeter(workspaceId);
  } catch {
    return null;
  }
});

// ===========================================================================
// Phase 18.2 (WS=content): the Activity Monitor — every process in one place.
// The same activity source as the sidebar / Home (this module), widened from
// "agent work in the last day" to every run, job, batch, sandbox and terminal
// session, with cost so far, elapsed time, budget, and who may stop it; plus
// the system-health numbers. Pure model + formatting in lib/aos/processes.ts.
// All tenant reads inside withWorkspaceScope with explicit workspaceId.
// ===========================================================================


const PROCESS_WINDOW_MS = DAY_MS;
const LIVE_RUN = ["queued", "running", "awaiting_confirmation"] as const;

export interface ProcessViewer {
  userId: string;
  /** Admin or owner: may stop anyone's process and sees the system-wide health rows. */
  isAdmin: boolean;
}

function jobStatus(status: string): ProcessRow["status"] {
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "succeeded") return "done";
  if (status === "failed" || status === "dead") return "failed";
  return null; // cancelled
}

function batchStatus(status: string): ProcessRow["status"] {
  if (status === "pending") return "queued";
  if (status === "submitted" || status === "ended") return "running";
  if (status === "delivered" || status === "direct") return "done";
  if (status === "failed") return "failed";
  return null;
}

export async function loadProcesses(workspaceId: string, viewer: ProcessViewer, now = new Date()): Promise<ProcessRow[]> {
  const since = new Date(now.getTime() - PROCESS_WINDOW_MS);
  const { loopLimitsFromEnv } = await import("@/lib/agents/loop");
  const limits = loopLimitsFromEnv();
  const data = await withWorkspaceScope(workspaceId, async (tx) => {
    const [runs, jobs, batches, sandboxes, terminals] = await Promise.all([
      tx.agentRun.findMany({
        where: { workspaceId, OR: [{ status: { in: [...LIVE_RUN] } }, { createdAt: { gte: since } }] },
        orderBy: { createdAt: "desc" },
        take: 80,
        select: { id: true, kind: true, status: true, startedBy: true, createdAt: true, endedAt: true, agentKey: true, parentRunId: true, agentState: true, missionId: true, cancelRequestedAt: true },
      }),
      tx.agentJob.findMany({
        where: { workspaceId, OR: [{ status: { in: ["queued", "running"] } }, { status: { in: ["failed", "dead"] }, updatedAt: { gte: since } }] },
        orderBy: { createdAt: "desc" },
        take: 60,
        select: { id: true, kind: true, status: true, attempts: true, maxAttempts: true, runAfter: true, heartbeatAt: true, runId: true, lastError: true, createdAt: true, finishedAt: true },
      }),
      tx.llmBatchJob.findMany({
        where: { workspaceId, OR: [{ status: { in: ["pending", "submitted", "ended"] } }, { updatedAt: { gte: since } }] },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, purpose: true, status: true, model: true, createdAt: true, deliveredAt: true, endedAt: true, updatedAt: true, lastError: true },
      }),
      tx.agentRunSandbox.findMany({
        where: { workspaceId, OR: [{ status: "active" }, { destroyedAt: { gte: since } }] },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true, runId: true, provider: true, status: true, createdAt: true, destroyedAt: true, run: { select: { startedBy: true } } },
      }),
      tx.terminalSession.findMany({
        where: { workspaceId, OR: [{ status: "active" }, { endedAt: { gte: since } }] },
        orderBy: { startedAt: "desc" },
        take: 30,
        select: { id: true, userId: true, provider: true, status: true, startedAt: true, endedAt: true, _count: { select: { commands: true } } },
      }),
    ]);
    return { runs, jobs, batches, sandboxes, terminals };
  });

  // Cost so far: the run's llm_tokens usage events (lib/llm/usage.ts evidenceRef "agent_run:<id>").
  const refs = data.runs.map((r) => `agent_run:${r.id}`);
  const costs = refs.length
    ? await withWorkspaceScope(workspaceId, (tx) =>
        tx.usageEvent.groupBy({ by: ["evidenceRef"], where: { workspaceId, evidenceRef: { in: refs } }, _sum: { llmCostMicroUsd: true } }),
      )
    : [];
  const costBy = new Map(costs.map((c) => [c.evidenceRef ?? "", Number(c._sum.llmCostMicroUsd ?? 0)]));
  const budget = { costMicroUsd: limits.maxCostMicroUsd, ms: limits.maxMs };
  const rows: ProcessRow[] = [];
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

  for (const r of data.runs) {
    const live = (LIVE_RUN as readonly string[]).includes(r.status);
    rows.push({
      key: `run:${r.id}`,
      type: "run",
      id: r.id,
      title: runPrompt(r.agentState) ?? r.kind,
      subtitle: [r.agentKey ?? "lead", r.kind].join(" · "),
      status: fromAgentRunStatus(r.status),
      state: r.cancelRequestedAt && live ? "stopping" : r.status,
      live,
      startedAt: r.createdAt.toISOString(),
      endedAt: iso(r.endedAt),
      costMicroUsd: costBy.get(`agent_run:${r.id}`) ?? 0,
      budget: r.kind === "chat" || r.kind === "mission" ? budget : null,
      startedBy: r.startedBy,
      parentKey: r.parentRunId ? `run:${r.parentRunId}` : null,
      href: `/dashboard/runs/${encodeURIComponent(r.id)}`,
      stop: canStopProcess({ live: live && !r.cancelRequestedAt, stoppable: true, startedBy: r.startedBy, viewerId: viewer.userId, viewerIsAdmin: viewer.isAdmin }),
    });
  }
  for (const j of data.jobs) {
    const live = j.status === "queued" || j.status === "running";
    // A job working on a run is stopped through its run; a queued job without
    // one is cancelled; a running one without a run can't be interrupted.
    const stoppable = !!j.runId || j.status === "queued";
    rows.push({
      key: `job:${j.id}`,
      type: "job",
      id: j.id,
      title: j.kind,
      subtitle: `${j.attempts}/${j.maxAttempts}${j.lastError ? ` · ${j.lastError.slice(0, 120)}` : ""}`,
      status: jobStatus(j.status),
      state: j.status,
      live,
      startedAt: j.createdAt.toISOString(),
      endedAt: iso(j.finishedAt),
      costMicroUsd: null,
      budget: null,
      startedBy: null,
      parentKey: j.runId ? `run:${j.runId}` : null,
      href: j.runId ? `/dashboard/runs/${encodeURIComponent(j.runId)}` : null,
      stop: canStopProcess({ live, stoppable, startedBy: null, viewerId: viewer.userId, viewerIsAdmin: viewer.isAdmin }),
    });
  }
  for (const b of data.batches) {
    const live = ["pending", "submitted", "ended"].includes(b.status);
    rows.push({
      key: `batch:${b.id}`,
      type: "batch",
      id: b.id,
      title: b.purpose,
      subtitle: [b.model, b.lastError?.slice(0, 120)].filter(Boolean).join(" · ") || null,
      status: batchStatus(b.status),
      state: b.status,
      live,
      startedAt: b.createdAt.toISOString(),
      endedAt: iso(b.deliveredAt ?? b.endedAt ?? (live ? null : b.updatedAt)),
      costMicroUsd: null,
      budget: null,
      startedBy: null,
      parentKey: null,
      href: null,
      // A submitted batch runs at the provider; it finishes or expires on its own.
      stop: canStopProcess({ live, stoppable: false, startedBy: null, viewerId: viewer.userId, viewerIsAdmin: viewer.isAdmin }),
    });
  }
  for (const s of data.sandboxes) {
    const live = s.status === "active";
    rows.push({
      key: `sandbox:${s.id}`,
      type: "sandbox",
      id: s.id,
      title: s.provider,
      subtitle: null,
      status: live ? "running" : "done",
      state: s.status,
      live,
      startedAt: s.createdAt.toISOString(),
      endedAt: iso(s.destroyedAt),
      costMicroUsd: null,
      budget: null,
      startedBy: s.run.startedBy,
      parentKey: `run:${s.runId}`,
      href: `/dashboard/runs/${encodeURIComponent(s.runId)}`,
      stop: canStopProcess({ live, stoppable: true, startedBy: s.run.startedBy, viewerId: viewer.userId, viewerIsAdmin: viewer.isAdmin }),
    });
  }
  for (const t of data.terminals) {
    const live = t.status === "active";
    rows.push({
      key: `terminal:${t.id}`,
      type: "terminal",
      id: t.id,
      title: t.provider,
      subtitle: String(t._count.commands),
      status: null, // a person's process: neutral, never an agent colour
      state: t.status,
      live,
      startedAt: t.startedAt.toISOString(),
      endedAt: iso(t.endedAt),
      costMicroUsd: null,
      budget: null,
      startedBy: t.userId,
      parentKey: null,
      href: "/dashboard/terminal",
      stop: canStopProcess({ live, stoppable: true, startedBy: t.userId, viewerId: viewer.userId, viewerIsAdmin: viewer.isAdmin }),
    });
  }
  // Scheduled jobs (cron_runs is system-wide, not tenant data: job names and
  // timings only) — admins see what is running and what failed in the window.
  if (viewer.isAdmin) {
    try {
      const { prisma } = await import("@/lib/prisma");
      const crons = await prisma.cronRun.findMany({
        where: { startedAt: { gte: since }, status: { in: ["running", "failed", "timeout"] } },
        orderBy: { startedAt: "desc" },
        take: 30,
        select: { id: true, job: true, status: true, startedAt: true, finishedAt: true, httpStatus: true, error: true },
      });
      for (const c of crons) {
        const live = c.status === "running";
        rows.push({
          key: `cron:${c.id}`,
          type: "cron",
          id: c.id,
          title: c.job,
          subtitle: [c.httpStatus ? `HTTP ${c.httpStatus}` : null, c.error?.slice(0, 120)].filter(Boolean).join(" · ") || null,
          status: null, // a scheduled job: neutral, never an agent colour
          state: c.status,
          live,
          startedAt: c.startedAt.toISOString(),
          endedAt: iso(c.finishedAt),
          costMicroUsd: null,
          budget: null,
          startedBy: null,
          parentKey: null,
          href: null,
          stop: canStopProcess({ live, stoppable: false, startedBy: null, viewerId: viewer.userId, viewerIsAdmin: viewer.isAdmin }),
        });
      }
    } catch {
      // best effort: cron_runs unavailable to this role
    }
  }
  return orderProcesses(rows);
}

export async function loadSystemHealth(workspaceId: string, viewer: ProcessViewer, now = new Date()): Promise<SystemHealth> {
  const since = new Date(now.getTime() - PROCESS_WINDOW_MS);
  const { agentWorkerMode } = await import("@/lib/agents/queue/config");
  const q = await withWorkspaceScope(workspaceId, async (tx) => {
    const [queued, oldest, dead, beat] = await Promise.all([
      // Waiting = queued and due (a retry backing off isn't waiting yet).
      tx.agentJob.count({ where: { workspaceId, status: "queued", runAfter: { lte: now } } }),
      tx.agentJob.findFirst({ where: { workspaceId, status: "queued", runAfter: { lte: now } }, orderBy: { runAfter: "asc" }, select: { runAfter: true } }),
      tx.agentJob.count({ where: { workspaceId, status: "dead", updatedAt: { gte: since } } }),
      tx.agentJob.findFirst({ where: { workspaceId, status: "running", heartbeatAt: { not: null } }, orderBy: { heartbeatAt: "desc" }, select: { heartbeatAt: true } }),
    ]);
    return { queued, oldest, dead, beat };
  });
  let cache: { cacheReadShare24h: number | null; cacheHitPct: number | null } = { cacheReadShare24h: null, cacheHitPct: null };
  try {
    const { getAiCostSpeed } = await import("@/lib/metering/ai-health");
    const ai = await getAiCostSpeed(workspaceId, { days: 1, now });
    cache = { cacheReadShare24h: ai.cacheReadShare24h, cacheHitPct: ai.cacheHitPct };
  } catch {
    // best effort
  }
  let cron: CronLastRun[] | null = null;
  let db: SystemHealth["db"] = null;
  if (viewer.isAdmin) {
    try {
      const { prisma } = await import("@/lib/prisma");
      // System-wide (cron_runs is not tenant data: job names and timings only).
      const latest = await prisma.$queryRaw<Array<{ job: string; status: string; started_at: Date; duration_ms: number | null; error: string | null }>>`
        SELECT DISTINCT ON (job) job, status::text AS status, started_at, duration_ms, error
          FROM cron_runs ORDER BY job, started_at DESC`;
      cron = latest.map((c) => ({ job: c.job, status: c.status, startedAt: c.started_at.toISOString(), durationMs: c.duration_ms, error: c.error ? c.error.slice(0, 200) : null }));
      const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`;
      const [{ max_connections }] = await prisma.$queryRaw<Array<{ max_connections: string }>>`SHOW max_connections`;
      db = { connections: n, max: Number(max_connections) };
    } catch {
      // best effort: cron table or pg_stat_activity unavailable to this role
    }
  }
  const oldestAt = q.oldest ? q.oldest.runAfter.getTime() : null;
  return {
    queueDepth: q.queued,
    oldestQueuedMs: oldestAt !== null ? Math.max(0, now.getTime() - oldestAt) : null,
    deadJobs24h: q.dead,
    lastHeartbeatMs: q.beat?.heartbeatAt ? Math.max(0, now.getTime() - q.beat.heartbeatAt.getTime()) : null,
    workerMode: agentWorkerMode(),
    cacheReadShare24h: cache.cacheReadShare24h,
    cacheHitPct: cache.cacheHitPct,
    cron,
    db,
    generatedAt: now.toISOString(),
  };
}

export async function loadProcessSnapshot(workspaceId: string, viewer: ProcessViewer, now = new Date()): Promise<ProcessSnapshot> {
  // Terminals whose sandbox idled out are closed (and metered) first, so they don't show as open.
  try {
    const { sweepIdleTerminals } = await import("@/lib/terminal/service");
    await sweepIdleTerminals(workspaceId, now);
  } catch {
    // best effort
  }
  const [processes, health] = await Promise.all([loadProcesses(workspaceId, viewer, now), loadSystemHealth(workspaceId, viewer, now)]);
  return { processes, health };
}
