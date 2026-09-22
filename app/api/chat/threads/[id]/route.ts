// Marketr — AI chat thread API (redesign §3a).
// GET    /api/chat/threads/[id] → { thread, messages }
// DELETE /api/chat/threads/[id] → { ok: true }
// Threads are private to the user who created them; project access is viewer+.

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

async function ownedThread(userId: string, threadId: string) {
  const thread = await prisma.aiChatThread.findFirst({
    where: { id: threadId, userId },
    select: { id: true, title: true, projectId: true, createdAt: true, updatedAt: true },
  });
  if (!thread) return null;
  const project = await prisma.project.findFirst({
    where: { id: thread.projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true },
  });
  if (!project) return null;
  if (!(await requireProjectRole(userId, project.id, "viewer"))) return null;
  return thread;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const thread = await ownedThread(user.id, id);
  if (!thread) return Response.json({ error: "Thread not found" }, { status: 404 });

  const messages = await prisma.aiChatMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, content: true, toolCalls: true, createdAt: true },
  });
  return Response.json({
    thread: {
      id: thread.id,
      title: thread.title,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolCalls: (m.toolCalls as unknown) ?? null,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const thread = await ownedThread(user.id, id);
  if (!thread) return Response.json({ error: "Thread not found" }, { status: 404 });

  await prisma.aiChatThread.delete({ where: { id: thread.id } });
  return Response.json({ ok: true });
}
