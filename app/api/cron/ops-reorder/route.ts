// ShapesOS Phase 10 (ops-core): POST /api/cron/ops-reorder
//
// Auth (shared cron gate, lib/cron/gate.ts): CRON_SECRET bearer sweeps every
// workspace that has an active reorder rule; a signed-in editor+ sweeps
// their own workspace ("Run reorder check now").
//
// For each active min/max rule whose warehouse on-hand ≤ min, drafts ONE
// purchase order for max − on-hand (lib/ops/stock.ts runReorderSweep). It
// only ever DRAFTS — sending a PO stays a gated money write — and a rule
// whose previous draft is still open never drafts again for the same breach.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { runReorderSweep, type ReorderSweepResult } from "@/lib/ops/stock";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const workspaceIds = gate.isCron
    ? (await prisma.workspace.findMany({ select: { id: true }, take: 10_000 })).map((w) => w.id)
    : [gate.workspaceId!];
  const results: Array<{ workspaceId: string } & (ReorderSweepResult | { error: string })> = [];
  for (const workspaceId of workspaceIds) {
    try {
      const r = await withWorkspaceScope(workspaceId, (tx) =>
        runReorderSweep(tx, { workspaceId, userId: gate.isCron ? "cron:ops-reorder" : gate.userId! }),
      );
      if (r.checked > 0) results.push({ workspaceId, ...r });
    } catch (err) {
      results.push({ workspaceId, error: err instanceof Error ? err.message.slice(0, 200) : "sweep failed" });
    }
  }
  const drafted = results.reduce((s, r) => s + ("drafted" in r ? r.drafted.length : 0), 0);
  return Response.json({ ok: true, workspaces: results.length, drafted, results });
}
