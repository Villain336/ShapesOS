// Marketr — POST /api/flywheel/tests/:id/pause
// running → paused, or paused → running (resume). Body: { action: "pause" | "resume" }.

import { flywheelGuard, badRequest, flywheelError, readJson, testlabAudit } from "@/app/api/flywheel/_lib";
import { resolveExperimentStore } from "@/lib/flywheel/testlab/store";
import { canTransition, LifecycleError } from "@/lib/flywheel/testlab/experiment";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await flywheelGuard("editor");
  if (gate instanceof Response) return gate;
  try {
    const { id } = await ctx.params;
    const body = await readJson(req);
    const action = body.action === "resume" ? "resume" : "pause";
    const to = action === "pause" ? "paused" : "running";

    const { store, persistent } = await resolveExperimentStore();
    const exp = await store.getExperiment(gate.workspaceId, id);
    if (!exp) return Response.json({ error: "Experiment not found." }, { status: 404 });
    if (!canTransition(exp.status, to)) throw new LifecycleError(exp.status, to);

    const updated = await store.updateExperiment(gate.workspaceId, id, { status: to });
    testlabAudit().log(gate.workspaceId, gate.userId, `experiment.${action}d`, id, {});
    return Response.json({ experiment: updated, persistent });
  } catch (err) {
    if (err instanceof Error && /Illegal experiment transition/.test(err.message)) {
      return badRequest(err.message);
    }
    return flywheelError(err);
  }
}
