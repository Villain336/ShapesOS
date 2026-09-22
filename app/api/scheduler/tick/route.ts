// Marketr — scheduler tick API (Phase B, W2).
// POST /api/scheduler/tick { workspaceId? }
//   Fires due cron schedules + missed-cron catch-up (fires once, marked missed).
//
// Two actors (lib/cron/gate.ts cronGate):
//   1. CRON_SECRET bearer — sweeps all workspaces.
//   2. Signed-in editor+ session — sweeps only the caller's workspace.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { runSchedulerTick } from "@/lib/scheduler/tick";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // The gate accepts exactly the CRON_SECRET service call or a signed-in
  // editor+ session (lib/cron/gate.ts) — a recognized M11 primitive.
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const result = await runSchedulerTick(prisma, new Date(), {
    workspaceId: gate.isCron ? undefined : (gate.workspaceId ?? undefined),
  });
  return Response.json(result);
}
