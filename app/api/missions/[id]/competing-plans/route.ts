// ShapesOS - /api/missions/:id/competing-plans
// Always off in this change. GET reports why (viewer+). POST (editor+) refuses with 403
// before any mission read, provider lookup or model call. There is no flag or
// environment variable that enables it: see competing-plans-gate.ts for what must exist
// first. The composer in lib/missions/competing-plans.ts is intentionally NOT imported here.

import { missionsGuard } from "../../_lib";
import { competingPlansGate } from "@/lib/missions/competing-plans-gate";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await missionsGuard("viewer");
  if (gate instanceof Response) return gate;
  const g = competingPlansGate();
  return Response.json({ enabled: g.enabled, reason: g.reason, missing: g.missing });
}

export async function POST() {
  const gate = await missionsGuard("editor");
  if (gate instanceof Response) return gate;
  const g = competingPlansGate();
  return Response.json({ error: g.reason, enabled: false, missing: g.missing }, { status: 403 });
}
