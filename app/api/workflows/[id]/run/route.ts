// Marketr — automation canvas API: manual run.
// POST /api/workflows/[id]/run   { idempotencyKey?, triggerNodeId? } (editor+)
//
// Executes inline and returns the finished run (or the waiting run when
// paused at an approval gate). Dedupe: an already queued/running/waiting
// run from the last 5 minutes is returned instead of duplicated.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { isError, requireWorkflow } from "@/lib/workflow/http";
import { startWorkflowRun, WorkflowKilledError } from "@/lib/workflow/engine";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireWorkflow(user.id, id, "editor");
  if (isError(access)) return access.error;

  let body: { idempotencyKey?: string; triggerNodeId?: string };
  try {
    body = await req.json().catch(() => ({}));
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const { run, deduped } = await startWorkflowRun({
      workspaceId: access.project.workspaceId,
      projectId: access.project.id,
      workflowId: access.workflow.id,
      triggerKind: "manual",
      createdBy: user.id,
      actorUserId: user.id,
      triggerNodeId: body.triggerNodeId,
    });
    const full = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { steps: { orderBy: { startedAt: "asc" } } },
    });
    return Response.json({ run: full, deduped }, { status: deduped ? 200 : 201 });
  } catch (err) {
    if (err instanceof WorkflowKilledError) {
      return Response.json({ error: err.message }, { status: 423 });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Run failed" }, { status: 400 });
  }
}
