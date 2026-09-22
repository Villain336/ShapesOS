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
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { createBufferPort } from "@/lib/social/buffer";
import { getBufferPort, runDueSocialPosts } from "@/lib/social/service";

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

  const portFactory = (wsId: string) => getBufferPort(prisma, wsId, (key) => createBufferPort(key));
  if (!isCron) {
    const workspaceId = (await getOrCreateWorkspace(user!.id, user!.email)).id;
    const result = await runDueSocialPosts(prisma, portFactory, workspaceId);
    return Response.json(result);
  }

  const result = await runDueSocialPosts(prisma, portFactory);
  return Response.json(result);
}
