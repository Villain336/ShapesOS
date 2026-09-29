// Marketr — Phase 16 slice 1: AG-UI chat streaming API.
// POST /api/agents/chat  { threadId, content, attachmentIds? }
//   → text/event-stream of AG-UI protocol events (RUN_STARTED → tool calls
//     → TEXT_MESSAGE_* → RUN_FINISHED | RUN_ERROR).
//
// Auth/project-guard semantics match the JSON chat route
// (app/api/chat/threads/[id]/messages): the thread must belong to the
// caller, the project must be workspace-accessible, and the caller needs
// the editor role. The turn itself runs through runAgentTurnWithCapture via
// the adapter — the agent is not duplicated here.

import { accessibleWorkspaceWhere, getMembership, requireProjectRole, forbidden } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { validateBody, z, boundedString } from "@/lib/api/validate";
import { streamChatTurnAgui, aguiStreamResponse } from "@/lib/agents/agui/adapter";
import { maybeAutoTitle } from "@/lib/chat/agent";

export const dynamic = "force-dynamic";

const MAX_CONTENT = 4000;

const BodySchema = z.object({
  threadId: boundedString(120, "threadId"),
  content: boundedString(MAX_CONTENT, "content"),
  attachmentIds: z.array(boundedString(120, "attachmentId")).max(10).optional(),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const v = validateBody(BodySchema, rawBody);
  if (!v.ok) return v.error;
  const { threadId, content, attachmentIds } = v.data;

  const thread = await prisma.aiChatThread.findFirst({
    where: { id: threadId, userId: user.id },
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

  // Persist the user turn first (same as the JSON route).
  await prisma.aiChatMessage.create({
    data: { threadId: thread.id, role: "user", content },
  });

  const events = streamChatTurnAgui({
    projectId: thread.projectId,
    workspaceId: thread.project.workspaceId,
    userId: user.id,
    role: membership.role,
    threadId: thread.id,
    userContent: content,
    attachmentIds,
  });

  // Title the thread once the stream completes (best-effort, non-blocking).
  const tracked = (async function* () {
    try {
      yield* events;
    } finally {
      void maybeAutoTitle(thread.id, content).catch(() => undefined);
    }
  })();

  return aguiStreamResponse(tracked);
}
