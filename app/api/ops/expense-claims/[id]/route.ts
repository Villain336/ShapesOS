// ShapesOS — Phase 10 (finance): GET /api/ops/expense-claims/[id] — one
// claim with its lines (receipts are WorkspaceFile ids). Viewer+.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getExpenseClaim } from "@/lib/ops/finance/expenses";
import { financeError, financeGuard } from "@/lib/ops/finance/http";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await financeGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const { id } = await params;
    return Response.json({ claim: await withWorkspaceScope(actor.workspaceId, (tx) => getExpenseClaim(tx, actor.workspaceId, id)) });
  } catch (err) {
    return financeError(err);
  }
}
