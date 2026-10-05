// ShapesOS Phase 10 (ops-core): GET /api/ops/people
// Workspace members who can be assigned ops work (tasks, deals, tickets,
// timesheets): { people: [{ userId, name, email, role }] }. Viewer+.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listWorkspacePeople } from "@/lib/ops/people";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const people = await withWorkspaceScope(workspace.id, (tx) => listWorkspacePeople(tx, workspace.id));
    return Response.json({ people, me: user.id });
  } catch (err) {
    return errorResponse(err);
  }
}
