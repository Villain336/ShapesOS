// ShapesOS Phase 13 (twincore): POST /api/cron/twin-alerts
//
// Auth (shared cron gate, lib/cron/gate.ts): CRON_SECRET sweeps every
// workspace that has a twin site; a signed-in editor+ sweeps their own
// ("Check alerts now").
//
// Raises the digital twin's conditions — a truck overdue at a dock, a bin
// below its reorder point, a machine stopped while its order is late, a
// register session left open (lib/alerts/triggers.ts twin.*) — through the
// alert hub (emitAlert) and an in-app notification for editors
// (lib/notifications/producers.ts notifyTwinAlert), once per condition
// (lib/twin/alerts.ts). The same conditions show on the twin's objects.

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { sweepTwinAlerts, workspacesWithSites, type TwinAlertSweepResult } from "@/lib/twin/alerts";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const workspaceIds = gate.isCron ? await workspacesWithSites() : [gate.workspaceId!];
  const results: TwinAlertSweepResult[] = [];
  for (const workspaceId of workspaceIds) {
    const r = await sweepTwinAlerts(workspaceId);
    if (r.sites > 0 || r.errors.length) results.push(r);
  }
  return Response.json({ ok: true, workspaces: results.length, raised: results.reduce((s, r) => s + r.raised, 0), results });
}
