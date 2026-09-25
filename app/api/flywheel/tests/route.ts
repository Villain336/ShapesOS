// Marketr — POST /api/flywheel/tests (create) · GET (list)

import { flywheelGuard, badRequest, flywheelError, readJson, testlabAudit } from "@/app/api/flywheel/_lib";
import { resolveExperimentStore } from "@/lib/flywheel/testlab/store";
import { createId } from "@/lib/media/ids";
import { trafficFloorCheck } from "@/lib/flywheel/testlab/traffic";
import type { Experiment } from "@/lib/flywheel/testlab/experiment";
import { createExperimentSchema } from "./_schemas";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await flywheelGuard("viewer");
  if (gate instanceof Response) return gate;
  try {
    const { store, persistent } = await resolveExperimentStore();
    const experiments = await store.listExperiments(gate.workspaceId);
    return Response.json({ experiments, persistent });
  } catch (err) {
    return flywheelError(err);
  }
}

export async function POST(req: Request) {
  const gate = await flywheelGuard("editor");
  if (gate instanceof Response) return gate;
  try {
    const body = await readJson(req);
    const parsed = createExperimentSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid experiment payload.", parsed.error.issues);
    const v = parsed.data;

    const weightSum = v.variants.reduce((s, x) => s + x.weight, 0);
    if (Math.abs(weightSum - 1) > 1e-6) return badRequest("Variant weights must sum to 1.");

    const trafficFloor = trafficFloorCheck({
      baselineRate: v.baselineRate,
      monthlyTraffic: v.monthlyTraffic,
      hopedLift: v.statedMde,
      statedMde: v.statedMde,
    });

    const now = new Date().toISOString();
    const exp: Experiment = {
      id: createId(),
      workspaceId: gate.workspaceId,
      name: v.name,
      hypothesis: v.hypothesis,
      pieIceScore: v.pieIceScore,
      channel: v.channel,
      variants: v.variants,
      audience: v.audience,
      primaryMetric: v.primaryMetric,
      metricType: v.metricType,
      guardrailMetrics: v.guardrailMetrics,
      status: "draft",
      profitGuardrail: v.profitGuardrail,
      trafficFloorNote: trafficFloor.note,
      minRuntimeDays: v.minRuntimeDays,
      statedMde: v.statedMde,
      verdict: null,
      baselineRate: v.baselineRate,
      monthlyTraffic: v.monthlyTraffic,
      launchedAt: null,
      completedAt: null,
      qaReport: null,
      createdBy: gate.userId,
      createdAt: now,
      updatedAt: now,
    };

    const { store, persistent } = await resolveExperimentStore();
    const created = await store.createExperiment(gate.workspaceId, exp);
    testlabAudit().log(gate.workspaceId, gate.userId, "experiment.created", created.id, {
      name: created.name, channel: created.channel,
      trafficFloorDecision: trafficFloor.decision,
    });
    return Response.json({ experiment: created, trafficFloor, persistent }, { status: 201 });
  } catch (err) {
    return flywheelError(err);
  }
}
