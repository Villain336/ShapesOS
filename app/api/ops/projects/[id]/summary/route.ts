// Marketr — Phase 17 slice 4: GET /api/ops/projects/[id]/summary.
// One call for the project detail UI: the project, computed milestone
// progress, time totals, and the customer display name. Viewer+.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  getProject,
  projectProgress,
  projectTimeTotals,
} from "@/lib/ops/projects";
import { resolveCustomerNames } from "@/lib/ops/invoices";
import { OpsError } from "@/lib/ops/doctype";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  try {
    const { id } = await params;
    const actor = { workspaceId: workspace.id, userId: user.id };
    const result = await withWorkspaceScope(workspace.id, async (tx) => {
      const project = await getProject(tx, actor, id);
      const progress = projectProgress(project.milestones);
      const totals = await projectTimeTotals(tx, actor, id);
      const [customer] = await resolveCustomerNames(
        tx,
        actor.workspaceId,
        project.customerId ? [project.customerId] : [],
      );
      return { project, progress, totals, customer: customer ?? null };
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof OpsError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return errorResponse(err);
  }
}
