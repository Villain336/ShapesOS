// Marketr — flush queued alert events (milestone 13).
// POST /api/cron/alerts
//
// Auth (either), same pattern as /api/cron/fix-agent (milestone 10):
//   1. Signed-in session — flushes queued events in the user's workspace.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — flushes every workspace.
//      Schedule it every 15 minutes alongside the other cron jobs so
//      digest windows and quiet-hours holds are delivered promptly.
//
// Flush = daily digests that are due + quiet-hours holds whose window ended.
// Milestone 11: session-triggered runs honor RBAC (viewers can't flush).
// CRON_SECRET path is a service actor and bypasses user roles.

import { requireWorkspaceRole } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { flushQueued } from "@/lib/alerts/dispatch";
import { bearerMatches } from "@/lib/security/constant-time";

export const dynamic = "force-dynamic";

function cronAuthorized(req: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return bearerMatches(header, secret);
}

export async function POST(req: NextRequest) {
  const isCron = cronAuthorized(req);
  const user = isCron ? null : await requireUser();
  if (!isCron && !user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  if (!isCron && user) {
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    const result = await flushQueued(new Date(), workspace.id);
    return Response.json({ workspaceId: workspace.id, ...result });
  }

  const result = await flushQueued(new Date());
  return Response.json(result);
}
