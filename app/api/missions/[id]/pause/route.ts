// Marketr — POST /api/missions/:id/pause (editor+)
// Per-mission kill switch. Idempotent.
//
// NOTE: routes through the M4 engine twin (lib/missions/engine.ts), not
// M1's killswitch.pauseMission — the M1 version queries without the tenant
// GUC and sees zero rows under FORCE RLS. Same semantics, same timeline
// step names, GUC-scoped through the mission store.

import { missionsGuard, safetyError, missionDeps } from "../../_lib";
import { pauseMission } from "@/lib/missions/engine";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await missionsGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  try {
    const mission = await pauseMission(missionDeps(), id, gate.workspaceId, gate.userId);
    return Response.json({ ok: true, status: mission.status });
  } catch (err) {
    return safetyError(err);
  }
}
