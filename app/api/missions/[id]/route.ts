// Marketr — GET /api/missions/:id (viewer+)
// Full mission detail: mission, event timeline, approvals, derived state.

import { missionsGuard, safetyError, serializeMission, serializeApproval, serializeEvent, missionDeps } from "../_lib";
import { loadMission, planRevision } from "@/lib/missions/engine";
import { missionAgentView } from "@/lib/aos/missions";
import { safeMissionRuns } from "@/lib/aos/missions.server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await missionsGuard("viewer");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  try {
    const loaded = await loadMission(missionDeps(), id, gate.workspaceId);
    const runs = await safeMissionRuns(gate.workspaceId, [loaded.mission.id]);
    return Response.json({
      mission: serializeMission(loaded.mission),
      // The drafted plan's revision fingerprint: the client sends it back
      // with the plan approval, which is refused (409) if the plan changed
      // since the review.
      planRevision: planRevision(loaded.mission.planSnapshot),
      events: loaded.events.map(serializeEvent),
      approvals: loaded.approvals.map(serializeApproval),
      stepCount: loaded.stepCount,
      planStepCount: loaded.planStepCount,
      totalCostCents: loaded.totalCostCents,
      consecutiveFailures: loaded.consecutiveFailures,
      progress: loaded.progress,
      termination: loaded.termination,
      nextCheckpoint: loaded.nextCheckpoint,
      // Agentic OS: agent state + the lead's delegations (additive).
      agent: missionAgentView(loaded, runs),
      runs: runs.map((r) => ({ id: r.id, kind: r.kind, status: r.status, createdAt: r.createdAt, endedAt: r.endedAt })),
    });
  } catch (err) {
    return safetyError(err);
  }
}
