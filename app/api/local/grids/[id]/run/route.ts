// Marketr — run a geo-grid (milestone 16).
// POST /api/local/grids/[id]/run { action: "preview" } → cost preview (editor+).
// POST /api/local/grids/[id]/run { action: "run" } → execute the run (editor+).
// All spend flows through lib/local/service.ts (cost gate + audit).

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { previewGridRun, runLocalGrid } from "@/lib/local/service";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const grid = await prisma.localGrid.findFirst({
    where: { id, project: { workspace: accessibleWorkspaceWhere(user.id) } },
    include: { project: { select: { id: true } } },
  });
  if (!grid) return Response.json({ error: "Grid not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, grid.project.id, "editor"))) return forbidden();

  let body: { action?: string };
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const actor = `user:${user.id}`;
  if (body.action === "preview") {
    const preview = await previewGridRun(grid.id);
    if ("error" in preview) return Response.json({ error: preview.error }, { status: 404 });
    return Response.json({ preview });
  }
  if (body.action === "run") {
    const result = await runLocalGrid(grid.id, actor);
    if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ result });
  }
  return Response.json({ error: 'action must be "preview" or "run"' }, { status: 400 });
}
