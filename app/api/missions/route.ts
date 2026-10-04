// Marketr — /api/missions
// GET  -> dense mission list (viewer+)
// POST -> start a mission from a template (editor+). Tier 0: drafts plans,
//         executes nothing.

import type { NextRequest } from "next/server";
import { missionsGuard, safetyError, readJson, serializeMission, toListItem, missionDeps } from "./_lib";
import { loadMission, startMission, type LoadedMission } from "@/lib/missions/engine";
import { missionAgentView } from "@/lib/aos/missions";
import { safeMissionRuns } from "@/lib/aos/missions.server";

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
    return Response.json({ mission: serializeMission(mission) }, { status: 201 });
  } catch (err) {
    return safetyError(err);
  }
}
