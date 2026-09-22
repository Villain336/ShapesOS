// Marketr — scheduled newsletter broadcasts (milestone 19).
// POST /api/cron/newsletter
//
// Auth (either), same pattern as /api/cron/autopilot (milestone 18):
//   1. Signed-in session — runs due scheduled broadcasts for the user's workspace.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — runs due broadcasts across
//      all workspaces. Schedule every 15 minutes (see DEPLOY.md).
//
// Safety: sendBroadcast() enforces the server-side guardrails (verified
// domain, completed test send, ≥1 subscriber, unsubscribe link) even for
// scheduled runs; failures are audit-logged and fire M13 alerts.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { createResendPort } from "@/lib/newsletter/resend";
import { getResendPort, runDueBroadcasts } from "@/lib/newsletter/service";

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

  if (!isCron) {
    // Session-triggered: scope to the user's workspace.
    const workspaceId = (await getOrCreateWorkspace(user!.id, user!.email)).id;
    const result = await runDueBroadcasts(
      prisma,
      (wsId) => getResendPort(prisma, wsId, (key) => createResendPort(key)),
      workspaceId,
    );
    return Response.json(result);
  }

  const result = await runDueBroadcasts(prisma, (wsId) =>
    getResendPort(prisma, wsId, (key) => createResendPort(key)),
  );
  return Response.json(result);
}
