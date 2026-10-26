// ShapesOS — POST /api/missions/:id/approve-plan (editor+)
//
// The whole-plan gate: a person reviewed the drafted plan and approved it.
// Only now does the mission activate (planned -> active) and its launch get
// queued for the agent worker (lib/agents/mission-runtime.ts). Per-step
// approvals (money, outside sends, publishing) still ask during execution —
// this gate adds one up-front review; it never replaces the per-step gates.
// Idempotent: re-approving an active mission does not queue a second launch.

import { missionsGuard, safetyError, missionDeps, readJson, badRequest } from "../../_lib";
import { approveMissionPlan } from "@/lib/missions/engine";
import { enqueueMissionLaunch } from "@/lib/agents/mission-runtime";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await missionsGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  try {
    // The approval must name the plan revision the person reviewed; the
    // engine refuses (409) if the plan has changed since.
    const body = await readJson(req);
    const revision = typeof body.planRevision === "string" ? body.planRevision : null;
    if (!revision) return badRequest("Send the planRevision of the plan you reviewed (from GET /api/missions/:id).");
    const { mission, transitioned } = await approveMissionPlan(missionDeps(), id, gate.workspaceId, gate.userId, {
      expectedRevision: revision,
    });
    // Launch on the transition OR on a retry after a failed launch:
    // enqueueMissionLaunch is idempotent per mission (one launch run; a
    // missing job is re-queued), so a repeat POST after a queue failure
    // retries the launch instead of stranding an active mission, and a
    // repeat POST after success never double-starts the worker.
    let launch: { runId: string; jobId: string } | null = null;
    let launchError: string | null = null;
    if (transitioned || mission.status === "active") {
      try {
        launch = await enqueueMissionLaunch({ missionId: mission.id, workspaceId: gate.workspaceId, userId: gate.userId });
      } catch (err) {
        launchError = err instanceof Error ? err.message : "could not queue the mission";
      }
    }
    return Response.json({
      ok: true,
      status: mission.status,
      runId: launch?.runId ?? null,
      ...(launchError ? { launchError } : {}),
    });
  } catch (err) {
    return safetyError(err);
  }
}
