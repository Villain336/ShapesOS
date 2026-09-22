// Marketr — automation canvas API: single run with per-node steps.
// GET /api/workflows/runs/[runId]   (viewer+)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { isError, requireWorkflowProject } from "@/lib/workflow/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await params;

  const run = await prisma.workflowRun.findUnique({
    where: { id: runId },
    include: {
      steps: { orderBy: { startedAt: "asc" } },
      workflow: { select: { id: true, name: true } },
    },
  });
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });

  const access = await requireWorkflowProject(user.id, run.projectId, "viewer");
  if (isError(access)) return access.error;

  return Response.json({ run });
}
