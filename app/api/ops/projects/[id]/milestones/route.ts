// Marketr — Phase 17 slice 4: POST /api/ops/projects/[id]/milestones.
// Append a milestone to the project's milestones JSON. Editor+.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { addMilestone } from "@/lib/ops/projects";
import { OpsError } from "@/lib/ops/doctype";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return Response.json({ error: "Forbidden: editor role required" }, { status: 403 });
  }
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      title?: unknown;
      dueAt?: unknown;
    };
    const actor = { workspaceId: workspace.id, userId: user.id };
    const result = await withWorkspaceScope(workspace.id, (tx) =>
      addMilestone(tx, actor, id, {
        title: typeof body.title === "string" ? body.title : "",
        dueAt: typeof body.dueAt === "string" ? body.dueAt : undefined,
      }),
    );
    return Response.json({ project: result.project, progress: result.progress });
  } catch (err) {
    if (err instanceof OpsError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return errorResponse(err);
  }
}
