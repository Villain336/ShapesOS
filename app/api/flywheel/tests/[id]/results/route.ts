// Marketr — GET/POST /api/flywheel/tests/:id/results
//
// The honesty-layer rendering endpoint. POST accepts arm data + integrity
// inputs (fake mode / fixtures), runs the integrity battery FIRST, then the
// peek-safe honesty read. On SRM failure the results refuse to render:
// verdict "compromised", renderAllowed=false — numbers are zeroed, never shown.

import { flywheelGuard, badRequest, flywheelError, readJson, testlabAudit } from "@/app/api/flywheel/_lib";
import { resolveExperimentStore } from "@/lib/flywheel/testlab/store";
import { runIntegrityBattery, compromisedCopy } from "@/lib/flywheel/testlab/integrity";
import { honestyRead } from "@/lib/flywheel/testlab/honesty";
import { resultsReadSchema } from "../../_schemas";

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

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await flywheelGuard("editor");
  if (gate instanceof Response) return gate;
  try {
    const { id } = await ctx.params;
    const body = await readJson(req);
    const parsed = resultsReadSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid results payload.", parsed.error.issues);
    const r = parsed.data;

    const { store, persistent } = await resolveExperimentStore();
    const exp = await store.getExperiment(gate.workspaceId, id);
    if (!exp) return Response.json({ error: "Experiment not found." }, { status: 404 });
    if (exp.status !== "running" && exp.status !== "paused" && exp.status !== "complete") {
      return badRequest(`Results can only be read for running/paused/complete experiments (currently ${exp.status}).`);
    }

    // 1. Integrity battery FIRST — SRM failure refuses rendering.
    const integrity = runIntegrityBattery({
      armCounts: r.armCounts,
      armWeights: r.armWeights,
      coverage: r.coverage,
      prePeriodMeans: r.prePeriodMeans,
      prePeriodNs: r.prePeriodNs,
      exposureLeakageRate: r.exposureLeakageRate,
      concurrentTests: r.concurrentTests,
      volatility: r.volatility,
    });

    // 2. Honesty read (peek-safe boundaries, badges, profit guardrails).
    const guardrails = exp.guardrailMetrics.map((g) => {
      const read = r.guardrailReads.find((x) => x.name === g.name);
      return {
        name: g.name,
        relativeChange: read?.relativeChange ?? 0,
        tolerance: g.tolerance,
        violated: read ? read.relativeChange < -g.tolerance : false,
      };
    });
    const isConversionTest = /conversion|purchase|signup|revenue|profit/i.test(exp.primaryMetric);
    const read = honestyRead({
      metricType: exp.metricType,
      armA: r.armA as never,
      armB: r.armB as never,
      statedMde: exp.statedMde,
      minRuntimeDays: exp.minRuntimeDays,
      daysRunning: r.daysRunning,
      fullCycleCovered: r.fullCycleCovered,
      guardrails,
      expectedLossThreshold: r.expectedLossThreshold,
      minUnits: r.minUnits,
      conversionTest: isConversionTest,
      profitCheck: r.profitCheck,
    }, integrity);

    const statsJson = {
      prob_to_beat: read.chanceToBeat,
      expected_loss: read.expectedLossRelative,
      expected_uplift: read.expectedUplift,
      credible_interval: read.ci,
      sequential_ci: read.sequentialCi,
      sequential_excludes_null: read.sequentialExcludesNull,
      frequentist_p: read.frequentistP,
      badges: read.badges,
      headline: read.headline,
      terminal: read.terminal,
      guidance: read.guidance,
    };
    const saved = await store.saveResult({
      experimentId: id,
      statsJson,
      srm: {
        status: integrity.checks.find((c) => c.name === "srm")?.severity === "hard_fail" ? "fail" : "pass",
        pValue: integrity.checks.find((c) => c.name === "srm")?.metric?.pValue ?? 1,
      },
      guardrailChecks: guardrails,
      verdict: read.verdict,
      archivedToMemory: false,
    });

    if (read.terminal && exp.status !== "complete") {
      await store.updateExperiment(gate.workspaceId, id, {
        status: "complete",
        completedAt: new Date().toISOString(),
        verdict: read.verdict,
      });
    }

    testlabAudit().log(gate.workspaceId, gate.userId, "experiment.verdict", id, {
      verdict: read.verdict,
      terminal: read.terminal,
      renderAllowed: integrity.renderAllowed,
    });

    return Response.json({
      experiment: await store.getExperiment(gate.workspaceId, id),
      integrity,
      renderAllowed: integrity.renderAllowed,
      compromisedCopy: integrity.renderAllowed ? null : compromisedCopy(integrity),
      read: integrity.renderAllowed ? read : null,
      result: saved,
      persistent,
    });
  } catch (err) {
    return flywheelError(err);
  }
}
