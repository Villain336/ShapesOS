// ShapesOS - /api/missions/:id/plan-alternatives
// GET  -> the declared alternatives for a drafted mission (viewer+). Pure,
//         deterministic, no model call, no cost.
// POST -> choose one (editor+). Rewrites the DRAFTED plan only; the mission
//         stays "planned" and needs its own revision-bound approval.

import { missionsGuard, safetyError, missionDeps, readJson, badRequest } from "../../_lib";
import { loadMission, planRevision, selectPlanAlternative } from "@/lib/missions/engine";
import { getTemplate } from "@/lib/missions/templates";
import { buildPlanAlternatives } from "@/lib/missions/plan-alternatives";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await missionsGuard("viewer");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  try {
    const { mission } = await loadMission(missionDeps(), id, gate.workspaceId);
    const template = getTemplate(mission.template);
    const cap = typeof (mission.budgetCaps as { maxCostCents?: unknown }).maxCostCents === "number"
      ? ((mission.budgetCaps as { maxCostCents: number }).maxCostCents)
      : null;
    return Response.json({
      status: mission.status,
      currentRevision: planRevision(mission.planSnapshot),
      spendCapCents: cap,
      costEstimate: null, // no grounded estimate exists; the cap is a limit, not a forecast
      alternatives: buildPlanAlternatives(template).map((a) => ({
        id: a.id,
        label: a.label,
        strategy: a.strategy,
        revision: planRevision(a.snapshot),
        stepCount: a.steps.length,
        outsideActionSteps: a.steps.filter((s) => s.tier > 0).length,
        checkpointCount: a.steps.filter((s) => s.checkpointAfter).length,
        omitted: a.omitted,
        steps: a.steps.map((x) => ({ key: x.key, title: x.title, kind: x.kind, executor: x.executor, tier: x.tier, checkpointAfter: x.checkpointAfter })),
      })),
    });
  } catch (err) {
    return safetyError(err);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await missionsGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  try {
    const body = await readJson(req);
    const alternativeId = typeof body.alternativeId === "string" ? body.alternativeId : null;
    const revision = typeof body.planRevision === "string" ? body.planRevision : null;
    if (!alternativeId || !revision) return badRequest("Send alternativeId and the planRevision you reviewed.");
    const r = await selectPlanAlternative(missionDeps(), id, gate.workspaceId, gate.userId, { alternativeId, expectedRevision: revision });
    return Response.json({ ok: true, changed: r.changed, status: r.mission.status, planRevision: r.planRevision });
  } catch (err) {
    return safetyError(err);
  }
}
