// Marketr — nightly agent-learning consolidation (Phase 13B "sleep").
// POST /api/cron/learning-consolidate
//
// Auth (shared cron gate, lib/cron/gate.ts), same pattern as the other
// /api/cron/* routes:
//   1. Signed-in session (editor+) — runs the pass for the user's workspace.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — runs every workspace,
//      bounded by LEARNING_CONSOLIDATE_MAX_WORKSPACES (default 50) for the
//      cost guard. Schedule nightly (see DEPLOY.md).
//
// Each workspace runs the extended consolidation job
// (startConsolidationRun → executeConsolidationRun), whose step 5 is the
// LLM learning pass. The pass itself is self-guarding: skipped when
// learning is paused, when it already ran tonight, or when no LLM provider
// is live — so a manual trigger never double-writes or burns budget.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import {
  startConsolidationRun,
  executeConsolidationRun,
} from "@/lib/substrate/memory/consolidate";
import { maxWorkspacesPerRun } from "@/lib/substrate/memory/learning-pass";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Shared cron gate (lib/cron/gate.ts) — CRON_SECRET service call, or
  // signed-in session with editor+ on the user's workspace.
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const cap = maxWorkspacesPerRun();

  // CRON_SECRET path: every workspace with recent agent_call activity first
  // (the pass has material to chew on), then the rest — hard-capped.
  const workspaces = isCron
    ? await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT w."id" FROM "workspaces" w
        ORDER BY (
          SELECT MAX(e."started_at") FROM "memory_episodes" e
          WHERE e."workspace_id" = w."id" AND e."episode_type" = 'agent_call'
        ) DESC NULLS LAST
        LIMIT ${cap}`
    : [{ id: sessionWorkspaceId! }];

  const results: Array<{
    workspaceId: string;
    ok: boolean;
    learningStatus?: string;
    learningsExtracted?: number;
    error?: string;
  }> = [];

  for (const ws of workspaces) {
    try {
      const runId = await startConsolidationRun(ws.id);
      const report = await executeConsolidationRun(ws.id, runId);
      results.push({
        workspaceId: ws.id,
        ok: report.errors.length === 0,
        learningStatus: report.learning?.status ?? "not-run",
        learningsExtracted: report.learning?.learningsExtracted ?? 0,
        error:
          report.errors.length > 0
            ? report.errors.slice(0, 3).join("; ").slice(0, 300)
            : undefined,
      });
    } catch (err) {
      results.push({
        workspaceId: ws.id,
        ok: false,
        error: err instanceof Error ? err.message.slice(0, 200) : "consolidation failed",
      });
    }
  }

  return Response.json({
    ok: results.every((r) => r.ok),
    workspaces: results.length,
    cap,
    results,
  });
}
