// Marketr — Phase 17 slice 4: PATCH /api/ops/projects/[id]/milestones/[index].
// Complete or reopen one milestone: { status: "done" | "open" }. Editor+.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { setMilestoneStatus } from "@/lib/ops/projects";
import { OpsError } from "@/lib/ops/doctype";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; index: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return Response.json({ error: "Forbidden: editor role required" }, { status: 403 });
  }
  try {
    const { id, index } = await params;
    const body = (await req.json().catch(() => ({}))) as { status?: unknown };
    const status = body.status === "done" ? "done" : body.status === "open" ? "open" : null;
    if (!status) throw new OpsError(400, 'status must be "done" or "open"');
    const actor = { workspaceId: workspace.id, userId: user.id };
    const result = await withWorkspaceScope(workspace.id, (tx) =>
      setMilestoneStatus(tx, actor, id, Number(index), status),
    );
    return Response.json({ project: result.project, progress: result.progress });
  } catch (err) {
    if (err instanceof OpsError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
