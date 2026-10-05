// ShapesOS — Phase 5: Stop an agent run.
// POST /api/agent-runs/[runId]/cancel → { stopped: string[] }
//
// Records the stop on the run and every sub-agent run under it, aborts any
// in-flight model call in this process, and — for a chat run — drops the
// thread's pending proposals and expires the approvals the runs raised.
// Idempotent: a finished run answers { stopped: [] }.
//
// Access (fail-closed): signed in; the run must be visible in the caller's
// workspace (RLS-scoped read, foreign ids answer 404); the caller must be
// editor+ in the workspace or the person who started the run.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { getAgentRun, requestAgentRunCancel } from "@/lib/agents/runs/service";
import { abortRun } from "@/lib/agents/runs/abort";
import { stopThreadRuns } from "@/lib/chat/agent";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await params;
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const run = await getAgentRun(workspace.id, runId);
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  const isStarter = run.startedBy === user.id;
  if (!isStarter && !(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  try {
    if (run.threadId) {
      const stopped = await stopThreadRuns({
        workspaceId: workspace.id,
        threadId: run.threadId,
        userId: user.id,
        runId: run.id,
      });
      return Response.json({ stopped });
    }
    const res = await requestAgentRunCancel(workspace.id, run.id, user.id);
    const stopped = res?.runIds ?? [];
    for (const id of stopped) abortRun(id);
    return Response.json({ stopped });
  } catch (err) {
    return errorResponse(err, "POST /api/agent-runs/[runId]/cancel");
  }
}
