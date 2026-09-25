// Marketr — POST /api/flywheel/tests/:id/launch
// QA-gated: launchGate must pass (QA, traffic floor, profit guardrail, min runtime).

import { flywheelGuard, flywheelError, testlabAudit } from "@/app/api/flywheel/_lib";
import { resolveExperimentStore } from "@/lib/flywheel/testlab/store";
import { launchGate } from "@/lib/flywheel/testlab/experiment";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await flywheelGuard("editor");
  if (gate instanceof Response) return gate;
  try {
    const { id } = await ctx.params;
    const { store, persistent } = await resolveExperimentStore();
    const exp = await store.getExperiment(gate.workspaceId, id);
    if (!exp) return Response.json({ error: "Experiment not found." }, { status: 404 });

    const check = launchGate(exp);
    if (!check.ok) {
      testlabAudit().log(gate.workspaceId, gate.userId, "experiment.launch_refused", id, {
        blockers: check.blockers,
      });
      return Response.json(
        { error: "Launch refused.", blockers: check.blockers, trafficFloor: check.trafficFloor },
        { status: 422 },
      );
    }

    const now = new Date().toISOString();
    const updated = await store.updateExperiment(gate.workspaceId, id, {
      status: "running",
      launchedAt: now,
      trafficFloorNote: check.trafficFloor.note,
    });
    testlabAudit().log(gate.workspaceId, gate.userId, "experiment.launched", id, {
      channel: exp.channel,
      trafficFloorDecision: check.trafficFloor.decision,
    });
    return Response.json({ experiment: updated, trafficFloor: check.trafficFloor, persistent });
  } catch (err) {
    return flywheelError(err);
  }
}
