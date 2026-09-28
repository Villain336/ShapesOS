// Marketr — AI chat messages API (redesign §3a).
// POST /api/chat/threads/[id]/messages  { content } → runs the agent loop
//   → { message, toolCalls, threadTitle }
// Editor+ (safe read tools run for anyone who can post; write tools are
// role-gated per tool and held behind the confirmation gate).

import { accessibleWorkspaceWhere, getMembership, requireProjectRole, forbidden } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { validateBody, z, boundedString } from "@/lib/api/validate";
import { runAgentTurnWithCapture, maybeAutoTitle, type ChatToolCall } from "@/lib/chat/agent";

export const dynamic = "force-dynamic";

const MAX_CONTENT = 4000;

const BodySchema = z.object({
  content: boundedString(MAX_CONTENT, "content"),
  attachmentIds: z.array(boundedString(120, "attachmentId")).max(10).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const v = validateBody(BodySchema, rawBody);
  if (!v.ok) return v.error;
  const content = v.data.content;
  const attachmentIds = v.data.attachmentIds;

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
    // Phase 13B: the capture wrapper records one agent_call episode per turn
    // (fail-soft — capture never breaks the turn).
    turn = await runAgentTurnWithCapture({
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
