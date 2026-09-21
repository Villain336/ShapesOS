// Marketr — visibility score API (milestone 14).
// GET /api/visibility-score?projectId=… → latest score + 90-day trend + component breakdown.
// RBAC: viewer+ read.

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const projectId = req.nextUrl.searchParams.get("projectId");
  const project = await prisma.project.findFirst({
    where: { id: projectId ?? "", workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true },
  });
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) return forbidden();

  const scores = await prisma.visibilityScore.findMany({
    where: { projectId: project.id },
    orderBy: { date: "desc" },
    take: 90,
  });

  const latest = scores[0] ?? null;
  return Response.json({
    projectId: project.id,
    latest: latest
      ? {
          date: latest.date.toISOString().slice(0, 10),
          score: latest.score,
          components: latest.components,
        }
      : null,
    trend: scores
      .slice()
      .reverse()
      .map((s) => ({ date: s.date.toISOString().slice(0, 10), score: s.score })),
  });
}
