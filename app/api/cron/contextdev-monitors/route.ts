// ShapesOS — context.dev change-monitor sweep (Phase 6 runtime).
// POST /api/cron/contextdev-monitors
//
// Auth (shared cron gate, lib/cron/gate.ts):
//   1. Cron: Authorization: Bearer <CRON_SECRET> — every workspace's due
//      monitors (bounded per call by runDueMonitors' limit).
//   2. Signed-in session (editor+) — the user's workspace only ("run now").
//
// Runs every active monitor whose cadence (hourly / daily / weekly) has
// elapsed: budget-gated scrape → hash compare → change row (+ optional
// research task); five failures in a row auto-pause a monitor. See
// lib/knowledge/contextdev/monitor.ts. Scheduled every 15 minutes by the
// in-app cron runner (lib/cron/jobs.ts).

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { runDueMonitors } from "@/lib/knowledge/contextdev/monitor";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  try {
    const results = await runDueMonitors(gate.isCron ? {} : { workspaceId: gate.workspaceId! });
    const count = (outcome: string) => results.filter((r) => r.outcome === outcome).length;
    return Response.json({
      ...(gate.isCron ? {} : { workspaceId: gate.workspaceId }),
      checked: results.length,
      changed: count("changed"),
      unchanged: count("unchanged"),
      baselined: count("baselined"),
      skipped: results.filter((r) => r.outcome.startsWith("skipped")).length,
      failed: count("failed"),
    });
  } catch (err) {
    return errorResponse(err, "POST /api/cron/contextdev-monitors", req);
  }
}
