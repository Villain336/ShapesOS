// Marketr — Phase 10 M1: scheduled URL Inspection queue drain.
// POST /api/cron/gsc-inspection
//
// Auth: CRON_SECRET service call (all workspaces) or signed-in session with
// editor+ on their workspace (cronGate). Drains each workspace's inspection
// queue with the 2,000 QPD/site hard wall, priority ordering, and fair-share
// across projects. Schedule every 15 min (see DEPLOY.md).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { drainInspectionQueue } from "@/lib/intelligence/gsc";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const workspaces = isCron
    ? (await prisma.workspace.findMany({ select: { id: true } })).map((w) => w.id)
    : [sessionWorkspaceId!];

  const results: Array<Record<string, unknown>> = [];
  for (const workspaceId of workspaces) {
    try {
      const drain = await drainInspectionQueue(workspaceId);
      results.push({
        workspaceId,
        processed: drain.processed,
        remaining: drain.remaining,
        quotaAfter: drain.quotaAfter,
      });
    } catch (err) {
      results.push({
        workspaceId,
        error: err instanceof Error ? err.message.slice(0, 200) : "drain failed",
      });
    }
  }

  return Response.json({ ok: true, workspaces: results });
}
