// Marketr — Phase 17 slice 2: POST /api/ops/invoices/sweep-overdue.
// Runs the overdue sweep: sent invoices past their due date flip to overdue.
// Editor+ (it's a bulk mutation). The flip itself is a free write — overdue
// is not a money transition — so no approval is needed to run the sweep.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { markOverdueInvoices } from "@/lib/ops/invoices";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return Response.json({ error: "Forbidden: editor role required" }, { status: 403 });
  }
  try {
    const result = await withWorkspaceScope(workspace.id, (tx) =>
      markOverdueInvoices(tx, { workspaceId: workspace.id, userId: user.id }),
    );
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
