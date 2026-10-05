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
import { fromSkillRunStatus, type AosStatus } from "./status";

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
        select: { id: true, kind: true, status: true, missionId: true, createdAt: true, endedAt: true, agentKey: true, agentState: true },
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
