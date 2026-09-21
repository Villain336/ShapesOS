// Marketr — saved keywords for a project.
// GET /api/keywords/saved?projectId=… → { keywords } grouped by list.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const projectId = req.nextUrl.searchParams.get("projectId");
  const project = await prisma.project.findFirst({
    where: { id: projectId ?? undefined, workspace: { ownerUserId: user.id } },
  });
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const keywords = await prisma.keyword.findMany({
    where: { projectId: project.id },
    orderBy: [{ list: "asc" }, { volume: "desc" }],
  });

  return Response.json({ keywords });
}
