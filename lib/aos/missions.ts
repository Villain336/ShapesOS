// ShapesOS — a loaded mission as agent work (pure; no prisma).
//
// The mission API (app/api/missions) already loads each mission's
// orchestrator timeline and approvals. This turns that into the same
// MissionView the Overview and sidebar derive (lib/aos/agents.ts), so the
// missions list and detail draw the identical state: status band, one-line
// state, the sub-agents the lead delegated to, and the lead node on top.

import { LEAD_AGENT, deriveMission, monogram, type AgentNode, type AgentRunInput, type MissionInput, type MissionView } from "./agents";

export interface LoadedMissionLike {
  mission: {
    id: string;
    template: string;
    goal: Record<string, unknown>;
    status: string;
    planSnapshot: Record<string, unknown>;
    createdAt: Date | string;
    updatedAt: Date | string;
  };
  events: Array<{ ts: Date | string; actor: string; step: string | null; args: unknown; observation: unknown }>;
  approvals: Array<{ status: string }>;
}

function isoOf(d: Date | string): string {
  return typeof d === "string" ? d : d.toISOString();
}

export function missionDisplayName(goal: unknown, template: string): string {
  const label = (goal as { label?: unknown } | null)?.label;
  return typeof label === "string" && label.trim() ? label.trim() : template;
}

export function missionInputFromLoaded(loaded: LoadedMissionLike): MissionInput {
  const steps = (loaded.mission.planSnapshot as { steps?: unknown } | null)?.steps;
  return {
    id: loaded.mission.id,
    name: missionDisplayName(loaded.mission.goal, loaded.mission.template),
    status: loaded.mission.status,
    createdAt: isoOf(loaded.mission.createdAt),
    updatedAt: isoOf(loaded.mission.updatedAt),
    planTotal: Array.isArray(steps) ? steps.length : 0,
    pendingApprovals: loaded.approvals.filter((a) => a.status === "pending").length,
    events: loaded.events.map((e) => ({ ts: isoOf(e.ts), actor: e.actor, step: e.step, args: e.args, observation: e.observation })),
  };
}

/** JSON-safe agent view for one loaded mission; null when it has no agent state (archived). */
export function missionAgentView(loaded: LoadedMissionLike, runs: readonly AgentRunInput[] = []): MissionView | null {
  return deriveMission(missionInputFromLoaded(loaded), runs);
}

/** The lead node over one mission's branches (AgentTree `lead`). */
export function missionLeadNode(view: MissionView): AgentNode {
  return {
    key: "lead",
    name: LEAD_AGENT.name,
    monogram: monogram(LEAD_AGENT.name),
    isLead: true,
    status: view.status,
    line: view.branches.length ? view.line : view.status === "queued" ? "Plans the work, then hands each step to a sub-agent" : view.line,
    href: null,
    updatedAt: view.updatedAt,
    missionId: view.id,
    missionName: view.name,
    progress: view.progress,
    description: LEAD_AGENT.description,
    tools: LEAD_AGENT.tools,
  };
}
