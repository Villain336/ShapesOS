// Marketr — GET /api/flywheel/tests/:id

import { flywheelGuard, flywheelError } from "@/app/api/flywheel/_lib";
import { resolveExperimentStore } from "@/lib/flywheel/testlab/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await flywheelGuard("viewer");
  if (gate instanceof Response) return gate;
  try {
    const { id } = await ctx.params;
    const { store, persistent } = await resolveExperimentStore();
    const experiment = await store.getExperiment(gate.workspaceId, id);
    if (!experiment) return Response.json({ error: "Experiment not found." }, { status: 404 });
    const result = await store.getResult(id);
    return Response.json({ experiment, result, persistent });
  } catch (err) {
    return flywheelError(err);
  }
}
