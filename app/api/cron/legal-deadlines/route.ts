// Marketr — legal deadline escalation sweep (Legal slice 2).
// POST /api/cron/legal-deadlines
//
// Auth (shared cron gate, lib/cron/gate.ts):
//   1. Signed-in session — sweeps the user's workspace (editor+).
//   2. Cron: Authorization: Bearer <CRON_SECRET> — sweeps every workspace
//      with a legal profile. Schedule daily so the 90/30/7/overdue tiers
//      fire on time.
//
// Each deadline emits at most once per escalation tier (recorded on the
// deadline row); alert delivery itself goes through the alert hub, so the
// tenant's own rules (Slack, Telegram, email, digest, quiet hours) apply.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { emitAlert } from "@/lib/alerts/evaluate";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { sweepLegalDeadlineAlerts } from "@/lib/legal/deadline-sweep";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const store = new PrismaLegalStore(prisma);
  const workspaceIds = isCron
    ? (
        await prisma.legalProfile.findMany({
          select: { workspaceId: true },
        })
      ).map((p) => p.workspaceId)
    : [sessionWorkspaceId!];

  const now = new Date();
  const results = [];
  for (const workspaceId of workspaceIds) {
    try {
      results.push(
        await sweepLegalDeadlineAlerts(store, emitAlert, workspaceId, { now }),
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
