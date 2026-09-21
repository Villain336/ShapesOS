// Marketr — AI search visibility API (milestone 14).
// GET /api/ai-visibility?projectId=… → presence %, citation rate, trend, per-keyword latest.
// RBAC: viewer+ read.

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { aiVisibilitySummary } from "@/lib/retention/ai-visibility";

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

  const days = Math.min(90, Math.max(7, Number(req.nextUrl.searchParams.get("days") ?? 30) || 30));
  const summary = await aiVisibilitySummary(project.id, days);
  return Response.json({ projectId: project.id, ...summary });
}
