// Marketr — AI chat messages API (redesign §3a).
// POST /api/chat/threads/[id]/messages  { content } → runs the agent loop
//   → { message, toolCalls, threadTitle }
// Editor+ (safe read tools run for anyone who can post; write tools are
// role-gated per tool and held behind the confirmation gate).

import { accessibleWorkspaceWhere, getMembership, requireProjectRole, forbidden } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { runAgentTurn, maybeAutoTitle, type ChatToolCall } from "@/lib/chat/agent";

export const dynamic = "force-dynamic";

const MAX_CONTENT = 4000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let body: { content?: string; attachmentIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const content = String(body.content ?? "").trim();
  if (!content) return Response.json({ error: "content is required" }, { status: 400 });
  if (content.length > MAX_CONTENT) {
    return Response.json({ error: `content is too long (max ${MAX_CONTENT} characters)` }, { status: 400 });
  }
  const attachmentIds = Array.isArray(body.attachmentIds)
    ? body.attachmentIds.filter((a): a is string => typeof a === "string" && a.length > 0).slice(0, 10)
    : undefined;

  const thread = await prisma.aiChatThread.findFirst({
    where: { id, userId: user.id },
    include: { project: { select: { id: true, workspaceId: true } } },
  });
  if (!thread) return Response.json({ error: "Thread not found" }, { status: 404 });
  if (attachmentIds?.length) {
    const owned = await prisma.fileAttachment.count({
      where: { id: { in: attachmentIds }, projectId: thread.projectId },
    });
    if (owned !== attachmentIds.length) {
      return Response.json({ error: "One or more attachments do not belong to this project" }, { status: 400 });
    }
  }
  const accessible = await prisma.project.findFirst({
    where: { id: thread.projectId, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true },
  });
  if (!accessible) return Response.json({ error: "Thread not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, thread.projectId, "editor"))) return forbidden();

  const membership = await getMembership(user.id, thread.project.workspaceId);
  if (!membership) return forbidden();

  // Persist the user turn first.
  await prisma.aiChatMessage.create({
    data: { threadId: thread.id, role: "user", content },
  });

  let turn: { assistantText: string; toolCalls: ChatToolCall[] };
  try {
    turn = await runAgentTurn({
      projectId: thread.projectId,
      workspaceId: thread.project.workspaceId,
      userId: user.id,
      role: membership.role,
      threadId: thread.id,
      userContent: content,
      attachmentIds,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Agent turn failed";
    return Response.json({ error: msg }, { status: 500 });
  }

  const threadTitle = await maybeAutoTitle(thread.id, content);

  // Return the freshly saved assistant message so the UI can render it.
  const assistant = await prisma.aiChatMessage.findFirst({
    where: { threadId: thread.id, role: "assistant" },
    orderBy: { createdAt: "desc" },
    select: { id: true, content: true, toolCalls: true, createdAt: true },
  });

  return Response.json({
    message: assistant
      ? {
          id: assistant.id,
          role: "assistant",
          content: assistant.content,
          toolCalls: (assistant.toolCalls as unknown) ?? null,
          createdAt: assistant.createdAt.toISOString(),
        }
      : null,
    toolCalls: turn.toolCalls,
    threadTitle,
  });
}
