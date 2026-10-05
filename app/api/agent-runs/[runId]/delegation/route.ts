// ShapesOS — Phase 16: a run's delegation plan (read-only).
// GET /api/agent-runs/[runId]/delegation → DelegationView (lib/aos/delegation.ts):
// the plan's tasks, their sub-agents, states, dependencies, budgets and
// deliverables. The chat's "Working with N sub-agents" card polls it; the run
// page streams the same view through GET …/watch?view=delegation.
//
// Access (fail-closed): signed in; the run must be visible in the caller's
// workspace (RLS-scoped read) — a foreign or unknown id answers 404.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { loadDelegationView } from "@/lib/agents/delegation/store";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await params;
  try {
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const view = await loadDelegationView(workspace.id, runId);
    if (!view) return Response.json({ error: "Run not found" }, { status: 404 });
    return Response.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/agent-runs/[runId]/delegation");
  }
}
