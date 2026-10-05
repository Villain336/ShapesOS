// ShapesOS — Dataset Builder staleness sweep (Phase 4b).
// POST /api/cron/dataset-health
//
// Auth (shared cron gate, lib/cron/gate.ts):
//   1. Signed-in session — sweeps the user's workspace (editor+).
//   2. Cron: Authorization: Bearer <CRON_SECRET> — sweeps every workspace
//      that has a compiled dataset. Schedule daily.
//
// Each stale dataset alerts once per compiled version (in-app notification,
// the "dataset_stale" alert-hub trigger, the dataset.stale webhook); see
// lib/datasetbuilder/stale-sweep.ts. Threshold: DATASET_STALE_AFTER_DAYS
// (default 90).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { emitAlert } from "@/lib/alerts/evaluate";
import { sweepDatasetStaleness } from "@/lib/datasetbuilder/stale-sweep";
import { log } from "@/lib/observability/log";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const workspaceIds = isCron
    ? (
        await prisma.datasetVersion.findMany({
          distinct: ["workspaceId"],
          select: { workspaceId: true },
        })
      ).map((v) => v.workspaceId)
    : [sessionWorkspaceId!];

  const now = new Date();
  const results = [];
  for (const workspaceId of workspaceIds) {
    try {
      results.push(await sweepDatasetStaleness(prisma, workspaceId, { now, emitAlert }));
    } catch (err) {
      log.error("dataset-health sweep failed", { workspaceId, err: err instanceof Error ? err.message : String(err) });
      results.push({ workspaceId, checked: 0, fired: [], skipped: 0, error: "sweep failed" });
    }
  }
  return Response.json({
    workspaces: results.length,
    fired: results.reduce((n, r) => n + r.fired.length, 0),
    results,
  });
}
