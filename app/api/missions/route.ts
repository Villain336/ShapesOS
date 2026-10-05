// Marketr — /api/missions
// GET  -> dense mission list (viewer+)
// POST -> start a mission from a template (editor+). Tier 0: drafts plans,
//         executes nothing by itself. Phase 8: the launch is queued for the
//         agent worker (lib/agents/mission-runtime.ts), which runs the plan's
//         steps up to the first human approval as sub-agent loops.

import type { NextRequest } from "next/server";
import { missionsGuard, safetyError, readJson, serializeMission, toListItem, missionDeps } from "./_lib";
import { loadMission, startMission, type LoadedMission } from "@/lib/missions/engine";
import { missionAgentView } from "@/lib/aos/missions";
import { safeMissionRuns } from "@/lib/aos/missions.server";
import { enqueueMissionLaunch } from "@/lib/agents/mission-runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await missionsGuard("viewer");
  if (gate instanceof Response) return gate;
  try {
    const d = missionDeps();
    const missions = await d.store.listMissions(gate.workspaceId);
    const loadedAll: LoadedMission[] = [];
    for (const m of missions) {
      loadedAll.push(await loadMission(d, m.id, gate.workspaceId));
    }
    // Agentic OS: each mission's agent state (status band, the sub-agents the
    // lead delegated to), refined by its latest run. Additive; best effort.
    const runs = await safeMissionRuns(gate.workspaceId, loadedAll.map((l) => l.mission.id));
    const items = loadedAll.map((loaded) => ({ ...toListItem(loaded), agent: missionAgentView(loaded, runs) }));
    return Response.json({ missions: items });
  } catch (err) {
    return safetyError(err);
  }
}

export async function POST(req: NextRequest) {
  const gate = await missionsGuard("editor");
  if (gate instanceof Response) return gate;
  const body = await readJson(req);
  try {
    const mission = await startMission(missionDeps(), {
      workspaceId: gate.workspaceId,
      userId: gate.userId,
      templateId: body.templateId as string,
      goal: body.goal,
      name: typeof body.name === "string" ? body.name : undefined,
    });
    // Phase 8: queue the launch. The mission exists either way; a queue
    // failure is reported, never hidden.
    let launch: { runId: string; jobId: string } | null = null;
    let launchError: string | null = null;
    try {
      launch = await enqueueMissionLaunch({ missionId: mission.id, workspaceId: gate.workspaceId, userId: gate.userId });
    } catch (err) {
      launchError = err instanceof Error ? err.message : "could not queue the mission";
    }
    return Response.json(
      { mission: serializeMission(mission), runId: launch?.runId ?? null, ...(launchError ? { launchError } : {}) },
      { status: 201 },
    );
  } catch (err) {
    return safetyError(err);
  }
}
