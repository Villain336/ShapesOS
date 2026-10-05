// ShapesOS Phase 10 (ops-core): shared session guard for the ticket routes.
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { OpsError } from "@/lib/ops/doctype";
import { errorResponse } from "@/lib/api/errors";

export async function ticketGuard(min: "viewer" | "editor"): Promise<{ workspaceId: string; userId: string } | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, min))) {
    return Response.json({ error: `Forbidden: ${min} role required` }, { status: 403 });
  }
  return { workspaceId: workspace.id, userId: user.id };
}

export function ticketError(err: unknown): Response {
  if (err instanceof OpsError) return Response.json({ error: err.message }, { status: err.status });
  return errorResponse(err);
}
