// Marketr — scheduled social publishing sweep (milestone 20).
// POST /api/cron/social
//
// Auth (either), same pattern as /api/cron/newsletter (milestone 19):
//   1. Signed-in session — runs due posts for the user's workspace.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — sweeps all workspaces.
//      Schedule every 5 minutes (see DEPLOY.md).
//
// The sweep: dispatch user-scheduled posts that are due to Buffer (Buffer's
// queue does the actual publishing), retry transient failures with backoff
// (bounded to 3 attempts), and mark posts Buffer reports as sent.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { createBufferPort } from "@/lib/social/buffer";
import { getBufferPort, runDueSocialPosts } from "@/lib/social/service";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Day-1 hardening (M1): shared cron gate (lib/cron/gate.ts) — CRON_SECRET
  // service call, or signed-in session with editor+ on the user's workspace.
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const portFactory = (wsId: string) => getBufferPort(prisma, wsId, (key) => createBufferPort(key));
  if (!isCron) {
    const workspaceId = sessionWorkspaceId!;
    const result = await runDueSocialPosts(prisma, portFactory, workspaceId);
    return Response.json(result);
  }

  const result = await runDueSocialPosts(prisma, portFactory);
  return Response.json(result);
}
