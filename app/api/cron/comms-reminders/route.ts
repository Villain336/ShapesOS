// ShapesOS — Phase 18.2 (WS=comms): POST /api/cron/comms-reminders
//
// Reminders that have come due → one `reminder_due` notification per
// occurrence to the reminder's owner (lib/comms/sweep.server.ts), through the
// existing producers (focus holds it; a muted kind writes nothing).
//
// Auth: the shared cron gate (lib/cron/gate.ts) — CRON_SECRET sweeps every
// workspace; a signed-in editor+ sweeps their own.
// Schedule: every minute (lib/cron/jobs.ts "comms-reminders").

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { allWorkspaceIds } from "@/lib/ops/helpdesk";
import { sweepDueReminders } from "@/lib/comms/sweep.server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const workspaceIds = gate.isCron ? await allWorkspaceIds() : [gate.workspaceId!];
  const reminders = await sweepDueReminders({ workspaceIds });
  return Response.json({ ok: true, reminders });
}
