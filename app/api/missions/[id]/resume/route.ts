// Marketr — POST /api/missions/:id/resume (editor+)
//
// Per-mission kill-switch resume wired to M4's real staleness re-verification
// (docs/specs/SPEC-PHASE9.md §P9C): budgets, graph data freshness (graph as_of recency),
// goal assumptions. Fresh -> back to active with the report on the timeline;
// stale -> stays paused with a human-review event.
//
// NOTE: routes through the M4 engine twin (lib/missions/engine.ts), not
// M1's killswitch.resumeMission — the M1 version queries without the tenant
// GUC and sees zero rows under FORCE RLS. The verifier shape is
// plug-compatible with killswitch.resumeMission's verifyStaleness hook.

import { missionsGuard, safetyError, missionDeps } from "../../_lib";
import { createStalenessVerifier, resumeMission } from "@/lib/missions/engine";
import { getGraphNewestAsOf } from "@/lib/missions/prisma-store";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await missionsGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  const deps = missionDeps();
  const verify = createStalenessVerifier({ store: deps.store, getGraphNewestAsOf });
  try {
    const { mission, report } = await resumeMission(deps, id, gate.workspaceId, {
      actor: gate.userId,
      verifyStaleness: (mid, ws) => verify(mid, ws),
    });
    return Response.json({ ok: true, status: mission.status, staleness: report });
  } catch (err) {
    return safetyError(err);
  }
}
