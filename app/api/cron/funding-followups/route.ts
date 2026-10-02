// Marketr — Funding/VC slice 2: follow-up reminder sweep cron.
// POST /api/cron/funding-followups
//
// Auth (shared cron gate, lib/cron/gate.ts):
//   1. Signed-in session — sweeps the user's workspace (editor+).
//   2. Cron: Authorization: Bearer <CRON_SECRET> — sweeps every workspace
//      with open follow-ups. Schedule daily so the upcoming → due-today →
//      overdue tiers fire on time.
//
// Each follow-up emits at most once per tier (recorded on lastAlertedTier).
// Alert delivery goes through the alert hub, so the tenant's own rules
// (Slack, Telegram, email, digest, quiet hours) apply.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { emitAlert } from "@/lib/alerts/evaluate";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { sweepFundingFollowUpAlerts } from "@/lib/funding/followup-sweep";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const store = new PrismaFundingStore(prisma);
  const workspaceIds = isCron
    ? (
        await prisma.fundingFollowUp.findMany({
          where: { done: false },
          select: { workspaceId: true },
          distinct: ["workspaceId"],
        })
      ).map((f) => f.workspaceId)
    : [sessionWorkspaceId!];

  const now = new Date();
  const results = [];
  for (const workspaceId of workspaceIds) {
    try {
      results.push(
        await sweepFundingFollowUpAlerts(store, emitAlert, workspaceId, { now }),
      );
    } catch (err) {
      results.push({
        workspaceId,
        checked: 0,
        emitted: 0,
        skipped: 0,
        fired: [],
        error: err instanceof Error ? err.message.slice(0, 200) : "sweep failed",
      });
    }
  }
  return Response.json({ ranAt: now.toISOString(), results });
}
