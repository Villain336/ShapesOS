// Marketr — monthly storage over-quota metering (Phase C gaps, G1).
// POST /api/cron/storage-metering
//
// Auth (either), same pattern as the other /api/cron/* routes:
//   1. Signed-in session (editor+) — runs for the user's workspace only.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — runs for every workspace.
//      Schedule monthly (see DEPLOY.md): 0 2 1 * * *
//
// HONEST APPROXIMATION (T11): the charge is computed from the CURRENT
// usedBytes snapshot at cron time — NOT a time-weighted average of the
// month. A workspace that spikes over quota and cleans up before this runs
// is never charged; sustained over-quota usage is charged on the snapshot.
// Rule: per whole GB over quota, rounded UP, 1 credit per GB-month
// (credit table: storage_over_quota = 1). The copy in Settings → Usage must
// state the snapshot rule plainly.
//
// Idempotency: storagequota:<workspaceId>:<YYYY-MM> — exactly once per
// workspace per month; re-running the cron never double-charges.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { getQuota } from "@/lib/filesystem/service";
import { meter, type MeterResult } from "@/lib/metering/service";
import { gbOverQuota } from "@/lib/metering/wiring";

export const dynamic = "force-dynamic";

interface WorkspaceResult {
  workspaceId: string;
  gbOver: number;
  charged: number;
  blocked?: string;
  error?: string;
}

export async function POST(req: NextRequest) {
  // Day-1 hardening (M1): shared cron gate — CRON_SECRET service call, or
  // signed-in session with editor+ on the user's workspace.
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const workspaces = await prisma.workspace.findMany({
    where: isCron ? {} : { id: sessionWorkspaceId! },
    select: { id: true },
  });

  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const results: WorkspaceResult[] = [];

  for (const ws of workspaces) {
    let quota: { usedBytes: number; limitBytes: number };
    try {
      quota = await getQuota({ workspaceId: ws.id });
    } catch (err) {
      results.push({
        workspaceId: ws.id,
        gbOver: 0,
        charged: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const gb = gbOverQuota(quota.usedBytes, quota.limitBytes);
    if (gb <= 0) {
      results.push({ workspaceId: ws.id, gbOver: 0, charged: 0 });
      continue;
    }

    let res: MeterResult;
    try {
      res = await meter({
        workspaceId: ws.id,
        action: "storage_over_quota",
        credits: gb, // 1 credit per GB-month; override carries the GB count
        idempotencyKey: `storagequota:${ws.id}:${month}`,
        evidenceRef: `storage-quota:${month} (${gb} GB over)`,
      });
    } catch (err) {
      results.push({
        workspaceId: ws.id,
        gbOver: gb,
        charged: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    results.push({
      workspaceId: ws.id,
      gbOver: gb,
      charged: res.ok ? res.charged : 0,
      ...(res.ok ? {} : { blocked: res.reason }),
    });
  }

  return Response.json({ ok: true, month, results });
}
