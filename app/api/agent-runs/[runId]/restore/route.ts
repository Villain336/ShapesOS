// ShapesOS — Phase 8: restore a run's code sandbox to a checkpoint.
// POST /api/agent-runs/[runId]/restore  { snapshotId } → { restored, snapshotId }
//
// Puts the sandbox workdir back exactly as the checkpoint saw it (files made
// since are gone). Only while the sandbox lives, and only for a checkpoint
// this run recorded from this sandbox (lib/sandbox/restore.ts).
//
// Access (fail-closed, same as Stop): signed in; the run must be visible in
// the caller's workspace (RLS-scoped read, foreign ids answer 404); the
// caller must be editor+ in the workspace or the person who started the run.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { getAgentRun } from "@/lib/agents/runs/service";
import { restoreRunCheckpoint } from "@/lib/sandbox/restore";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await params;
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const run = await getAgentRun(workspace.id, runId);
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  const isStarter = run.startedBy === user.id;
  if (!isStarter && !(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: { snapshotId?: unknown };
  try {
    body = (await req.json()) as { snapshotId?: unknown };
  } catch {
    return Response.json({ error: "Send JSON: { snapshotId }" }, { status: 400 });
  }
  try {
    const out = await restoreRunCheckpoint({ workspaceId: workspace.id, runId: run.id, snapshotId: body?.snapshotId, userId: user.id });
    if (!out.ok) return Response.json({ error: out.error }, { status: out.status });
    return Response.json({ restored: true, snapshotId: out.snapshotId });
  } catch (err) {
    return errorResponse(err, "POST /api/agent-runs/[runId]/restore");
  }
}
