// Marketr — skill run detail API (Phase B, W2).
// GET /api/scheduler/runs/[runId]?workspaceId=
//   → { run, subagents, report } — timeline, subagent breakdown, cost,
//     firing event payload, and the stored report (viewer+).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, notFound, requireWorkspaceAccess } from "@/lib/route-utils";
import { getOutputStoreAsync } from "@/lib/scheduler/outputStore";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ runId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await params;
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;

  const run = await prisma.skillRun.findFirst({
    where: { id: runId, workspaceId: access.workspaceId },
    include: {
      skill: { select: { id: true, name: true, slug: true } },
      schedule: { select: { id: true, triggerType: true, cronExpr: true, eventSource: true, approvalMode: true } },
      subagents: { orderBy: { startedAt: "asc" } },
    },
  });
  if (!run) return notFound("Run not found");

  let report: string | null = null;
  if (run.outputPath) {
    report = await (await getOutputStoreAsync()).readReport(access.workspaceId, run.outputPath);
  }
  return Response.json({ run, subagents: run.subagents, report });
}
