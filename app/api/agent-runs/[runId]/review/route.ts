// ShapesOS — Phase 8 (ship): decide on a run's diff from the Runs page.
// POST /api/agent-runs/[runId]/review
//   { action: "approve" }                 → the pending push / PR proposal runs
//                                           through the chat confirmation path
//   { action: "reject" }                  → Stop (the proposal is dropped)
//   { action: "changes", message: "…" }   → the note goes into the run's thread
//                                           and the agent continues from it
//   → { action, followUpRunId?, stopped?, reply? }
//
// Access (fail-closed): signed in; the run must be visible in the caller's
// workspace (RLS-scoped, foreign ids answer 404); editor+ in the workspace
// (reject also lets the person who started the run stop it, like cancel);
// approve / changes post into the chat thread, so it must be the caller's.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, getMembership, requireWorkspaceRole } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z, boundedString } from "@/lib/api/validate";
import { getAgentRun } from "@/lib/agents/runs/service";
import { ReviewError, reviewRun } from "@/lib/ship/review";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  action: z.enum(["approve", "reject", "changes"]),
  message: boundedString(4000, "message").optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const v = validateBody(BodySchema, raw);
  if (!v.ok) return v.error;

  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const run = await getAgentRun(workspace.id, runId);
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  const isEditor = await requireWorkspaceRole(user.id, workspace.id, "editor");
  const isStarter = run.startedBy === user.id;
  if (!isEditor && !(v.data.action === "reject" && isStarter)) return forbidden();
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) return forbidden();

  try {
    const out = await reviewRun({
      workspaceId: workspace.id,
      runId: run.id,
      userId: user.id,
      role: membership.role,
      action: v.data.action,
      message: v.data.message,
    });
    return Response.json(out);
  } catch (err) {
    if (err instanceof ReviewError) return Response.json({ error: err.message }, { status: err.status });
    return errorResponse(err, "POST /api/agent-runs/[runId]/review", req);
  }
}
