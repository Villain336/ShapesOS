// ShapesOS — AgentRun rows for a set of missions (server only).
//
// A mission's latest run refines its agent state (a failed run marks a live
// mission failed; lib/aos/agents.ts deriveMission). agent_runs is FORCE RLS:
// the read goes through the tenant scope plus an explicit workspaceId filter.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { AgentRunInput } from "./agents";

const MAX_RUNS_PER_MISSION = 3;

export async function loadMissionRuns(workspaceId: string, missionIds: readonly string[]): Promise<AgentRunInput[]> {
  if (missionIds.length === 0) return [];
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRun.findMany({
      where: { workspaceId, missionId: { in: [...missionIds] } },
      orderBy: { createdAt: "desc" },
      take: Math.min(missionIds.length * MAX_RUNS_PER_MISSION, 300),
      select: { id: true, kind: true, status: true, missionId: true, createdAt: true, endedAt: true },
    }),
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    missionId: r.missionId,
    createdAt: r.createdAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
  }));
}

/** Best effort: the mission pages still render (without run refinement) if this read fails. */
export async function safeMissionRuns(workspaceId: string, missionIds: readonly string[]): Promise<AgentRunInput[]> {
  try {
    return await loadMissionRuns(workspaceId, missionIds);
  } catch {
    return [];
  }
}
