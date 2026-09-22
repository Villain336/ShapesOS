// Marketr — AI chat threads API (redesign §3a).
// GET  /api/chat/threads?projectId=… → { threads } (own threads, newest first)
// POST /api/chat/threads { projectId } → { thread } (201)

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return Response.json({ error: "projectId is required" }, { status: 400 });
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true },
  });
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) return forbidden();

  const threads = await prisma.aiChatThread.findMany({
    where: { projectId: project.id, userId: user.id },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
  return Response.json({
    threads: threads.map((t) => ({
      id: t.id,
      title: t.title,
      messageCount: t._count.messages,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { projectId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const project = await prisma.project.findFirst({
    where: { id: body.projectId ?? "", workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true },
  });
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) return forbidden();

  const thread = await prisma.aiChatThread.create({
    data: { projectId: project.id, userId: user.id, title: "New chat" },
  });
  return Response.json(
    {
      thread: {
        id: thread.id,
        title: thread.title,
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
      },
    },
    { status: 201 },
  );
}
