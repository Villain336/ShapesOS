// Marketr — automation canvas API: workflows collection.
// GET  /api/workflows?projectId=   list (viewer+)
// POST /api/workflows               { projectId, name, description? } (editor+)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { isError, requireWorkflowProject } from "@/lib/workflow/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  const access = await requireWorkflowProject(user.id, projectId, "viewer");
  if (isError(access)) return access.error;

  const workflows = await prisma.workflow.findMany({
    where: { projectId: access.project.id },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { nodes: true, runs: true } },
      runs: { orderBy: { startedAt: "desc" }, take: 1, select: { id: true, status: true, startedAt: true, finishedAt: true } },
    },
  });
  return Response.json({ workflows });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { projectId?: string; name?: string; description?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const access = await requireWorkflowProject(user.id, body.projectId ?? "", "editor");
  if (isError(access)) return access.error;

  const name = (body.name ?? "").trim();
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  const workflow = await prisma.workflow.create({
    data: {
      projectId: access.project.id,
      name: name.slice(0, 120),
      description: (body.description ?? "").trim().slice(0, 500) || null,
      status: "draft",
      enabled: true,
      createdBy: user.id,
    },
  });
  await prisma.fileChangeLog.create({
    data: {
      workspaceId: access.project.workspaceId,
      projectId: access.project.id,
      connectionId: null,
      filePath: "",
      actor: "user",
      action: "save",
      summary: `Workflow created: "${workflow.name}"`.slice(0, 280),
    },
  });
  return Response.json({ workflow }, { status: 201 });
}
