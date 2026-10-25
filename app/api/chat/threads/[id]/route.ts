// Marketr — AI chat thread API (redesign §3a).
// GET    /api/chat/threads/[id] → { thread, messages }
//   Phase 5: thread carries agentKey, the effective tool grant and the id of
//   the run working right now (liveRunId), so the UI can offer Stop.
// DELETE /api/chat/threads/[id] → { ok: true }
// Threads are private to the user who created them; project access is viewer+.

// Phase 18.3 (WS=trust): agent app permissions.
import { getAgentBlockedGroups } from "@/lib/agents/app-permissions";
import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { computeGrant, isAgentKey } from "@/lib/agents/grants";
import { validateBody, z } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

async function ownedThread(userId: string, threadId: string) {
  const thread = await prisma.aiChatThread.findFirst({
    where: { id: threadId, userId },
    select: {
      id: true,
      title: true,
      projectId: true,
      createdAt: true,
      updatedAt: true,
      agentKey: true,
      allowedTools: true,
      mode: true,
      project: { select: { workspaceId: true } },
    },
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
  const agentKey = isAgentKey(thread.agentKey) ? thread.agentKey : "lead";
  const { listLiveThreadRuns } = await import("@/lib/agents/runs/service");
  const live = await listLiveThreadRuns(thread.project.workspaceId, thread.id).catch(() => []);
  return Response.json({
    thread: {
      id: thread.id,
      title: thread.title,
      agentKey,
      // Phase 22 (chat): the thread's conversation mode (ask / plan / auto).
      mode: thread.mode === "plan" || thread.mode === "auto" ? thread.mode : "ask",
      // Phase 18.3 (WS=trust): what the next turn will actually get.
      allowedTools: computeGrant({ agentKey, requested: thread.allowedTools, blockedGroups: await getAgentBlockedGroups(thread.project.workspaceId) }).groups,
      liveRunId: live.find((r) => !r.parentRunId)?.id ?? null,
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

// PATCH /api/chat/threads/[id]  { mode } → { ok, mode }
//   Phase 22 (chat): sets the thread's conversation mode (ask / plan / auto).
//   Plan mode is enforced server-side: the confirmation gate proposes every
//   non-safe tool and skips per-agent auto-approve rules (lib/chat/tool-exec.ts).
const PatchSchema = z.object({ mode: z.enum(["ask", "plan", "auto"]) });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const thread = await ownedThread(user.id, id);
  if (!thread) return Response.json({ error: "Thread not found" }, { status: 404 });

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const v = validateBody(PatchSchema, rawBody);
  if (!v.ok) return v.error;

  await prisma.aiChatThread.update({ where: { id: thread.id }, data: { mode: v.data.mode } });
  return Response.json({ ok: true, mode: v.data.mode });
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
