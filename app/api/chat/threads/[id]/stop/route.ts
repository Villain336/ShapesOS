// ShapesOS — Phase 5: Stop a chat task.
// POST /api/chat/threads/[id]/stop → { stopped: string[] }
//
// Stops whatever the thread's agent is doing right now (and the sub-agents it
// handed work to): the stop is recorded on the runs, an in-flight model call
// in this process is aborted, the thread's pending proposals are dropped (a
// later "yes" runs nothing) and the approvals the runs raised are expired.
// Idempotent: stopping an idle thread just drops any pending proposal.
// Threads are private to their owner, who must still be editor+ on the
// project (the same bar as sending a message).

import { accessibleWorkspaceWhere, forbidden, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { errorResponse } from "@/lib/api/errors";
import { stopThreadRuns } from "@/lib/chat/agent";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const thread = await prisma.aiChatThread.findFirst({
    where: { id, userId: user.id },
    include: { project: { select: { id: true, workspaceId: true } } },
  });
  if (!thread) return Response.json({ error: "Thread not found" }, { status: 404 });
  const accessible = await prisma.project.findFirst({
    where: { id: thread.projectId, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true },
  });
  if (!accessible) return Response.json({ error: "Thread not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, thread.projectId, "editor"))) return forbidden();

  try {
    const stopped = await stopThreadRuns({
      workspaceId: thread.project.workspaceId,
      threadId: thread.id,
      userId: user.id,
    });
    return Response.json({ stopped });
  } catch (err) {
    return errorResponse(err, "POST /api/chat/threads/[id]/stop");
  }
}
