// Marketr — Phase 17 slice 4: POST /api/ops/projects/[id]/complete.
// Transition the project to completed and return the unbilled-time nudge
// (info only — completing with unbilled time is NOT gated; the nudge is a
// reminder to invoice or mark billed, not a block). Editor+.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { completeProject } from "@/lib/ops/projects";
import { OpsError } from "@/lib/ops/doctype";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return Response.json({ error: "Forbidden: editor role required" }, { status: 403 });
  }
  try {
    const { id } = await params;
    const actor = { workspaceId: workspace.id, userId: user.id };
    const result = await withWorkspaceScope(workspace.id, (tx) => completeProject(tx, actor, id));
    return Response.json({
      project: result.project,
      unbilledMinutes: result.unbilledMinutes,
      nudge: result.nudge,
    });
  } catch (err) {
    if (err instanceof OpsError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
