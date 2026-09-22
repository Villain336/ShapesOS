// Marketr — automation canvas API: run history.
// GET /api/workflows/runs?projectId=&workflowId?   (viewer+)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { isError, requireWorkflowProject } from "@/lib/workflow/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const qs = new URL(req.url).searchParams;
  const projectId = qs.get("projectId") ?? "";
  const workflowId = qs.get("workflowId") ?? undefined;
  const access = await requireWorkflowProject(user.id, projectId, "viewer");
  if (isError(access)) return access.error;

  if (workflowId) {
    const wf = await prisma.workflow.findFirst({
      where: { id: workflowId, projectId: access.project.id },
      select: { id: true },
    });
    if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });
  }

  const runs = await prisma.workflowRun.findMany({
    where: { projectId: access.project.id, ...(workflowId ? { workflowId } : {}) },
    orderBy: { startedAt: "desc" },
    take: 50,
    include: {
      workflow: { select: { id: true, name: true } },
      _count: { select: { steps: true } },
    },
  });
  return Response.json({ runs });
}
