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
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { createHiggsfieldPort } from "@/lib/ads/higgsfield";
import { getHiggsfieldPort, runDueAdJobs } from "@/lib/ads/service";

export const dynamic = "force-dynamic";

function cronAuthorized(req: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  const isCron = cronAuthorized(req);
  const user = isCron ? null : await requireUser();
  if (!isCron && !user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const portFactory = (wsId: string) => getHiggsfieldPort(prisma, wsId, (key) => createHiggsfieldPort(key));
  if (!isCron) {
    const workspaceId = (await getOrCreateWorkspace(user!.id, user!.email)).id;
    const result = await runDueAdJobs(prisma, portFactory, workspaceId);
    return Response.json(result);
  }

  const result = await runDueAdJobs(prisma, portFactory);
  return Response.json(result);
}
