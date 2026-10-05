// Marketr — Phase 17 slice 5: POST /api/ops/leave-requests/members.
// Resolve leave-request memberIds to display names for the UI.
// Viewer+. Mirrors the slice-2 invoices/customers endpoint.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { resolveMemberNames } from "@/lib/ops/hr";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  // Read-only name lookup, but membership is still checked explicitly.
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer")))
    return Response.json({ error: "Forbidden" }, { status: 403 });
  try {
    const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x): x is string => typeof x === "string")
      : [];
    const members = await withWorkspaceScope(workspace.id, (tx) =>
      resolveMemberNames(tx, workspace.id, ids),
    );
    return Response.json({ members });
  } catch (err) {
    return errorResponse(err);
  }
}
