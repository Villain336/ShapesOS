// Marketr — POST /api/flywheel/tests/:id/archive
// complete → archived; the structured learning goes to the Growth Memory sink.

import { flywheelGuard, badRequest, flywheelError, testlabAudit } from "@/app/api/flywheel/_lib";
import { resolveExperimentStore } from "@/lib/flywheel/testlab/store";
import { canTransition, LifecycleError } from "@/lib/flywheel/testlab/experiment";
import {
  buildGrowthLearning, createFakeMemorySink, GROWTH_MEMORY_SINK_SCHEMA,
} from "@/lib/flywheel/testlab/memory-sink";
import { createPrismaMemorySink, useFakeMemorySink } from "@/lib/substrate/memory/archive-sink";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await flywheelGuard("editor");
  if (gate instanceof Response) return gate;
  try {
    const { id } = await ctx.params;
    const { store, persistent } = await resolveExperimentStore();
    const exp = await store.getExperiment(gate.workspaceId, id);
    if (!exp) return Response.json({ error: "Experiment not found." }, { status: 404 });
    if (exp.status !== "complete") {
      return badRequest(`Only complete experiments can be archived (currently ${exp.status}).`);
    }
    if (!canTransition(exp.status, "archived")) throw new LifecycleError(exp.status, "archived");

    const saved = await store.getResult(id);
    // Rebuild a minimal honesty read for the learning from the saved stats.
    // (The full read inputs live with the analyst; the persisted stats JSON is
    // the durable record.)
    const stats = (saved?.statsJson ?? {}) as Record<string, unknown>;
    const learning = buildGrowthLearning(
      exp,
      {
        verdict: (saved?.verdict as "winner" | "loser" | "inconclusive" | "compromised") ?? exp.verdict ?? "inconclusive",
        terminal: Boolean(stats.terminal),
        chanceToBeat: Number(stats.prob_to_beat ?? 0.5),
        expectedLossRelative: Number(stats.expected_loss ?? 0),
        expectedUplift: Number(stats.expected_uplift ?? 0),
        ci: (stats.credible_interval as [number, number]) ?? [0, 0],
        sequentialCi: (stats.sequential_ci as [number, number]) ?? [0, 0],
        sequentialExcludesNull: Boolean(stats.sequential_excludes_null),
        frequentistP: Number(stats.frequentist_p ?? 1),
        badges: (stats.badges as never) ?? {
          power: { label: "underpowered", detail: "unknown" },
          maturity: { label: "immature", detail: "unknown" },
          integrity: { label: "clean", detail: "unknown" },
        },
        guardrailViolations: [],
        guidance: (stats.guidance as string[]) ?? [],
        headline: String(stats.headline ?? ""),
      },
      {},
    );

    // The sink: real Growth Memory store (Phase 8). Fake/test mode stays
    // available when DB tables are unavailable or MEMORY_TEST_MODE is set.
    let sink = useFakeMemorySink() ? createFakeMemorySink() : createPrismaMemorySink();
    if (sink.schema !== GROWTH_MEMORY_SINK_SCHEMA) {
      return flywheelError(new Error("Growth Memory sink schema drift — refusing to archive."));
    }
    let ref: string;
    try {
      ({ ref } = await sink.archive(learning));
    } catch (err) {
      // Table-missing (P2021 / 42P01): preserve the fake-mode default so
      // archiving never bricks Test Lab on a DB without Phase 8 tables.
      const msg = err instanceof Error ? err.message : String(err);
      if (/does not exist|P2021|42P01/i.test(msg)) {
        sink = createFakeMemorySink();
        ({ ref } = await sink.archive(learning));
      } else {
        throw err;
      }
    }

    if (saved) {
      await store.saveResult({ ...saved, archivedToMemory: true });
    }
    const updated = await store.updateExperiment(gate.workspaceId, id, { status: "archived" });
    testlabAudit().log(gate.workspaceId, gate.userId, "experiment.archived", id, {
      verdict: learning.result.verdict,
      memoryRef: ref,
    });
    return Response.json({ experiment: updated, learning, memoryRef: ref, persistent });
  } catch (err) {
    return flywheelError(err);
  }
}
