// Marketr — automation canvas cron sweep.
// POST /api/cron/workflows
//
// Auth: cronGate (CRON_SECRET bearer, or signed-in session with editor+ on
// the user's workspace — same pattern as /api/cron/decay).
//
// 1. Fires schedule triggers whose cron is due: workflows with a `schedule`
//    expression, plus schedule nodes carrying their own config.cron.
//    A schedule fires at most once per minute (workflow.lastRunAt guard).
// 2. Reports runs currently waiting at approval gates (they resume on
//    approve/reject via the autopilot hooks — nothing to execute here).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { cronDue, startOfCurrentMinute } from "@/lib/workflow/cron";
import { executeQueuedRun, startWorkflowRun } from "@/lib/workflow/engine";

export const dynamic = "force-dynamic";

interface FireResult {
  workflowId: string;
  name: string;
  runId?: string;
  deduped?: boolean;
  error?: string;
}

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const projects = await prisma.project.findMany({
    where: isCron ? {} : { workspaceId: sessionWorkspaceId! },
    select: { id: true, workspaceId: true, domain: true },
  });

  const minuteStart = startOfCurrentMinute();
  const fired: FireResult[] = [];
  let waitingRuns = 0;

  for (const p of projects) {
    const workflows = await prisma.workflow.findMany({
      where: { projectId: p.id, enabled: true, status: "active" },
      include: { nodes: true },
    });
    for (const w of workflows) {
      // Collect due schedule sources: the workflow-level schedule plus any
      // schedule nodes with their own cron. Dedupe via the engine's 5-min
      // window + the lastRunAt guard below.
      const dueSources: Array<{ kind: string; triggerNodeId?: string }> = [];
      if (w.schedule) {
        try {
          if (cronDue(w.schedule)) dueSources.push({ kind: "schedule" });
        } catch {
          // Invalid cron is a save-time error; ignore defensively here.
        }
      }
      for (const n of w.nodes) {
        if (n.kind === "trigger" && n.type === "schedule") {
          const cron = ((n.config ?? {}) as Record<string, unknown>).cron;
          try {
            if (typeof cron === "string" && cronDue(cron)) {
              dueSources.push({ kind: "schedule", triggerNodeId: n.id });
            }
          } catch {
            /* ignore invalid cron */
          }
        }
      }
      if (dueSources.length === 0) continue;
      // At most one fire per minute per workflow.
      if (w.lastRunAt && w.lastRunAt >= minuteStart) continue;

      const src = dueSources[0];
      try {
        const { run, deduped } = await startWorkflowRun({
          workspaceId: p.workspaceId,
          projectId: p.id,
          workflowId: w.id,
          triggerKind: src.kind,
          createdBy: "cron",
          actorUserId: null,
          triggerNodeId: src.triggerNodeId,
        });
        fired.push({ workflowId: w.id, name: w.name, runId: run.id, deduped });
      } catch (err) {
        fired.push({
          workflowId: w.id,
          name: w.name,
          error: err instanceof Error ? err.message.slice(0, 200) : "schedule run failed",
        });
      }
    }

    waitingRuns += await prisma.workflowRun.count({
      where: { projectId: p.id, status: "waiting_approval" },
    });

    // Pick up externally-created queued runs (e.g. AI chat run_workflow).
    // Only runs older than 30s, so we never race a creator still working.
    const queued = await prisma.workflowRun.findMany({
      where: {
        projectId: p.id,
        status: "queued",
        startedAt: { lt: new Date(Date.now() - 30_000) },
      },
      select: { id: true, createdBy: true },
    });
    for (const q of queued) {
      try {
        await executeQueuedRun({ runId: q.id, workspaceId: p.workspaceId, actor: q.createdBy ?? "cron" });
        fired.push({ workflowId: "", name: `queued run ${q.id}`, runId: q.id });
      } catch (err) {
        fired.push({
          workflowId: "",
          name: `queued run ${q.id}`,
          error: err instanceof Error ? err.message.slice(0, 200) : "queued run failed",
        });
      }
    }
  }

  return Response.json({ ok: true, fired, waitingRuns });
}
