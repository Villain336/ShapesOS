// Marketr — Phase 10 M2: daily platform-radar sweep.
// POST /api/cron/platform-radar
//
// Auth (same pattern as /api/cron/radar — see lib/cron/gate.ts):
//   1. Signed-in session — runs for the user's workspace (editor+).
//   2. Cron: Authorization: Bearer <CRON_SECRET> — runs for every workspace.
//      Schedule daily (see DEPLOY.md): `0 6 * * * ... /api/cron/platform-radar`
//
// Pipeline: official sources → classifier → upsert → rollout correlation →
// Growth Memory → alert hub. One source's failure never fails the run.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { runPlatformRadar } from "@/lib/intelligence/radar/sweep";

import type { RadarRunResult } from "@/lib/intelligence/radar/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const workspaceIds = isCron
    ? (await prisma.workspace.findMany({ select: { id: true } })).map((w) => w.id)
    : [sessionWorkspaceId!];

  const runs: Array<RadarRunResult | { workspaceId: string; error: string }> = [];
  for (const workspaceId of workspaceIds) {
    try {
      runs.push(await runPlatformRadar(workspaceId));
    } catch (err) {
      runs.push({
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Response.json({
    ok: runs.every((r) => !("error" in r)),
    workspaces: runs.length,
    runs,
  });
}
