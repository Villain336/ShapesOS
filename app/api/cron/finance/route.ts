// ShapesOS — Phase 10 (finance): POST /api/cron/finance (daily).
//
// Auth (shared cron gate, lib/cron/gate.ts):
//   1. Signed-in session — sweeps the user's workspace (editor+).
//   2. Cron: Authorization: Bearer <CRON_SECRET> — sweeps every workspace.
//
// Per workspace, inside its RLS scope:
//   - recurring invoices: due schedules get DRAFT invoices (never sent —
//     sending still asks); idempotent per schedule + period;
//   - quotes past their validity flip sent → expired;
//   - sent invoices past due flip to overdue (the existing sweep).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { runFinanceSweep } from "@/lib/ops/finance/sweep";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;
  const workspaceIds = isCron
    ? (await prisma.workspace.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } })).map((w) => w.id)
    : [sessionWorkspaceId!];
  const now = new Date();
  const results = [];
  for (const workspaceId of workspaceIds) {
    try {
      results.push(await runFinanceSweep(workspaceId, now));
    } catch (err) {
      results.push({ workspaceId, error: err instanceof Error ? err.message.slice(0, 200) : "sweep failed" });
    }
  }
  const drafted = results.reduce((s, r) => s + ("drafted" in r ? r.drafted : 0), 0);
  return Response.json({ ok: true, workspaces: workspaceIds.length, drafted, results: results.filter((r) => !("drafted" in r) || r.drafted || r.expiredQuotes || r.overdue) });
}
