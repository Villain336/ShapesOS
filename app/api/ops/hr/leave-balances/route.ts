// ShapesOS Phase 10 (ops-core): GET /api/ops/hr/leave-balances
// Leave balances per active team member × active leave policy, computed
// from yearly accrual, the carry-over cap and the append-only leave ledger
// (lib/ops/leave.ts). Amounts are hundredths of a day. Viewer+.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { leaveBalances } from "@/lib/ops/leave";
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
    const members = await withWorkspaceScope(workspace.id, (tx) => leaveBalances(tx, workspace.id));
    return Response.json({ members, unit: "centidays" });
  } catch (err) {
    return errorResponse(err);
  }
}
