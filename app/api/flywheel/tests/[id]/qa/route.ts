// Marketr — POST /api/flywheel/tests/:id/qa
// Runs force-QA + A/A dry-run; draft → qa on pass.

import { flywheelGuard, flywheelError, readJson, testlabAudit } from "@/app/api/flywheel/_lib";
import { resolveExperimentStore } from "@/lib/flywheel/testlab/store";
import { buildQaReport, canTransition, LifecycleError } from "@/lib/flywheel/testlab/experiment";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await flywheelGuard("editor");
  if (gate instanceof Response) return gate;
  try {
    const { id } = await ctx.params;
    const body = await readJson(req);
    const baseUrl = typeof body.baseUrl === "string" && body.baseUrl.length > 0
      ? body.baseUrl
      : process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

    const { store, persistent } = await resolveExperimentStore();
    const exp = await store.getExperiment(gate.workspaceId, id);
    if (!exp) return Response.json({ error: "Experiment not found." }, { status: 404 });

    const qaReport = buildQaReport(exp, baseUrl);
    let status = exp.status;
    if (qaReport.passed && canTransition(exp.status, "qa")) {
      status = "qa";
    } else if (qaReport.passed && exp.status !== "qa" && !canTransition(exp.status, "qa")) {
      throw new LifecycleError(exp.status, "qa");
    }

    const updated = await store.updateExperiment(gate.workspaceId, id, { qaReport, status });
    testlabAudit().log(gate.workspaceId, gate.userId, "experiment.qa", id, {
      passed: qaReport.passed,
      failingChecks: qaReport.checks.filter((c) => !c.passed).map((c) => c.name),
    });
    return Response.json({ experiment: updated, qaReport, persistent });
  } catch (err) {
    return flywheelError(err);
  }
}
