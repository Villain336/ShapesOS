// Marketr — usage summary API (Phase C, W4).
// GET /api/usage/summary?workspaceId=&projectId=&periodStart=
//   → { used, included, purchased, remaining, byAction, byProject, periodStart, cap }
// Reads: admin+. Billing data is sensitive — viewers don't get the ledger.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requireWorkspaceAccess, workspaceIdFrom } from "@/lib/route-utils";
import { getUsageSummary, checkCap } from "@/lib/metering/service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;

  const params = req.nextUrl.searchParams;
  const projectId = params.get("projectId");
  const periodStart = params.get("periodStart");

  // T3: projectId must belong to the caller's workspace.
  if (projectId) {
    const proj = await prisma.project.findFirst({
      where: { id: projectId, workspaceId: access.workspaceId },
      select: { id: true, domain: true },
    });
    if (!proj) return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const [summary, cap] = await Promise.all([
    getUsageSummary({
      workspaceId: access.workspaceId,
      ...(projectId ? { projectId } : {}),
      ...(periodStart ? { periodStart } : {}),
    }),
    checkCap(access.workspaceId),
  ]);
  return Response.json({ ...summary, cap });
}
