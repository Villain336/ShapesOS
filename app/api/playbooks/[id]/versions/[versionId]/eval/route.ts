// Marketr — /api/playbooks/:id/versions/:versionId/eval (Phase 9 M5).
// POST (editor): { metricDeltas, attributionNote, uncertainty } → outcome
// evaluation with honest uncertainty bars.

import { playbooksGuard, badRequest, readJson, storeError } from "../../../../_lib";
import { recordEval } from "@/lib/playbooks/store";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; versionId: string }> },
) {
  const gate = await playbooksGuard("editor");
  if (gate instanceof Response) return gate;
  const { versionId } = await ctx.params;
  const body = await readJson(req);
  if (!body.metricDeltas || typeof body.metricDeltas !== "object") {
    return badRequest("metricDeltas is required (object of metric → delta).");
  }
  try {
    const result = await recordEval(
      gate.workspaceId,
      versionId,
      {
        metricDeltas: body.metricDeltas as Record<string, number>,
        attributionNote: typeof body.attributionNote === "string" ? body.attributionNote : "",
        uncertainty: (body.uncertainty ?? {}) as never,
      },
      gate.userId,
    );
    return Response.json(result);
  } catch (err) {
    return storeError(err);
  }
}
