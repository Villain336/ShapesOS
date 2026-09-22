// Marketr — ad factory job sweep (milestone 21).
// POST /api/cron/ads
//
// Auth (either), same pattern as /api/cron/social (milestone 20):
//   1. Signed-in session — runs due jobs for the user's workspace.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — sweeps all workspaces.
//      Schedule every 5 minutes (see DEPLOY.md).
//
// The sweep: submit queued creatives that never got a provider job, and poll
// in-flight ones whose nextPollAt is due. Bounded per run.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { createHiggsfieldPort } from "@/lib/ads/higgsfield";
import { getHiggsfieldPort, runDueAdJobs } from "@/lib/ads/service";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Day-1 hardening (M1): shared cron gate (lib/cron/gate.ts) — CRON_SECRET
  // service call, or signed-in session with editor+ on the user's workspace.
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const portFactory = (wsId: string) => getHiggsfieldPort(prisma, wsId, (key) => createHiggsfieldPort(key));
  if (!isCron) {
    const workspaceId = sessionWorkspaceId!;
    const result = await runDueAdJobs(prisma, portFactory, workspaceId);
    return Response.json(result);
  }

  const result = await runDueAdJobs(prisma, portFactory);
  return Response.json(result);
}
