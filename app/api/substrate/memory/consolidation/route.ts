// Marketr — /api/substrate/memory/consolidation (Phase 8 G3).
// GET: consolidation status (last run, recent runs, queue depth, worker identity).
// POST (editor): trigger one async consolidation pass. Returns 202 immediately
// with the run id; the pass runs detached via after(). Never on the read path.

import type { NextRequest } from "next/server";
import { after } from "next/server";
import { memoryGuard, memoryAudit } from "../_lib";
import {
  startConsolidationRun,
  executeConsolidationRun,
  consolidationStatus,
  getWorkerIdentity,
} from "@/lib/substrate/memory/consolidate";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await memoryGuard(req, "viewer");
  if (gate instanceof Response) return gate;
  const status = await consolidationStatus(gate.workspaceId);
  return Response.json(status);
}

export async function POST(req: NextRequest) {
  const gate = await memoryGuard(req, "editor");
  if (gate instanceof Response) return gate;
  const runId = await startConsolidationRun(gate.workspaceId);
  const { workspaceId, userId } = gate;
  after(() =>
    executeConsolidationRun(workspaceId, runId).catch((err: unknown) => {
      console.error(`[memory-consolidation] run ${runId} failed:`, err);
    }),
  );
  memoryAudit().log(workspaceId, userId, "consolidation.triggered", runId, {
    worker: getWorkerIdentity(),
  });
  return Response.json({ runId, status: "running" }, { status: 202 });
}
