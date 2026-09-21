// Marketr — execute a backlink pull (milestone 15).
// POST /api/backlinks/pull { projectId, limit?, target? } (editor+).
// The UI must show the cost preview (POST /api/backlinks action=preview)
// and get explicit user confirmation before calling this. All cost
// enforcement also happens server-side in runBacklinkPull().

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { runBacklinkPull } from "@/lib/seo/backlink-pull";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { projectId?: string; limit?: number; target?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.projectId !== "string" || !body.projectId) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  const project = await prisma.project.findFirst({
    where: { id: body.projectId, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true, domain: true },
  });
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();

  const limit = Math.max(1, Math.min(100_000, Math.floor(body.limit ?? 500)));
  const result = await runBacklinkPull({
    workspaceId: project.workspaceId,
    projectId: project.id,
    target: body.target?.trim() || project.domain,
    limit,
    actor: "user",
  });
  return Response.json({ result });
}
